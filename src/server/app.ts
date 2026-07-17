import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z, type ZodError, type ZodType } from "zod";
import {
  ApiScanWarningSchema,
  EmptyRequestSchema,
  CopyExportCancelResponseSchema,
  CopyExportCommitRequestSchema,
  CopyExportJobResponseSchema,
  CopyExportPreparationProgressSchema,
  CopyExportPreviewTerminalSchema,
  CopyExportPreviewRequestSchema,
  CopyExportPreviewResponseSchema,
  CopyExportProgressSchema,
  CopyExportReportSchema,
  CopyExportTerminalSchema,
  MetadataExportCommitRequestSchema,
  MetadataExportCancelResponseSchema,
  MetadataExportJobResponseSchema,
  MetadataExportLatestResponseSchema,
  MetadataExportProgressSchema,
  MetadataExportPreviewRequestSchema,
  MetadataExportPreviewResponseSchema,
  MetadataExportResultSchema,
  MetadataExportRollbackRequestSchema,
  MetadataExportTerminalSchema,
  MergeGroupRequestSchema,
  OpenAlbumRequestSchema,
  PublicAlbumSessionSchema,
  PublicPhotoUnitSchema,
  RatePhotoRequestSchema,
  RatePhotosRequestSchema,
  RegroupRequestSchema,
  ScanProgressSchema,
  SplitGroupRequestSchema,
  ThumbnailQuerySchema,
  apiSuccess,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type ApiScanWarning,
  type ApiValidationField,
  type CopyExportPreview,
  type CopyExportPreparationProgress,
  type CopyExportProgress,
  type CopyExportReport,
  type MetadataExportCommitRequest,
  type MetadataExportLatest,
  type MetadataExportProgress,
  type MetadataExportPreview,
  type MetadataExportResult,
  type MetadataExportTerminal,
  type MetadataExportRollbackRequest,
  type PublicAlbumSession,
  type PublicPhotoUnit,
  type ScanProgressEvent,
} from "../shared/api.js";
import type {
  AlbumSession,
  PhotoUnit,
  Rating,
  SourceFile,
} from "../shared/domain.js";
import type { ImageAdapter } from "./adapters/image.js";
import {
  createFolderPicker,
  FolderPickerError,
  validateManualDirectory,
  type FolderPicker,
} from "./adapters/folder-picker.js";
import { createDemoAlbum, type DemoAlbum } from "./demo.js";
import {
  SessionDomainError,
  SessionService,
  type SessionPersistence,
} from "./session-service.js";
import type { RecentAlbumRecord } from "./recent-albums-store.js";

const MAX_PROGRESS_EVENTS = 512;
const DEFAULT_HEARTBEAT_MS = 15_000;
const COPY_JOB_RETENTION_MS = 10 * 60_000;

export interface SessionCommandService {
  snapshot(): AlbumSession;
  ratePhoto(photoId: string, rating: Rating): Promise<AlbumSession>;
  ratePhotos(photoIds: readonly string[], rating: Rating): Promise<AlbumSession>;
  split(photoId: string): Promise<AlbumSession>;
  merge(groupId: string): Promise<AlbumSession>;
  regroup(groupingSensitivity: number): Promise<AlbumSession>;
  undo(): Promise<AlbumSession>;
}

export interface LoadedAlbum {
  readonly session: AlbumSession;
  readonly persistence: SessionPersistence;
  readonly warnings?: readonly ApiScanWarning[];
}

export type AlbumLoader = (
  canonicalRoot: string,
  onProgress: (progress: ScanProgressEvent) => void,
  signal: AbortSignal,
) => Promise<LoadedAlbum>;

export interface ExportContext {
  readonly albumId: string;
  readonly isDemo: boolean;
  readonly sourceRoot: string;
  readonly session: AlbumSession;
}

export interface MetadataExportService {
  latest(context: ExportContext): Promise<MetadataExportLatest>;
  preview(context: ExportContext, request: Readonly<Record<string, never>>, operation?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: MetadataExportProgress) => void }): Promise<MetadataExportPreview>;
  commit(context: ExportContext, request: MetadataExportCommitRequest, operation?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: MetadataExportProgress) => void }): Promise<MetadataExportResult>;
  rollback(context: ExportContext, request: MetadataExportRollbackRequest): Promise<MetadataExportResult>;
}

export interface CopyExportService {
  preview(context: ExportContext, request: { readonly destinationRoot: string; readonly minRating: number }, operation?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: CopyExportPreparationProgress) => void }): Promise<Omit<CopyExportPreview, "destinationName">>;
  commit(context: ExportContext, request: { readonly confirmationId: string; readonly signal?: AbortSignal; readonly onProgress?: (progress: CopyExportProgress) => void }): Promise<CopyExportReport>;
  report(reportId: string): Promise<CopyExportReport>;
}

export interface CreateAppDependencies {
  readonly token: string;
  readonly sourceRoot?: string;
  readonly albumLoader?: AlbumLoader;
  readonly copyExport?: CopyExportService;
  readonly createSessionService?: (
    session: AlbumSession,
    persistence: SessionPersistence,
  ) => SessionCommandService;
  readonly demoAlbum?: () => DemoAlbum;
  readonly folderPicker?: FolderPicker;
  readonly heartbeatMs?: number;
  readonly imageAdapter?: Pick<ImageAdapter, "thumbnail">;
  readonly metadataExport?: MetadataExportService;
  readonly recentAlbums?: {
    list(): Promise<RecentAlbumRecord[]>;
    record(path: string): Promise<RecentAlbumRecord>;
    remove(id: string): Promise<void>;
    resolve(id: string): Promise<RecentAlbumRecord | undefined>;
    updateStats(id: string, photoCount: number, ratedCount: number): Promise<void>;
  };
  readonly sessionService?: SessionCommandService;
  readonly validateDirectory?: (path: string) => Promise<string>;
  readonly appDataRoot?: string;
}

export interface BurstPickApp extends Express {
  close(): Promise<void>;
  closeEventStreams(): void;
}

interface SseClient {
  readonly response: Response;
  readonly heartbeat: ReturnType<typeof setInterval>;
}

interface CopyJob {
  readonly id: string;
  readonly albumId: string;
  readonly controller: AbortController;
  readonly clients: Set<SseClient>;
  promise: Promise<void>;
  progress?: CopyExportProgress;
  terminal?: { status: "complete"; reportId: string; cancelled: boolean } | { status: "failed"; message: string };
  eviction?: ReturnType<typeof setTimeout>;
}

