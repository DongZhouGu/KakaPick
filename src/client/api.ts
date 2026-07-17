import {
  API_PREFIX,
  AlbumCommandResponseSchema,
  AlbumResponseSchema,
  ApiErrorEnvelopeSchema,
  ApiSuccessEnvelopeSchema,
  DirectoryPickerResponseSchema,
  CopyExportCancelResponseSchema,
  CopyExportCommitRequestSchema,
  CopyExportJobResponseSchema,
  CopyExportPreparationProgressSchema,
  CopyExportPreviewTerminalSchema,
  CopyExportPreviewRequestSchema,
  CopyExportPreviewResponseSchema,
  CopyExportProgressSchema,
  CopyExportTerminalSchema,
  EmptyRequestSchema,
  ExportPreviewResponseSchema,
  MetadataExportCommitRequestSchema,
  MetadataExportCancelResponseSchema,
  MetadataExportJobResponseSchema,
  MetadataExportLatestResponseSchema,
  MetadataExportPreviewRequestSchema,
  MetadataExportPreviewResponseSchema,
  MetadataExportResultSchema,
  MetadataExportProgressSchema,
  MetadataExportRollbackRequestSchema,
  MetadataExportTerminalSchema,
  MergeGroupRequestSchema,
  OpenAlbumRequestSchema,
  OpenAlbumResponseSchema,
  RatePhotoRequestSchema,
  RatePhotosRequestSchema,
  RatePhotoResponseSchema,
  RecentAlbumsResponseSchema,
  RegroupRequestSchema,
  ScanCompleteEventSchema,
  ScanProgressSchema,
  ScanFailureEventSchema,
  SplitGroupRequestSchema,
  type ApiErrorCode,
  type ApiScanWarning,
  type CopyExportPreview,
  type CopyExportPreparationProgress,
  type CopyExportPreviewTerminal,
  type CopyExportProgress,
  type CopyExportTerminal,
  type OpenAlbumRequest,
  type MetadataExportPreview,
  type MetadataExportLatest,
  type MetadataExportResult,
  type MetadataExportProgress,
  type MetadataExportTerminal,
  type PublicAlbumSession,
  type RecentAlbumSummary,
  type ScanProgressEvent,
} from "../shared/api.js";
import type { Rating } from "../shared/domain.js";
import type { z } from "zod";

const TOKEN_KEY = "burstpick-token";
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

export class ClientApiError extends Error {
  readonly code: ApiErrorCode | "NETWORK_ERROR";

  constructor(code: ApiErrorCode | "NETWORK_ERROR", message: string) {
    super(message);
    this.name = "ClientApiError";
    this.code = code;
  }
}

export function bootstrapToken(): string | undefined {
  const url = new URL(window.location.href);
  const candidate = url.searchParams.get("token");
  if (candidate !== null) {
    if (TOKEN_PATTERN.test(candidate)) sessionStorage.setItem(TOKEN_KEY, candidate);
    url.searchParams.delete("token");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  const stored = sessionStorage.getItem(TOKEN_KEY);
  return stored !== null && TOKEN_PATTERN.test(stored) ? stored : undefined;
}

async function apiRequest<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (token !== null && TOKEN_PATTERN.test(token)) headers.set("x-burstpick-token", token);
  }

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, { ...init, headers });
  } catch {
    throw new ClientApiError("NETWORK_ERROR", "无法连接本机咔咔选服务，请确认应用仍在运行。");
  }
  const value: unknown = await response.json().catch(() => undefined);
  const problem = ApiErrorEnvelopeSchema.safeParse(value);
  if (!response.ok || problem.success) {
    if (problem.success) throw new ClientApiError(problem.data.error.code, problem.data.error.message);
    throw new ClientApiError("NETWORK_ERROR", "服务返回了无法识别的响应。");
  }
  const parsed = ApiSuccessEnvelopeSchema(schema).safeParse(value);
  if (!parsed.success) {
    throw new ClientApiError("NETWORK_ERROR", "服务返回了无法识别的响应。");
  }
  return parsed.data.data;
}

function jsonBody<T>(schema: z.ZodType<T>, value: unknown): string {
  return JSON.stringify(schema.parse(value));
}

export interface OpenAlbumResult {
  readonly albumId: string;
  readonly status: "scanning" | "ready";
  readonly warnings: readonly ApiScanWarning[];
}

export interface AlbumState {
  readonly album: PublicAlbumSession;
  readonly warnings: readonly ApiScanWarning[];
}

export async function pickDirectory(): Promise<{ selectionId: string; name: string }> {
  return apiRequest("/directories/pick", DirectoryPickerResponseSchema, { method: "POST", body: jsonBody(EmptyRequestSchema, {}) });
}

export async function getRecentAlbums(): Promise<readonly RecentAlbumSummary[]> {
  return (await apiRequest("/albums/recent", RecentAlbumsResponseSchema)).albums;
}

export async function openAlbum(input: OpenAlbumRequest): Promise<OpenAlbumResult> {
  return apiRequest("/albums/open", OpenAlbumResponseSchema, { method: "POST", body: jsonBody(OpenAlbumRequestSchema, input) });
}

export async function getAlbum(albumId: string): Promise<AlbumState> {
  const data = await apiRequest(`/albums/${encodeURIComponent(albumId)}`, AlbumResponseSchema);
  return { album: data.album, warnings: data.warnings };
}

export function thumbnailUrl(photoId: string, size = 640): string {
  return `${API_PREFIX}/photos/${encodeURIComponent(photoId)}/thumbnail?width=${size}&height=${size}`;
}

export function thumbnailSrcSet(photoId: string, sizes: readonly number[] = [640, 1280, 2048, 3200]): string {
  return sizes.map((size) => `${thumbnailUrl(photoId, size)} ${size}w`).join(", ");
}

export interface AlbumEvents {
  readonly onComplete: (warnings: readonly ApiScanWarning[]) => void;
  readonly onError: (message: string) => void;
  readonly onProgress: (progress: ScanProgressEvent) => void;
}

export function subscribeAlbum(albumId: string, events: AlbumEvents): () => void {
  const source = new EventSource(`${API_PREFIX}/albums/${encodeURIComponent(albumId)}/events`);
  let finished = false;
  const close = () => {
    if (finished) return false;
    finished = true;
    source.close();
    return true;
  };
  source.addEventListener("progress", (event) => {
    if (finished) return;
    try {
      const envelope = ApiSuccessEnvelopeSchema(ScanProgressSchema).parse(JSON.parse((event as MessageEvent<string>).data));
      events.onProgress(envelope.data);
    } catch {
      if (close()) events.onError("扫描进度数据无效，请重新打开相册。");
    }
  });
  source.addEventListener("complete", (event) => {
    if (finished) return;
    try {
      const value = ApiSuccessEnvelopeSchema(ScanCompleteEventSchema).parse(JSON.parse((event as MessageEvent<string>).data));
      if (close()) events.onComplete(value.data.warnings);
    } catch {
      if (close()) events.onError("扫描完成数据无效，请重新打开相册。");
    }
  });
  source.addEventListener("error", (event) => {
    if (finished) return;
    if (event instanceof MessageEvent && typeof event.data === "string" && event.data !== "") {
      try {
        const value = ApiSuccessEnvelopeSchema(ScanFailureEventSchema).parse(JSON.parse(event.data));
        if (close()) events.onError(value.data.message);
      } catch {
        if (close()) events.onError("扫描失败，请重试。");
      }
    } else {
      if (close()) events.onError("扫描连接失败，请重新打开相册。");
    }
  });
  return () => { close(); };
}