interface CopyPreviewJob {
  readonly id: string;
  readonly albumId: string;
  readonly controller: AbortController;
  readonly clients: Set<SseClient>;
  promise: Promise<void>;
  progress?: CopyExportPreparationProgress;
  terminal?: { status: "ready"; preview: CopyExportPreview } | { status: "cancelled" } | { status: "failed"; message: string };
  eviction?: ReturnType<typeof setTimeout>;
}

interface MetadataJob {
  readonly id: string;
  readonly albumId: string;
  readonly controller: AbortController;
  readonly clients: Set<SseClient>;
  promise: Promise<void>;
  progress?: MetadataExportProgress;
  terminal?: MetadataExportTerminal;
  eviction?: ReturnType<typeof setTimeout>;
}

interface SafeStoredError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly status: number;
}

interface ActiveAlbum {
  readonly id: string;
  readonly clients: Set<SseClient>;
  readonly isDemo: boolean;
  readonly progressEvents: ScanProgressEvent[];
  readonly sourceRoot?: string;
  demoImage?: (photoId: string) => string | undefined;
  latestProgress?: ScanProgressEvent;
  service?: SessionCommandService;
  status: "scanning" | "ready" | "failed";
  error?: SafeStoredError;
  warnings: ApiScanWarning[];
}

interface ProblemDetails {
  readonly fields: ApiValidationField[];
}

class ApiProblem extends Error {
  readonly code: ApiErrorCode;
  readonly details: ProblemDetails | undefined;
  readonly status: number;
  readonly recovery: { auditRetained: boolean; concurrentTargetPreserved: boolean; createdTargetRemoved: boolean; retainedBackup: boolean } | undefined;
  readonly warnings: string[] | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details?: ProblemDetails,
    recovery?: ApiProblem["recovery"],
    warnings?: string[],
  ) {
    super(message);
    this.name = "ApiProblem";
    this.status = status;
    this.code = code;
    this.details = details;
    this.recovery = recovery;
    this.warnings = warnings;
  }
}

const PROBLEMS = {
  invalidToken: () => new ApiProblem(403, "INVALID_TOKEN", "请求缺少有效的访问令牌。"),
  unsafeOrigin: () =>
    new ApiProblem(403, "UNSAFE_REQUEST_ORIGIN", "仅允许来自本机的请求。"),
  albumNotFound: () => new ApiProblem(404, "ALBUM_NOT_FOUND", "找不到当前相册。"),
  albumNotReady: () => new ApiProblem(409, "ALBUM_NOT_READY", "相册仍在扫描中。"),
  scanInProgress: () =>
    new ApiProblem(409, "SCAN_IN_PROGRESS", "当前相册仍在扫描中。"),
  selectionNotFound: () =>
    new ApiProblem(404, "DIRECTORY_SELECTION_NOT_FOUND", "文件夹选择已失效。"),
  featureNotReady: () =>
    new ApiProblem(501, "FEATURE_NOT_READY", "此功能将在后续版本中提供。"),
  apiNotFound: () => new ApiProblem(404, "API_NOT_FOUND", "找不到该接口。"),
  internal: () => new ApiProblem(500, "INTERNAL_ERROR", "请求处理失败，请重试。"),
} as const;

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

function safeHostHeader(value: string | undefined): boolean {
  if (value === "::1") return true;
  if (
    value === undefined ||
    /[\s/@\\]/u.test(value) ||
    value.includes(",") ||
    value.length > 255
  ) {
    return false;
  }
  try {
    const parsed = new URL(`http://${value}`);
    return (
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      loopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function safeOriginHeader(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value.length > 512 || /[\s,]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      loopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function apiSecurity(token: string) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!safeHostHeader(request.get("host"))) {
      next(PROBLEMS.unsafeOrigin());
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      next();
      return;
    }
    if (!safeOriginHeader(request.get("origin"))) {
      next(PROBLEMS.unsafeOrigin());
      return;
    }
    if (request.get("x-burstpick-token") !== token) {
      next(PROBLEMS.invalidToken());
      return;
    }
    next();
  };
}

function validationFields(error: ZodError): ApiValidationField[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message:
      issue.code === "custom" && /[\u3400-\u9fff]/u.test(issue.message)
        ? issue.message
        : issue.code === "invalid_type"
          ? "字段类型不正确。"
          : issue.code === "too_small"
            ? "字段值过小或内容为空。"
            : issue.code === "too_big"
              ? "字段值超过允许范围。"
              : issue.code === "unrecognized_keys"
                ? "请求包含不支持的字段。"
                : "字段值无效。",
  }));
}

function parseBody<T>(schema: ZodType<T>, request: Request): T {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiProblem(400, "INVALID_BODY", "请求内容无效。", {
      fields: validationFields(parsed.error),
    });
  }
  return parsed.data;
}

function parseQuery<T>(schema: ZodType<T>, request: Request): T {
  const parsed = schema.safeParse(request.query);
  if (!parsed.success) {
    throw new ApiProblem(400, "INVALID_QUERY", "查询参数无效。", {
      fields: validationFields(parsed.error),
    });
  }
  return parsed.data;
}

function publicSource(source: SourceFile): Omit<SourceFile, "path"> {
  return {
    kind: source.kind,
    relativePath: source.relativePath,
    size: source.size,
    modifiedAtMs: source.modifiedAtMs,
  };
}

function publicPhoto(photo: PhotoUnit): PublicPhotoUnit {
  const { raw, jpeg, xmp, ...safePhoto } = photo;
  return PublicPhotoUnitSchema.parse({
    ...safePhoto,
    ...(raw === undefined ? {} : { raw: publicSource(raw) }),
    ...(jpeg === undefined ? {} : { jpeg: publicSource(jpeg) }),
    ...(xmp === undefined ? {} : { xmp: publicSource(xmp) }),
  });
}

function publicAlbum(session: AlbumSession, isDemo: boolean): PublicAlbumSession {
  return PublicAlbumSessionSchema.parse({
    ...session,
    isDemo,
    photos: session.photos.map(publicPhoto),
  });
}

function safeWarnings(warnings: readonly ApiScanWarning[] | undefined): ApiScanWarning[] {
  return (warnings ?? []).map((warning) => ApiScanWarningSchema.parse(warning));
}

function problemEnvelope(problem: ApiProblem): ApiErrorEnvelope {
  return {
    error: {
      code: problem.code,
      message: problem.message,
      ...(problem.details === undefined ? {} : { details: problem.details }),
      ...(problem.recovery === undefined ? {} : { recovery: problem.recovery }),
      ...(problem.warnings === undefined ? {} : { warnings: problem.warnings }),
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function recoveryFor(error: unknown): ApiProblem["recovery"] {
  if (!(error instanceof Error) || !("recovery" in error) || typeof error.recovery !== "object" || error.recovery === null) return undefined;
  const value = error.recovery as Record<string, unknown>;
  return ["auditRetained", "concurrentTargetPreserved", "createdTargetRemoved", "retainedBackup"].every((key) => typeof value[key] === "boolean")
    ? value as ApiProblem["recovery"]
    : undefined;
}

function cleanupWarningsFor(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || !("cleanupWarnings" in error) || !Array.isArray(error.cleanupWarnings)) return undefined;
  const warnings = error.cleanupWarnings.filter((item): item is string => typeof item === "string" && item.length > 0);
  return warnings.length === 0 ? undefined : warnings;
}

function metadataProblem(status: number, code: ApiErrorCode, message: string, error: unknown): ApiProblem {
  const warnings = cleanupWarningsFor(error);
  return new ApiProblem(status, code, warnings === undefined ? message : `${message} ${warnings.join(" ")}`, undefined, recoveryFor(error), warnings);
}

function problemFor(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  if (error instanceof FolderPickerError) {
    const status =
      error.code === "PICKER_UNAVAILABLE"
        ? 501
        : error.code === "PICKER_CANCELLED"
          ? 409
          : error.code === "PICKER_FAILED"
            ? 500
            : 400;
    return new ApiProblem(status, error.code, error.message);
  }
  if (error instanceof SessionDomainError) {
    return new ApiProblem(404, error.code, error.code === "PHOTO_NOT_FOUND" ? "找不到该照片。" : "找不到该分组。");
  }
  switch (errorCode(error)) {
    case "SESSION_LOCK_TIMEOUT":
      return new ApiProblem(409, "SESSION_LOCK_TIMEOUT", "相册正被另一个进程使用。请稍后重试。");
    case "SOURCE_CHANGED":
      return metadataProblem(409, "SOURCE_CHANGED", "源文件已更改，请重新扫描相册。", error);
    case "UNSAFE_METADATA_PATH":
      return metadataProblem(409, "UNSAFE_METADATA_PATH", "元数据目标不在当前照片文件夹内。", error);
    case "UNSAFE_COPY_PATH":
      return new ApiProblem(409, "UNSAFE_COPY_PATH", "复制源或目标路径不安全，请重新选择文件夹。");
    case "CONFIRMATION_REQUIRED":
      return metadataProblem(400, "CONFIRMATION_REQUIRED", "请先确认已保存 Lightroom 元数据并关闭 Lightroom。", error);
    case "CONFIRMATION_EXPIRED":
      return metadataProblem(409, "CONFIRMATION_EXPIRED", "导出预览已失效，请重新预览。", error);
    case "EXPORT_CONFLICT":
      return metadataProblem(409, "EXPORT_CONFLICT", "导出内容已更改，请重新预览。", error);
    case "EXPORT_LOCKED":
      return new ApiProblem(409, "EXPORT_LOCKED", "当前照片文件夹已有元数据操作，或上次操作未安全结束；请联系支持人员检查锁文件。");
    case "AUDIT_PERSIST_FAILED": {
      const recovery = recoveryFor(error);
      const outcome = recovery?.retainedBackup === true
        ? "操作未完成，恢复备份仍保留。"
        : recovery?.concurrentTargetPreserved === true
          ? "操作未完成，并发文件已保留，且没有原始备份。"
          : "操作未完成，文件已恢复。";
      return metadataProblem(500, "AUDIT_PERSIST_FAILED", `${outcome} 支持审计记录未能保存，请立即联系支持人员。`, error);
    }
    case "PAIR_VERIFY_FAILED":
      return metadataProblem(500, "PAIR_VERIFY_FAILED", "照片配对验证失败，原文件已恢复。", error);
    case "RECOVERY_REQUIRED": {
      const recovery = recoveryFor(error);
      const message = recovery?.retainedBackup === true
        ? "元数据操作未能自动恢复；已保留恢复备份，请勿继续修改并联系支持人员。"
        : recovery?.concurrentTargetPreserved === true
          ? "元数据操作未能自动完成；并发创建的文件已保留，且没有原始备份，请联系支持人员。"
          : recovery?.createdTargetRemoved === true
            ? "元数据操作未能完成；新建目标已安全移除，请联系支持人员。"
            : "元数据操作未能自动恢复；请勿继续修改并联系支持人员。";
      return metadataProblem(500, "RECOVERY_REQUIRED", message, error);
    }
    case "ROLLBACK_NOT_FOUND":
      return metadataProblem(404, "ROLLBACK_NOT_FOUND", "没有可回滚的最近导出。", error);
    case "ROLLBACK_STALE":
      return metadataProblem(409, "ROLLBACK_STALE", "导出后的文件已经更改，无法安全回滚。", error);
    case "REPORT_NOT_FOUND":
      return new ApiProblem(404, "REPORT_NOT_FOUND", "找不到该复制报告。");
    case "DEMO_EXPORT_DISABLED":
      return metadataProblem(409, "DEMO_EXPORT_DISABLED", "示例相册仅支持导出预览。", error);
    default:
      return PROBLEMS.internal();
  }
}

function isBodyParserError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "type" in error &&
    typeof error.type === "string" &&
    (error.type.startsWith("entity.") || error.type.endsWith(".unsupported"))
  );
}