async function albumCommand(path: string, body: unknown): Promise<AlbumState> {
  const data = await apiRequest(path, AlbumCommandResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { album: data.album, warnings: data.warnings };
}

export async function ratePhoto(photoId: string, rating: Rating): Promise<AlbumState> {
  const data = await apiRequest(`/photos/${encodeURIComponent(photoId)}/rating`, RatePhotoResponseSchema, {
    method: "PATCH",
    body: jsonBody(RatePhotoRequestSchema, { rating }),
  });
  return { album: data.album, warnings: data.warnings };
}

export async function ratePhotos(photoIds: readonly string[], rating: Rating): Promise<AlbumState> {
  const input = RatePhotosRequestSchema.parse({ photoIds, rating });
  return albumCommand("/photos/ratings", input);
}

export const splitGroup = (photoId: string) => albumCommand("/groups/split", SplitGroupRequestSchema.parse({ photoId }));
export const mergeGroup = (groupId: string) => albumCommand("/groups/merge", MergeGroupRequestSchema.parse({ groupId }));
export const regroup = (groupingSensitivity: number) =>
  albumCommand("/groups/regroup", RegroupRequestSchema.parse({ groupingSensitivity }));
export const undo = () => albumCommand("/history/undo", EmptyRequestSchema.parse({}));

export async function previewExport(kind: "metadata" | "copy"): Promise<unknown> {
  return apiRequest(`/exports/${kind}/preview`, ExportPreviewResponseSchema, { method: "POST", body: jsonBody(EmptyRequestSchema, {}) });
}

export async function previewCopyExport(minRating = 1): Promise<CopyExportPreview> {
  const input = CopyExportPreviewRequestSchema.parse({ minRating });
  return apiRequest("/exports/copy/preview", CopyExportPreviewResponseSchema, { method: "POST", body: jsonBody(CopyExportPreviewRequestSchema, input) });
}

export async function startCopyExportPreviewJob(minRating = 1): Promise<{ jobId: string }> {
  const input = CopyExportPreviewRequestSchema.parse({ minRating });
  return apiRequest("/exports/copy/preview/jobs", CopyExportJobResponseSchema, { method: "POST", body: jsonBody(CopyExportPreviewRequestSchema, input) });
}

export async function cancelCopyExportPreviewJob(jobId: string): Promise<void> {
  await apiRequest(`/exports/copy/preview/jobs/${encodeURIComponent(jobId)}/cancel`, CopyExportCancelResponseSchema, { method: "POST", body: jsonBody(EmptyRequestSchema, {}) });
}

export function subscribeCopyExportPreview(jobId: string, events: { onProgress(progress: CopyExportPreparationProgress): void; onTerminal(terminal: CopyExportPreviewTerminal): void; onError(message: string): void }): () => void {
  const source = new EventSource(`${API_PREFIX}/exports/copy/preview/jobs/${encodeURIComponent(jobId)}/events`);
  let finished = false;
  const close = () => { if (finished) return; finished = true; source.close(); };
  source.addEventListener("progress", (event) => {
    if (finished) return;
    try { events.onProgress(ApiSuccessEnvelopeSchema(CopyExportPreparationProgressSchema).parse(JSON.parse((event as MessageEvent<string>).data)).data); }
    catch { close(); events.onError("复制预检进度数据无效。"); }
  });
  source.addEventListener("terminal", (event) => {
    if (finished) return;
    try { const terminal = ApiSuccessEnvelopeSchema(CopyExportPreviewTerminalSchema).parse(JSON.parse((event as MessageEvent<string>).data)).data; close(); events.onTerminal(terminal); }
    catch { close(); events.onError("复制预检结果数据无效。"); }
  });
  source.addEventListener("error", () => { if (!finished) events.onError("复制预检连接暂时中断，正在重连。"); });
  return close;
}

export async function commitCopyExport(confirmationId: string): Promise<{ jobId: string }> {
  const input = CopyExportCommitRequestSchema.parse({ confirmationId });
  return apiRequest("/exports/copy/commit", CopyExportJobResponseSchema, { method: "POST", body: jsonBody(CopyExportCommitRequestSchema, input) });
}

export async function cancelCopyExport(jobId: string): Promise<void> {
  await apiRequest(`/exports/copy/jobs/${encodeURIComponent(jobId)}/cancel`, CopyExportCancelResponseSchema, { method: "POST", body: jsonBody(EmptyRequestSchema, {}) });
}

export function copyReportDownloadUrl(reportId: string): string {
  return `${API_PREFIX}/exports/copy/reports/${encodeURIComponent(reportId)}/download`;
}

export function subscribeCopyExport(jobId: string, events: { onProgress(progress: CopyExportProgress): void; onTerminal(terminal: CopyExportTerminal): void; onError(message: string): void }): () => void {
  const source = new EventSource(`${API_PREFIX}/exports/copy/jobs/${encodeURIComponent(jobId)}/events`);
  let finished = false;
  const close = () => { if (finished) return; finished = true; source.close(); };
  source.addEventListener("progress", (event) => {
    if (finished) return;
    try { events.onProgress(ApiSuccessEnvelopeSchema(CopyExportProgressSchema).parse(JSON.parse((event as MessageEvent<string>).data)).data); }
    catch { close(); events.onError("复制进度数据无效。"); }
  });
  source.addEventListener("terminal", (event) => {
    if (finished) return;
    try { const terminal = ApiSuccessEnvelopeSchema(CopyExportTerminalSchema).parse(JSON.parse((event as MessageEvent<string>).data)).data; close(); events.onTerminal(terminal); }
    catch { close(); events.onError("复制结果数据无效。"); }
  });
  source.addEventListener("error", () => { if (!finished) events.onError("复制进度连接暂时中断，正在重连。"); });
  return close;
}

export async function previewMetadataExport(): Promise<MetadataExportPreview> {
  return apiRequest("/exports/metadata/preview", MetadataExportPreviewResponseSchema, {
    method: "POST",
    body: jsonBody(MetadataExportPreviewRequestSchema, {}),
  });
}

export async function latestMetadataRollback(): Promise<MetadataExportLatest> {
  return apiRequest("/exports/metadata/latest-rollback", MetadataExportLatestResponseSchema);
}

export async function commitMetadataExport(confirmationId: string): Promise<MetadataExportResult> {
  const input = MetadataExportCommitRequestSchema.parse({ confirmationId, lightroomSavedAndClosed: true });
  return apiRequest("/exports/metadata/commit", MetadataExportResultSchema, {
    method: "POST",
    body: jsonBody(MetadataExportCommitRequestSchema, input),
  });
}

export async function rollbackMetadataExport(): Promise<MetadataExportResult> {
  return apiRequest("/exports/metadata/rollback", MetadataExportResultSchema, {
    method: "POST",
    body: jsonBody(MetadataExportRollbackRequestSchema, {}),
  });
}

export async function startMetadataExportJob(): Promise<{ jobId: string }> {
  return apiRequest("/exports/metadata/jobs", MetadataExportJobResponseSchema, {
    method: "POST",
    body: jsonBody(EmptyRequestSchema, {}),
  });
}

export function subscribeMetadataExportJob(jobId: string, events: { onProgress(progress: MetadataExportProgress): void; onTerminal(terminal: MetadataExportTerminal): void; onError(message: string): void }): () => void {
  const source = new EventSource(`${API_PREFIX}/exports/metadata/jobs/${encodeURIComponent(jobId)}/events`);
  let finished = false;
  const close = () => { if (finished) return; finished = true; source.close(); };
  source.addEventListener("progress", (event) => {
    if (finished) return;
    try { events.onProgress(ApiSuccessEnvelopeSchema(MetadataExportProgressSchema).parse(JSON.parse((event as MessageEvent<string>).data)).data); }
    catch { close(); events.onError("导出进度数据无效。"); }
  });
  source.addEventListener("terminal", (event) => {
    if (finished) return;
    try { const terminal = ApiSuccessEnvelopeSchema(MetadataExportTerminalSchema).parse(JSON.parse((event as MessageEvent<string>).data)).data; close(); events.onTerminal(terminal); }
    catch { close(); events.onError("导出结果数据无效。"); }
  });
  source.addEventListener("error", () => { if (!finished) events.onError("导出进度连接暂时中断，正在重连。"); });
  return close;
}

export async function cancelMetadataExportJob(jobId: string): Promise<void> {
  await apiRequest(`/exports/metadata/jobs/${encodeURIComponent(jobId)}/cancel`, MetadataExportCancelResponseSchema, {
    method: "POST",
    body: jsonBody(EmptyRequestSchema, {}),
  });
}