function writeEvent(response: Response, event: string, data: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(apiSuccess(data))}\n\n`);
}

function closeClient(state: ActiveAlbum, client: SseClient): void {
  clearInterval(client.heartbeat);
  state.clients.delete(client);
  if (!client.response.writableEnded && !client.response.destroyed) client.response.end();
}

function finishClients(state: ActiveAlbum, event: string, data: unknown): void {
  for (const client of [...state.clients]) {
    writeEvent(client.response, event, data);
    closeClient(state, client);
  }
}

function broadcastProgress(state: ActiveAlbum, progress: ScanProgressEvent): void {
  for (const client of state.clients) writeEvent(client.response, "progress", progress);
}

function albumIdForRoot(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function requiredAlbum(active: ActiveAlbum | undefined, id?: string): ActiveAlbum {
  if (active === undefined || id === undefined || active.id !== id) {
    throw PROBLEMS.albumNotFound();
  }
  return active;
}

function readyService(state: ActiveAlbum): SessionCommandService {
  if (state.status === "scanning") throw PROBLEMS.albumNotReady();
  if (state.status === "failed" || state.service === undefined) {
    const failure = state.error;
    throw failure === undefined
      ? new ApiProblem(500, "SCAN_FAILED", "相册扫描失败，请重试。")
      : new ApiProblem(failure.status, failure.code, failure.message);
  }
  return state.service;
}

function requestParameter(request: Request, name: string): string | undefined {
  const value = request.params[name];
  return typeof value === "string" ? value : undefined;
}

export function createApp(dependencies: CreateAppDependencies): BurstPickApp {
  assertProcessToken(dependencies.token);
  const heartbeatMs = dependencies.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0) {
    throw new RangeError("心跳间隔必须是正整数。");
  }

  const folderPicker = dependencies.folderPicker ?? createFolderPicker();
  const validateDirectory = dependencies.validateDirectory ?? validateManualDirectory;
  const createSession =
    dependencies.createSessionService ??
    ((session: AlbumSession, persistence: SessionPersistence) =>
      new SessionService(session, persistence));
  const createDemo = dependencies.demoAlbum ?? createDemoAlbum;
  const selections = new Map<string, string>();
  const copyJobs = new Map<string, CopyJob>();
  const copyPreviewJobs = new Map<string, CopyPreviewJob>();
  const metadataJobs = new Map<string, MetadataJob>();
  let active: ActiveAlbum | undefined;
  let activeScan: Promise<void> | undefined;
  let activeScanController: AbortController | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;

  function retainCompletedJob(job: CopyJob): void {
    if (closing) { copyJobs.delete(job.id); return; }
    job.eviction = setTimeout(() => { if (copyJobs.get(job.id) === job) copyJobs.delete(job.id); }, COPY_JOB_RETENTION_MS);
    job.eviction.unref();
  }

  function retainCompletedCopyPreviewJob(job: CopyPreviewJob): void {
    if (closing) { copyPreviewJobs.delete(job.id); return; }
    job.eviction = setTimeout(() => { if (copyPreviewJobs.get(job.id) === job) copyPreviewJobs.delete(job.id); }, COPY_JOB_RETENTION_MS);
    job.eviction.unref();
  }

  function retainCompletedMetadataJob(job: MetadataJob): void {
    if (closing) { metadataJobs.delete(job.id); return; }
    job.eviction = setTimeout(() => { if (metadataJobs.get(job.id) === job) metadataJobs.delete(job.id); }, COPY_JOB_RETENTION_MS);
    job.eviction.unref();
  }

  function assertOpen(): void {
    if (closing) throw PROBLEMS.internal();
  }

  function replaceActive(next: ActiveAlbum): void {
    if (active !== undefined) finishClients(active, "closed", { reason: "album-replaced" });
    active = next;
  }

  if (dependencies.sessionService !== undefined) {
    const snapshot = dependencies.sessionService.snapshot();
    active = {
      id: snapshot.sourcePathHash,
      clients: new Set(),
      isDemo: false,
      progressEvents: [],
      service: dependencies.sessionService,
      ...(dependencies.sourceRoot === undefined ? {} : { sourceRoot: dependencies.sourceRoot }),
      status: "ready",
      warnings: [],
    };
  }

  function startScan(state: ActiveAlbum, root: string, loader: AlbumLoader): void {
    const controller = new AbortController();
    activeScanController = controller;
    const scan = Promise.resolve()
      .then(async () =>
        loader(root, (candidate) => {
          if (active !== state || state.status !== "scanning") return;
          const progress = ScanProgressSchema.parse(candidate);
          state.latestProgress = progress;
          state.progressEvents.push(progress);
          if (state.progressEvents.length > MAX_PROGRESS_EVENTS) state.progressEvents.shift();
          broadcastProgress(state, progress);
        }, controller.signal),
      )
      .then((loaded) => {
        controller.signal.throwIfAborted();
        if (closing || active !== state || state.status !== "scanning") return;
        state.service = createSession(loaded.session, loaded.persistence);
        state.warnings = safeWarnings(loaded.warnings);
        state.status = "ready";
        const session = state.service.snapshot();
        void dependencies.recentAlbums?.updateStats(state.id, session.photos.length, session.photos.filter((p) => p.rating > 0).length);
        finishClients(state, "complete", { albumId: state.id, status: "ready", warnings: state.warnings });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || closing) return;
        if (active !== state || state.status !== "scanning") return;
        const problem = problemFor(error);
        state.error = {
          code: problem.code === "INTERNAL_ERROR" ? "SCAN_FAILED" : problem.code,
          message: problem.code === "INTERNAL_ERROR" ? "相册扫描失败，请重试。" : problem.message,
          status: problem.status,
        };
        state.status = "failed";
        finishClients(state, "error", {
          code: state.error.code,
          message: state.error.message,
        });
      })
      .finally(() => {
        if (activeScan === scan) {
          activeScan = undefined;
          activeScanController = undefined;
        }
      });
    activeScan = scan;
  }

  const app = express() as BurstPickApp;
  app.disable("x-powered-by");
  app.closeEventStreams = () => {
    if (active !== undefined) finishClients(active, "closed", { reason: "server-shutdown" });
    for (const job of copyJobs.values()) {
      for (const client of [...job.clients]) {
        writeEvent(client.response, "closed", { reason: "server-shutdown" });
        clearInterval(client.heartbeat);
        client.response.end();
      }
      job.clients.clear();
    }
    for (const job of copyPreviewJobs.values()) {
      for (const client of [...job.clients]) {
        writeEvent(client.response, "closed", { reason: "server-shutdown" });
        clearInterval(client.heartbeat);
        client.response.end();
      }
      job.clients.clear();
    }
    for (const job of metadataJobs.values()) {
      for (const client of [...job.clients]) {
        writeEvent(client.response, "closed", { reason: "server-shutdown" });
        clearInterval(client.heartbeat);
        client.response.end();
      }
      job.clients.clear();
    }
  };
  app.close = () => {
    closePromise ??= (async () => {
      closing = true;
      app.closeEventStreams();
      activeScanController?.abort();
      for (const job of copyJobs.values()) job.controller.abort();
      for (const job of copyPreviewJobs.values()) job.controller.abort();
      for (const job of metadataJobs.values()) job.controller.abort();
      for (const job of copyJobs.values()) if (job.eviction !== undefined) clearTimeout(job.eviction);
      for (const job of copyPreviewJobs.values()) if (job.eviction !== undefined) clearTimeout(job.eviction);
      for (const job of metadataJobs.values()) if (job.eviction !== undefined) clearTimeout(job.eviction);
      const scan = activeScan;
      await Promise.allSettled([
        ...(scan === undefined ? [] : [scan]),
        ...[...copyJobs.values()].map(({ promise }) => promise),
        ...[...copyPreviewJobs.values()].map(({ promise }) => promise),
        ...[...metadataJobs.values()].map(({ promise }) => promise),
        ...(folderPicker.close === undefined ? [] : [folderPicker.close()]),
      ]);
      selections.clear();
    })();
    return closePromise;
  };

  const api = express.Router();
  api.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  api.use(express.json({ limit: "64kb", strict: true }));

  api.get("/health", (_request, response) => {
    response.json(apiSuccess({ ready: true, version: 1 as const }));
  });

  api.get("/albums/recent", async (_request, response) => {
    const raw = await dependencies.recentAlbums?.list() ?? [];
    const dataRoot = dependencies.appDataRoot;
    const albums = dataRoot ? await Promise.all(raw.map(async (album) => {
      if (album.photoCount > 0) return album;
      try {
        const { SessionStore } = await import("./session-store.js");
        const { sessionPathForSource } = await import("./index.js");
        const store = new SessionStore(sessionPathForSource(dataRoot, album.canonicalPath));
        const session = await store.load();
        if (session) {
          const rated = session.photos.filter((p) => p.rating > 0).length;
          void dependencies.recentAlbums?.updateStats(album.id, session.photos.length, rated);
          return { ...album, photoCount: session.photos.length, ratedCount: rated };
        }
      } catch { /* session may not exist */ }
      return album;
    })) : raw;
    const filtered = albums
      .filter((a) => !a.canonicalPath.startsWith("/private/var/") && !a.canonicalPath.startsWith("/tmp/"))
      .sort((a, b) => b.photoCount - a.photoCount || new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());
    response.json(apiSuccess({ albums: filtered.map(({ id, name, lastOpenedAt, photoCount, ratedCount }) => ({ id, name, lastOpenedAt, photoCount, ratedCount })) }));
  });

  api.post("/albums/recent/remove", async (request, response) => {
    const { id } = parseBody(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), request);
    await dependencies.recentAlbums?.remove(id);
    response.json(apiSuccess({ removed: true }));
  });

  api.post("/directories/pick", async (request, response) => {
    assertOpen();
    parseBody(EmptyRequestSchema, request);
    const canonicalPath = await validateDirectory(await folderPicker.pick());
    assertOpen();
    const selectionId = randomBytes(16).toString("hex");
    selections.clear();
    selections.set(selectionId, canonicalPath);
    response.json(
      apiSuccess({
        selectionId,
        name: basename(canonicalPath) || "已选择文件夹",
      }),
    );
  });

  api.post("/albums/open", async (request, response) => {
    assertOpen();
    if (active?.status === "scanning") throw PROBLEMS.scanInProgress();
    const input = parseBody(OpenAlbumRequestSchema, request);

    if ("demo" in input) {
      const demo = createDemo();
      const service = createSession(demo.session, { save: async () => undefined });
      const state: ActiveAlbum = {
        id: demo.sourcePathHash,
        clients: new Set(),
        demoImage: demo.imageForPhotoId.bind(demo),
        isDemo: true,
        progressEvents: [],
        service,
        status: "ready",
        warnings: [],
      };
      replaceActive(state);
      response.json(apiSuccess({ albumId: state.id, status: state.status, warnings: state.warnings }));
      return;
    }

    const loader = dependencies.albumLoader;
    if (loader === undefined) throw PROBLEMS.featureNotReady();
    let canonicalRoot: string;
    if ("selectionId" in input) {
      const selected = selections.get(input.selectionId);
      if (selected === undefined) throw PROBLEMS.selectionNotFound();
      selections.delete(input.selectionId);
      canonicalRoot = await validateDirectory(selected);
    } else if ("recentId" in input) {
      const recent = await dependencies.recentAlbums?.resolve(input.recentId);
      if (recent === undefined) throw PROBLEMS.selectionNotFound();
      canonicalRoot = await validateDirectory(recent.canonicalPath);
    } else {
      canonicalRoot = await validateDirectory(input.path);
    }
    await dependencies.recentAlbums?.record(canonicalRoot);
    assertOpen();
    const state: ActiveAlbum = {
      id: albumIdForRoot(canonicalRoot),
      clients: new Set(),
      isDemo: false,
      progressEvents: [],
      sourceRoot: canonicalRoot,
      status: "scanning",
      warnings: [],
    };
    replaceActive(state);
    startScan(state, canonicalRoot, loader);
    response.status(202).json(apiSuccess({ albumId: state.id, status: state.status, warnings: state.warnings }));
  });

  api.get("/albums/:id/events", (request, response) => {
    const state = requiredAlbum(active, requestParameter(request, "id"));
    response.status(200);
    response.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    writeEvent(response, "snapshot", {
      albumId: state.id,
      status: state.status,
      ...(state.latestProgress === undefined ? {} : { latestProgress: state.latestProgress }),
    });
    for (const progress of state.progressEvents) writeEvent(response, "progress", progress);

    if (state.status === "ready") {
      writeEvent(response, "complete", { albumId: state.id, status: "ready", warnings: state.warnings });
      response.end();
      return;
    }
    if (state.status === "failed") {
      writeEvent(
        response,
        "error",
        state.error === undefined
          ? { code: "SCAN_FAILED", message: "相册扫描失败，请重试。" }
          : { code: state.error.code, message: state.error.message },
      );
      response.end();
      return;
    }

    const client: SseClient = {
      response,
      heartbeat: setInterval(() => {
        if (!response.writableEnded && !response.destroyed) response.write(": heartbeat\n\n");
      }, heartbeatMs),
    };
    state.clients.add(client);
    const cleanup = () => {
      clearInterval(client.heartbeat);
      state.clients.delete(client);
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
  });

  api.get("/albums/:id", (request, response) => {
    const state = requiredAlbum(active, requestParameter(request, "id"));
    const service = readyService(state);
    response.json(
      apiSuccess({
        albumId: state.id,
        album: publicAlbum(service.snapshot(), state.isDemo),
        warnings: state.warnings,
      }),
    );
  });

  api.delete("/albums/:id", (request, response) => {
    const state = requiredAlbum(active, requestParameter(request, "id"));
    if (state.status === "scanning" && activeScanController !== undefined) {
      activeScanController.abort();
    }
    response.json(apiSuccess({ cancelled: true }));
  });

  api.get("/photos/:id/thumbnail", async (request, response) => {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    const service = readyService(state);
    const photoId = requestParameter(request, "id");
    const photo = service.snapshot().photos.find((candidate) => candidate.id === photoId);
    if (photo === undefined) {
      throw new ApiProblem(404, "PHOTO_NOT_FOUND", "找不到该照片。");
    }
    const dimensions = parseQuery(ThumbnailQuerySchema, request);
    const demoImage = state.demoImage?.(photo.id);
    if (demoImage !== undefined) {
      response.set("Cache-Control", "private, max-age=31536000, immutable");
      response.type("image/svg+xml").send(demoImage);
      return;
    }
    if (dependencies.imageAdapter === undefined) throw PROBLEMS.featureNotReady();
    const source = photo.jpeg ?? photo.raw;
    if (source === undefined) throw new ApiProblem(404, "PHOTO_NOT_FOUND", "找不到该照片。");
    const thumbnail = await dependencies.imageAdapter.thumbnail(
      { path: source.path, size: source.size, modifiedAtMs: source.modifiedAtMs },
      dimensions,
    );
    response.set("Cache-Control", "private, max-age=31536000, immutable");
    response.type("image/jpeg").send(thumbnail);
  });

  api.patch("/photos/:id/rating", async (request, response) => {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    const input = parseBody(RatePhotoRequestSchema, request);
    const photoId = requestParameter(request, "id");
    if (photoId === undefined) throw PROBLEMS.apiNotFound();
    const session = await readyService(state).ratePhoto(photoId, input.rating);
    const photo = session.photos.find((candidate) => candidate.id === photoId);
    if (photo === undefined) throw new SessionDomainError("PHOTO_NOT_FOUND");
    response.json(apiSuccess({ photo: publicPhoto(photo), album: publicAlbum(session, state.isDemo), warnings: state.warnings }));
  });

  api.post("/photos/ratings", async (request, response) => {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    const input = parseBody(RatePhotosRequestSchema, request);
    const session = await readyService(state).ratePhotos(input.photoIds, input.rating);
    response.json(apiSuccess({ album: publicAlbum(session, state.isDemo), warnings: state.warnings }));
  });

  api.post("/groups/split", async (request, response) => {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    const input = parseBody(SplitGroupRequestSchema, request);
    const session = await readyService(state).split(input.photoId);
    response.json(apiSuccess({ album: publicAlbum(session, state.isDemo), warnings: state.warnings }));
  });

  api.post("/groups/merge", async (request, response) => {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    const input = parseBody(MergeGroupRequestSchema, request);
    const session = await readyService(state).merge(input.groupId);
    response.json(apiSuccess({ album: publicAlbum(session, state.isDemo), warnings: state.warnings }));
  });

  api.post("/groups/regroup", async (request, response) => {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    const input = parseBody(RegroupRequestSchema, request);
    const session = await readyService(state).regroup(input.groupingSensitivity);
    response.json(apiSuccess({ album: publicAlbum(session, state.isDemo), warnings: state.warnings }));
  });

  api.post("/history/undo", async (request, response) => {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    parseBody(EmptyRequestSchema, request);
    const session = await readyService(state).undo();
    response.json(apiSuccess({ album: publicAlbum(session, state.isDemo), warnings: state.warnings }));
  });

  async function exportContext(): Promise<ExportContext> {
    const state = active;
    if (state === undefined) throw PROBLEMS.albumNotFound();
    return {
      albumId: state.id,
      isDemo: state.isDemo,
      sourceRoot: state.sourceRoot ?? "",
      session: readyService(state).snapshot(),
    };
  }

  api.post("/exports/metadata/preview", async (request, response) => {
    if (dependencies.metadataExport === undefined) throw PROBLEMS.featureNotReady();
    const input = parseBody(MetadataExportPreviewRequestSchema, request);
    response.json(apiSuccess(MetadataExportPreviewResponseSchema.parse(await dependencies.metadataExport.preview(await exportContext(), input))));
  });
  api.post("/exports/metadata/jobs", async (request, response) => {
    if (dependencies.metadataExport === undefined) throw PROBLEMS.featureNotReady();
    parseBody(EmptyRequestSchema, request);
    const context = await exportContext();
    if ([...metadataJobs.values()].some((job) => job.albumId === context.albumId && job.terminal === undefined)) {
      throw new ApiProblem(409, "EXPORT_LOCKED", "当前相册已有 Lightroom 导出任务。");
    }
    const jobId = randomBytes(16).toString("hex");
    const controller = new AbortController();
    const job: MetadataJob = { id: jobId, albumId: context.albumId, controller, clients: new Set(), promise: Promise.resolve() };
    metadataJobs.set(jobId, job);
    const publishProgress = (progress: MetadataExportProgress) => {
      job.progress = MetadataExportProgressSchema.parse(progress);
      for (const client of job.clients) writeEvent(client.response, "progress", job.progress);
    };
    job.promise = (async () => {
      try {
        const operation = { signal: controller.signal, onProgress: publishProgress };
        const preview = await dependencies.metadataExport!.preview(context, {}, operation);
        controller.signal.throwIfAborted();
        if (preview.isDemo) job.terminal = { status: "nochange", message: "示例相册不支持写入。" };
        else if (preview.conflicts > 0) job.terminal = { status: "failed", message: `${preview.conflicts} 个文件存在冲突，请先重新扫描。` };
        else if (preview.confirmationId === undefined) job.terminal = { status: "nochange", message: "没有需要写入的文件。" };
        else {
          const result = await dependencies.metadataExport!.commit(context, { confirmationId: preview.confirmationId, lightroomSavedAndClosed: true }, operation);
          job.terminal = MetadataExportTerminalSchema.parse({ status: "complete", result });
        }
      } catch (cause) {
        job.terminal = cause instanceof Error && cause.name === "AbortError"
          ? { status: "cancelled" }
          : { status: "failed", message: problemFor(cause).message };
      }
      for (const client of [...job.clients]) {
        writeEvent(client.response, "terminal", job.terminal);
        clearInterval(client.heartbeat);
        client.response.end();
      }
      job.clients.clear();
      retainCompletedMetadataJob(job);
    })();
    response.status(202).json(apiSuccess(MetadataExportJobResponseSchema.parse({ jobId })));
  });
  api.get("/exports/metadata/jobs/:id/events", (request, response) => {
    const id = requestParameter(request, "id");
    const job = id === undefined ? undefined : metadataJobs.get(id);
    if (job === undefined) throw PROBLEMS.apiNotFound();
    response.status(200).set({ "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    if (job.progress !== undefined) writeEvent(response, "progress", MetadataExportProgressSchema.parse(job.progress));
    if (job.terminal !== undefined) { writeEvent(response, "terminal", MetadataExportTerminalSchema.parse(job.terminal)); response.end(); return; }
    const client: SseClient = { response, heartbeat: setInterval(() => { if (!response.writableEnded && !response.destroyed) response.write(": heartbeat\n\n"); }, heartbeatMs) };
    job.clients.add(client);
    const cleanup = () => { clearInterval(client.heartbeat); job.clients.delete(client); };
    request.once("close", cleanup); response.once("close", cleanup);
  });
  api.post("/exports/metadata/jobs/:id/cancel", (request, response) => {
    parseBody(EmptyRequestSchema, request);
    const id = requestParameter(request, "id");
    const job = id === undefined ? undefined : metadataJobs.get(id);
    if (job === undefined) throw PROBLEMS.apiNotFound();
    job.controller.abort();
    response.status(202).json(apiSuccess(MetadataExportCancelResponseSchema.parse({ accepted: true })));
  });
  api.get("/exports/metadata/latest-rollback", async (_request, response) => {
    if (dependencies.metadataExport === undefined) throw PROBLEMS.featureNotReady();
    response.json(apiSuccess(MetadataExportLatestResponseSchema.parse(await dependencies.metadataExport.latest(await exportContext()))));
  });
  api.post("/exports/metadata/commit", async (request, response) => {
    if (dependencies.metadataExport === undefined) throw PROBLEMS.featureNotReady();
    const input = parseBody(MetadataExportCommitRequestSchema, request);
    response.json(apiSuccess(MetadataExportResultSchema.parse(await dependencies.metadataExport.commit(await exportContext(), input))));
  });
  api.post("/exports/metadata/rollback", async (request, response) => {
    if (dependencies.metadataExport === undefined) throw PROBLEMS.featureNotReady();
    const input = parseBody(MetadataExportRollbackRequestSchema, request);
    response.json(apiSuccess(MetadataExportResultSchema.parse(await dependencies.metadataExport.rollback(await exportContext(), input))));
  });
  api.post("/exports/copy/preview", async (request, response) => {
    if (dependencies.copyExport === undefined) throw PROBLEMS.featureNotReady();
    const input = parseBody(CopyExportPreviewRequestSchema, request);
    const context = await exportContext();
    const minRating = input.minRating ?? 1;
    if (context.isDemo) {
      const preview = await dependencies.copyExport.preview(context, { destinationRoot: "", minRating });
      response.json(apiSuccess(CopyExportPreviewResponseSchema.parse({ ...preview, destinationName: "示例相册-精选" })));
      return;
    }
    let destinationRoot: string;
    try {
      const sourceRoot = await realpath(context.sourceRoot);
      const destinationPath = join(dirname(sourceRoot), `${basename(sourceRoot)}-精选`);
      await mkdir(destinationPath, { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
      const details = await lstat(destinationPath);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("unsafe automatic copy destination");
      destinationRoot = await realpath(destinationPath);
      if (destinationRoot !== destinationPath) throw new Error("unsafe automatic copy destination");
    } catch {
      throw new ApiProblem(409, "UNSAFE_COPY_PATH", "无法安全创建相册旁的精选文件夹。");
    }
    const preview = await dependencies.copyExport.preview(context, { destinationRoot, minRating });
    response.json(apiSuccess(CopyExportPreviewResponseSchema.parse({ ...preview, destinationName: basename(destinationRoot) })));
  });
  api.post("/exports/copy/preview/jobs", async (request, response) => {
    if (dependencies.copyExport === undefined) throw PROBLEMS.featureNotReady();
    const input = parseBody(CopyExportPreviewRequestSchema, request);
    const context = await exportContext();
    if ([...copyPreviewJobs.values()].some((job) => job.albumId === context.albumId && job.terminal === undefined)) throw new ApiProblem(409, "EXPORT_LOCKED", "当前相册已有复制预检任务。请等待或取消后重试。");
    let destinationRoot = "";
    if (!context.isDemo) {
      try {
        const sourceRoot = await realpath(context.sourceRoot);
        const destinationPath = join(dirname(sourceRoot), `${basename(sourceRoot)}-精选`);
        await mkdir(destinationPath, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        });
        const details = await lstat(destinationPath);
        if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("unsafe automatic copy destination");
        destinationRoot = await realpath(destinationPath);
        if (destinationRoot !== destinationPath) throw new Error("unsafe automatic copy destination");
      } catch {
        throw new ApiProblem(409, "UNSAFE_COPY_PATH", "无法安全创建相册旁的精选文件夹。");
      }
    }
    const jobId = randomBytes(16).toString("hex");
    const controller = new AbortController();
    const job: CopyPreviewJob = { id: jobId, albumId: context.albumId, controller, clients: new Set(), promise: Promise.resolve() };
    copyPreviewJobs.set(jobId, job);
    job.promise = dependencies.copyExport.preview(context, { destinationRoot, minRating: input.minRating ?? 1 }, {
      signal: controller.signal,
      onProgress(progress) {
        job.progress = CopyExportPreparationProgressSchema.parse(progress);
        for (const client of job.clients) writeEvent(client.response, "progress", job.progress);
      },
    }).then((preview) => {
      job.terminal = { status: "ready", preview: CopyExportPreviewResponseSchema.parse({ ...preview, destinationName: context.isDemo ? "示例相册-精选" : basename(destinationRoot) }) };
      for (const client of [...job.clients]) { writeEvent(client.response, "terminal", job.terminal); clearInterval(client.heartbeat); client.response.end(); }
      job.clients.clear(); retainCompletedCopyPreviewJob(job);
    }).catch((cause: unknown) => {
      job.terminal = controller.signal.aborted ? { status: "cancelled" } : { status: "failed", message: problemFor(cause).message };
      for (const client of [...job.clients]) { writeEvent(client.response, "terminal", job.terminal); clearInterval(client.heartbeat); client.response.end(); }
      job.clients.clear(); retainCompletedCopyPreviewJob(job);
    });
    response.status(202).json(apiSuccess(CopyExportJobResponseSchema.parse({ jobId })));
  });
  api.get("/exports/copy/preview/jobs/:id/events", (request, response) => {
    const id = requestParameter(request, "id");
    const job = id === undefined ? undefined : copyPreviewJobs.get(id);
    if (job === undefined) throw PROBLEMS.apiNotFound();
    response.status(200).set({ "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    if (job.progress !== undefined) writeEvent(response, "progress", CopyExportPreparationProgressSchema.parse(job.progress));
    if (job.terminal !== undefined) { writeEvent(response, "terminal", CopyExportPreviewTerminalSchema.parse(job.terminal)); response.end(); return; }
    const client: SseClient = { response, heartbeat: setInterval(() => { if (!response.writableEnded && !response.destroyed) response.write(": heartbeat\n\n"); }, heartbeatMs) };
    job.clients.add(client);
    const cleanup = () => { clearInterval(client.heartbeat); job.clients.delete(client); };
    request.once("close", cleanup); response.once("close", cleanup);
  });
  api.post("/exports/copy/preview/jobs/:id/cancel", (request, response) => {
    parseBody(EmptyRequestSchema, request);
    const id = requestParameter(request, "id");
    const job = id === undefined ? undefined : copyPreviewJobs.get(id);
    if (job === undefined) throw PROBLEMS.apiNotFound();
    job.controller.abort();
    response.status(202).json(apiSuccess(CopyExportCancelResponseSchema.parse({ accepted: true })));
  });
  api.post("/exports/copy/commit", async (request, response) => {
    if (dependencies.copyExport === undefined) throw PROBLEMS.featureNotReady();
    const input = parseBody(CopyExportCommitRequestSchema, request);
    const context = await exportContext();
    if ([...copyJobs.values()].some((job) => job.albumId === context.albumId && job.terminal === undefined)) throw new ApiProblem(409, "EXPORT_LOCKED", "当前相册已有复制任务。请等待或取消后重试。");
    const jobId = randomBytes(16).toString("hex");
    const controller = new AbortController();
    const job: CopyJob = { id: jobId, albumId: context.albumId, controller, clients: new Set(), promise: Promise.resolve() };
    copyJobs.set(jobId, job);
    job.promise = dependencies.copyExport.commit(context, {
      confirmationId: input.confirmationId,
      signal: controller.signal,
      onProgress(progress) {
        job.progress = CopyExportProgressSchema.parse(progress);
        for (const client of job.clients) writeEvent(client.response, "progress", job.progress);
      },
    }).then((report) => {
      const parsed = CopyExportReportSchema.parse(report);
      job.terminal = { status: "complete", reportId: parsed.reportId, cancelled: parsed.cancelled };
      for (const client of [...job.clients]) {
        writeEvent(client.response, "terminal", job.terminal);
        clearInterval(client.heartbeat);
        client.response.end();
      }
      job.clients.clear();
      retainCompletedJob(job);
    }).catch((cause: unknown) => {
      const problem = problemFor(cause);
      job.terminal = { status: "failed", message: problem.message };
      for (const client of [...job.clients]) {
        writeEvent(client.response, "terminal", job.terminal);
        clearInterval(client.heartbeat);
        client.response.end();
      }
      job.clients.clear();
      retainCompletedJob(job);
    });
    response.status(202).json(apiSuccess(CopyExportJobResponseSchema.parse({ jobId })));
  });
  api.get("/exports/copy/jobs/:id/events", (request, response) => {
    const id = requestParameter(request, "id");
    const job = id === undefined ? undefined : copyJobs.get(id);
    if (job === undefined) throw PROBLEMS.apiNotFound();
    response.status(200).set({ "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    if (job.progress !== undefined) writeEvent(response, "progress", CopyExportProgressSchema.parse(job.progress));
    if (job.terminal !== undefined) { writeEvent(response, "terminal", CopyExportTerminalSchema.parse(job.terminal)); response.end(); return; }
    const client: SseClient = { response, heartbeat: setInterval(() => { if (!response.writableEnded && !response.destroyed) response.write(": heartbeat\n\n"); }, heartbeatMs) };
    job.clients.add(client);
    const cleanup = () => { clearInterval(client.heartbeat); job.clients.delete(client); };
    request.once("close", cleanup); response.once("close", cleanup);
  });
  api.post("/exports/copy/jobs/:id/cancel", (request, response) => {
    parseBody(EmptyRequestSchema, request);
    const id = requestParameter(request, "id");
    const job = id === undefined ? undefined : copyJobs.get(id);
    if (job === undefined) throw PROBLEMS.apiNotFound();
    job.controller.abort();
    response.status(202).json(apiSuccess(CopyExportCancelResponseSchema.parse({ accepted: true })));
  });
  api.get("/exports/copy/reports/:id", async (request, response) => {
    if (dependencies.copyExport === undefined) throw PROBLEMS.featureNotReady();
    const id = requestParameter(request, "id");
    if (id === undefined) throw PROBLEMS.apiNotFound();
    response.json(apiSuccess(CopyExportReportSchema.parse(await dependencies.copyExport.report(id))));
  });
  api.get("/exports/copy/reports/:id/download", async (request, response) => {
    if (dependencies.copyExport === undefined) throw PROBLEMS.featureNotReady();
    const id = requestParameter(request, "id");
    if (id === undefined) throw PROBLEMS.apiNotFound();
    const report = CopyExportReportSchema.parse(await dependencies.copyExport.report(id));
    response.attachment(`burstpick-copy-${report.reportId}.json`).type("application/json").send(`${JSON.stringify(report, undefined, 2)}\n`);
  });

  api.use((_request, _response, next) => next(PROBLEMS.apiNotFound()));
  app.use("/api", apiSecurity(dependencies.token));
  app.use("/api/v1", api);
  app.use("/api", (_request, _response, next) => next(PROBLEMS.apiNotFound()));

  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    void next;
    const problem = isBodyParserError(error)
      ? new ApiProblem(400, "INVALID_BODY", "请求内容无效。")
      : problemFor(error);
    if (!response.headersSent) response.status(problem.status).json(problemEnvelope(problem));
  };
  app.use(errorHandler);
  return app;
}

export function assertProcessToken(token: string): void {
  if (!/^[0-9a-f]{64}$/iu.test(token)) {
    throw new TypeError("进程令牌必须是 64 位十六进制字符串。");
  }
}
