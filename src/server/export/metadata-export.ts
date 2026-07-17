import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { MetadataExportPreview, MetadataExportResult } from "../../shared/api.js";
import type { PhotoUnit, Rating } from "../../shared/domain.js";
import type { ImageAdapter, ImageInspection } from "../adapters/image.js";
import type { MetadataAdapter } from "../adapters/metadata.js";
import type { ExportContext, MetadataExportService } from "../app.js";
import {
  assertContained,
  assertLexicalRegularFile,
  assertSnapshot,
  assertWritableParent,
  canonicalPath,
  isSameOrInside,
  snapshotFile,
  type FileSnapshot,
} from "./metadata-snapshot.js";

const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60_000;
const PROPRIETARY_RAW = new Set([".arw", ".cr2", ".cr3", ".nef", ".raf", ".rw2", ".orf"]);
const VOLATILE_TOP_LEVEL_KEYS = new Set([
  "rating", "metadatadate", "sourcefile", "directory", "filename", "filesize", "filemodifydate",
  "fileaccessdate", "fileinodechangedate", "filepermissions", "exiftoolversion", "warning", "warnings",
  "writerwarning", "writerwarnings",
  "xmptoolkit", "previewimagestart", "stripoffsets",
  "mpimagestart", "mpimagelength",
]);
const ERROR_TOP_LEVEL_KEYS = new Set(["error", "errors"]);
const processLocks = new Map<string, Promise<void>>();

export type MetadataExportItemStatus = "written" | "skipped" | "conflict" | "error" | "rolled-back";
export type MetadataTargetKind = "xmp" | "jpeg" | "dng";

export interface MetadataExportProgress {
  readonly phase: "scanning" | "writing" | "verifying";
  readonly completed: number;
  readonly total: number;
  readonly relativePath?: string;
}

export interface MetadataOperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MetadataExportProgress) => void;
}

export interface MetadataExportPreviewItem {
  readonly id: string;
  readonly label: string;
  readonly kind: MetadataTargetKind;
  readonly rating: Rating;
  readonly status: "ready" | "skipped" | "conflict";
}

interface TargetPlan {
  readonly id: string;
  readonly kind: MetadataTargetKind;
  readonly label: string;
  readonly photoId: string;
  readonly protectedMetadata: unknown;
  readonly rating: Rating;
  readonly snapshot: FileSnapshot;
  readonly sourceSnapshots: readonly FileSnapshot[];
  readonly sidecarForExtension?: string;
  readonly dimensions?: ImageInspection;
}

interface InternalPlan {
  readonly albumId: string;
  readonly confirmationId: string;
  readonly createdAtMs: number;
  readonly digest: string;
  readonly inventoryFingerprint: string;
  readonly sessionExportDigest: string;
  readonly sourceRoot: string;
  readonly skippedItems: readonly MetadataExportPreviewItem[];
  readonly targets: readonly TargetPlan[];
}

interface PreparedTarget {
  readonly backupPath: string;
  readonly plan: TargetPlan;
  readonly preparedSnapshot: FileSnapshot;
  readonly temporaryPath: string;
}

interface RecoveryOwnedTarget extends PreparedTarget {
  concurrentTargetPreserved: boolean;
  createdTargetRemoved: boolean;
  readonly hadOriginal: boolean;
  installed: boolean;
  retainBackup: boolean;
}

interface AuditEntry {
  readonly backupName?: string;
  readonly created: boolean;
  readonly kind: MetadataTargetKind;
  readonly mode?: number;
  readonly pre: Omit<FileSnapshot, "path">;
  readonly post: Omit<FileSnapshot, "path">;
  readonly protectedMetadataHash: string;
  readonly rating: Rating;
  readonly relativePath: string;
}

interface AuditManifest {
  readonly albumId: string;
  readonly completedAt: string;
  readonly entries: readonly AuditEntry[];
  readonly id: string;
  readonly sourceRootHash: string;
}

export interface CreateMetadataExportServiceOptions {
  readonly appDataRoot: string;
  readonly confirmationTtlMs?: number;
  readonly images: Pick<ImageAdapter, "inspect" | "thumbnail">;
  readonly metadata: Pick<MetadataAdapter, "readRaw" | "writeRating">;
  readonly now?: () => number;
  readonly failureInjection?: (
    stage: "prepare-copy" | "prepare-write" | "audit-backup-copy" | "before-original-rename" | "original-rename" |
      "after-original-rename" | "install" | "restore" | "failed-audit-publication" | "latest-publication" |
      "failed-audit-fallback-publication" | "rollback-install" | "rollback-restore" | "cleanup" | "lock-close" | "lock-cleanup",
    detail: { readonly auditId?: string; readonly target?: string },
  ) => void | Promise<void>;
}

export class MetadataExportError extends Error {
  readonly code:
    | "AUDIT_PERSIST_FAILED"
    | "CONFIRMATION_EXPIRED"
    | "CONFIRMATION_REQUIRED"
    | "DEMO_EXPORT_DISABLED"
    | "EXPORT_CONFLICT"
    | "EXPORT_LOCKED"
    | "PAIR_VERIFY_FAILED"
    | "RECOVERY_REQUIRED"
    | "ROLLBACK_NOT_FOUND"
    | "ROLLBACK_STALE"
    | "SOURCE_CHANGED"
    | "UNSAFE_METADATA_PATH";
  readonly recovery: MetadataRecoveryOutcome | undefined;
  cleanupWarnings: string[];

  constructor(code: MetadataExportError["code"], cause?: unknown, recovery?: MetadataRecoveryOutcome) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "MetadataExportError";
    this.code = code;
    this.recovery = recovery;
    this.cleanupWarnings = [];
  }
}

export interface MetadataRecoveryOutcome {
  readonly auditRetained: boolean;
  readonly concurrentTargetPreserved: boolean;
  readonly createdTargetRemoved: boolean;
  readonly retainedBackup: boolean;
}

const LOCK_CLEANUP_WARNING = "操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。";

function topLevelKey(key: string): string {
  return (key.split(":").at(-1) ?? key).toLocaleLowerCase("en-US");
}

function normalizedValue(value: unknown, topLevel = false): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizedValue(item));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !topLevel || !VOLATILE_TOP_LEVEL_KEYS.has(topLevelKey(key)))
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([key, item]) => [key, normalizedValue(item)]));
}

export function normalizeProtectedMetadata(metadata: Readonly<Record<string, unknown>>): unknown {
  for (const [key, value] of Object.entries(metadata)) {
    const hasError = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
    if (ERROR_TOP_LEVEL_KEYS.has(topLevelKey(key)) && hasError) {
      throw new Error("ExifTool reported an error");
    }
  }
  return normalizedValue(metadata, true);
}

function metadataRating(metadata: Readonly<Record<string, unknown>>): Rating {
  for (const [key, value] of Object.entries(metadata)) {
    if ((key.split(":").at(-1) ?? key).toLocaleLowerCase("en-US") !== "rating") continue;
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(number) && number >= 0 && number <= 5) return number as Rating;
  }
  return 0;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuditManifest(value: unknown): AuditManifest {
  if (!isRecord(value) ||
    typeof value.albumId !== "string" ||
    typeof value.completedAt !== "string" ||
    typeof value.id !== "string" || !/^[0-9a-f]{32}$/u.test(value.id) ||
    typeof value.sourceRootHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.sourceRootHash) ||
    !Array.isArray(value.entries)
  ) throw new Error("Invalid metadata export audit");
  for (const entry of value.entries) {
    if (!isRecord(entry) ||
      typeof entry.created !== "boolean" ||
      !["xmp", "jpeg", "dng"].includes(String(entry.kind)) ||
      typeof entry.relativePath !== "string" || entry.relativePath.length === 0 ||
      typeof entry.rating !== "number" || !Number.isInteger(entry.rating) || entry.rating < 0 || entry.rating > 5 ||
      typeof entry.protectedMetadataHash !== "string" || !/^[0-9a-f]{64}$/u.test(entry.protectedMetadataHash) ||
      !isRecord(entry.pre) || entry.pre.exists !== !entry.created ||
      (!entry.created && (
        typeof entry.pre.hash !== "string" || !/^[0-9a-f]{64}$/u.test(entry.pre.hash) ||
        typeof entry.pre.size !== "number" || !Number.isFinite(entry.pre.size) || entry.pre.size < 0
      )) ||
      !isRecord(entry.post) || entry.post.exists !== true ||
      typeof entry.post.hash !== "string" || !/^[0-9a-f]{64}$/u.test(entry.post.hash) ||
      typeof entry.post.size !== "number" || !Number.isFinite(entry.post.size) || entry.post.size < 0 ||
      typeof entry.post.modifiedAtMs !== "number" || !Number.isFinite(entry.post.modifiedAtMs) || entry.post.modifiedAtMs < 0 ||
      (!entry.created && (typeof entry.backupName !== "string" || !/^\d+\.(?:xmp|jpe?g|dng)$/iu.test(entry.backupName)))
    ) throw new Error("Invalid metadata export audit entry");
  }
  return value as unknown as AuditManifest;
}

function safeLabel(root: string, target: string): string {
  const candidate = relative(root, target).split(/[\\/]/u).join("/");
  return candidate.startsWith("../") ? basename(target) : candidate;
}

function sidecarPath(photo: PhotoUnit): string {
  if (photo.xmp !== undefined) return photo.xmp.path;
  const raw = photo.raw;
  if (raw === undefined) throw new Error("Sidecar target requires a RAW source");
  return raw.path.slice(0, raw.path.length - extname(raw.path).length) + ".xmp";
}

function targetSpecs(photo: PhotoUnit): Array<{ kind: MetadataTargetKind; path: string; sourcePaths: string[] }> {
  const specs: Array<{ kind: MetadataTargetKind; path: string; sourcePaths: string[] }> = [];
  if (photo.raw !== undefined) {
    const extension = extname(photo.raw.path).toLocaleLowerCase("en-US");
    if (extension === ".dng") specs.push({ kind: "dng", path: photo.raw.path, sourcePaths: [photo.raw.path] });
    else if (PROPRIETARY_RAW.has(extension)) specs.push({ kind: "xmp", path: sidecarPath(photo), sourcePaths: [photo.raw.path, ...(photo.xmp === undefined ? [] : [photo.xmp.path])] });
  }
  if (photo.raw === undefined && photo.jpeg !== undefined) {
    specs.push({ kind: "jpeg", path: photo.jpeg.path, sourcePaths: [photo.jpeg.path] });
  }
  return specs;
}

function sessionExportDigest(context: ExportContext): string {
  return stableDigest(context.session.photos.map((photo) => ({
    id: photo.id,
    rating: photo.rating,
    targets: targetSpecs(photo).map((target) => [target.kind, target.path]),
  })));
}

function descriptorFor(photo: PhotoUnit, path: string) {
  const lexical = resolve(path);
  return [photo.raw, photo.jpeg, photo.xmp].find((candidate) =>
    candidate !== undefined && resolve(candidate.path) === lexical);
}

function assertMatchesInventory(photo: PhotoUnit, snapshot: FileSnapshot): void {
  const descriptor = descriptorFor(photo, snapshot.path);
  if (descriptor !== undefined && (
    !snapshot.exists || descriptor.size !== snapshot.size || descriptor.modifiedAtMs !== snapshot.modifiedAtMs
  )) {
    throw new MetadataExportError("SOURCE_CHANGED");
  }
}

function normalizedStem(path: string): string {
  return basename(path, extname(path)).normalize("NFC").toLocaleLowerCase("en-US");
}

function assertLexicalTargetIdentity(photo: PhotoUnit, kind: MetadataTargetKind, path: string): void {
  if (kind !== "xmp") {
    if (descriptorFor(photo, path) === undefined) throw new MetadataExportError("SOURCE_CHANGED");
    return;
  }
  if (photo.raw === undefined || normalizedStem(path) !== normalizedStem(photo.raw.path)) {
    throw new MetadataExportError("UNSAFE_METADATA_PATH");
  }
  if (photo.xmp !== undefined && resolve(photo.xmp.path) !== resolve(path)) {
    throw new MetadataExportError("SOURCE_CHANGED");
  }
}

function xmpSkeleton(sidecarForExtension?: string): string {
  const association = sidecarForExtension === undefined
    ? ""
    : ` xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:SidecarForExtension="${sidecarForExtension}"`;
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"${association} /></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>\n`;
}

function siblingPath(target: string, role: "tmp" | "backup"): string {
  const extension = extname(target);
  const stem = basename(target, extension);
  return join(dirname(target), `.${stem}.burstpick-${randomUUID()}.${role}${extension}`);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = siblingPath(path, "tmp");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readMetadata(metadata: Pick<MetadataAdapter, "readRaw">, snapshot: FileSnapshot): Promise<Record<string, unknown>> {
  return snapshot.exists ? metadata.readRaw(snapshot.path) : {};
}

function sameProtected(left: unknown, right: unknown): boolean {
  return stableDigest(left) === stableDigest(right);
}

async function verifyTarget(
  target: TargetPlan,
  path: string,
  metadata: Pick<MetadataAdapter, "readRaw">,
  images: Pick<ImageAdapter, "inspect" | "thumbnail">,
): Promise<void> {
  const tags = await metadata.readRaw(path);
  if (metadataRating(tags) !== target.rating || (
    target.snapshot.exists && !sameProtected(normalizeProtectedMetadata(tags), target.protectedMetadata)
  )) {
    throw new MetadataExportError("PAIR_VERIFY_FAILED");
  }
  if (target.kind !== "xmp") {
    const inspection = await images.inspect(path);
    if (target.dimensions === undefined || inspection.format !== target.dimensions.format || inspection.width !== target.dimensions.width || inspection.height !== target.dimensions.height) {
      throw new MetadataExportError("PAIR_VERIFY_FAILED");
    }
    await images.thumbnail(path, { width: 64, height: 64 });
  }
}

async function buildPlan(
  context: ExportContext,
  metadata: Pick<MetadataAdapter, "readRaw">,
  images: Pick<ImageAdapter, "inspect">,
  now: number,
  operation: MetadataOperationOptions = {},
): Promise<{ plan?: InternalPlan; preview: MetadataExportPreview }> {
  operation.signal?.throwIfAborted();
  if (context.isDemo) {
    const items = context.session.photos.flatMap((photo) => targetSpecs(photo).map((spec) => ({
      id: stableDigest([photo.id, spec.kind]).slice(0, 24),
      label: basename(spec.path),
      kind: spec.kind,
      rating: photo.rating,
      status: "ready" as const,
    })));
    return { preview: { isDemo: true, conflicts: 0, items, ready: items.length, skipped: 0 } };
  }
  const sourceRoot = await canonicalPath(context.sourceRoot);
  const allSpecs: { photo: (typeof context.session.photos)[number]; spec: ReturnType<typeof targetSpecs>[number] }[] = [];
  for (const photo of context.session.photos) {
    for (const spec of targetSpecs(photo)) allSpecs.push({ photo, spec });
  }
  const items: MetadataExportPreviewItem[] = [];
  const targets: TargetPlan[] = [];
  let skipped = 0;
  let conflicts = 0;
  const concurrency = 12;
  for (let i = 0; i < allSpecs.length; i += concurrency) {
    operation.signal?.throwIfAborted();
    const batch = allSpecs.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async ({ photo, spec }) => {
      const id = stableDigest([photo.id, spec.kind]).slice(0, 24);
      let label = basename(spec.path);
      try {
        const lexicalTarget = resolve(spec.path);
        assertLexicalTargetIdentity(photo, spec.kind, lexicalTarget);
        await assertLexicalRegularFile(lexicalTarget, true);
        await assertContained(sourceRoot, lexicalTarget);
        label = safeLabel(sourceRoot, lexicalTarget);
        await assertWritableParent(lexicalTarget);
        const [snapshot, ...sourceSnapshots] = await Promise.all([
          snapshotFile(lexicalTarget),
          ...spec.sourcePaths.filter((path) => resolve(path) !== lexicalTarget).map(async (path) => {
            const lexicalSource = resolve(path);
            await assertLexicalRegularFile(lexicalSource, false);
            await assertContained(sourceRoot, lexicalSource);
            return snapshotFile(lexicalSource);
          }),
        ]);
        for (const source of [snapshot, ...sourceSnapshots]) assertMatchesInventory(photo, source);
        const tags = await readMetadata(metadata, snapshot);
        if (metadataRating(tags) === photo.rating || (!snapshot.exists && photo.rating === 0)) {
          return { type: "skip" as const, item: { id, label, kind: spec.kind, rating: photo.rating, status: "skipped" as const } };
        }
        const dimensions = spec.kind === "xmp" ? undefined : await images.inspect(snapshot.path);
        return { type: "target" as const, target: {
          id,
          kind: spec.kind,
          label,
          photoId: photo.id,
          protectedMetadata: normalizeProtectedMetadata(tags),
          rating: photo.rating,
          snapshot,
          sourceSnapshots: [snapshot, ...sourceSnapshots],
          ...(spec.kind === "xmp" && photo.raw !== undefined
            ? { sidecarForExtension: extname(photo.raw.path).slice(1).toLocaleUpperCase("en-US") }
            : {}),
          ...(dimensions === undefined ? {} : { dimensions }),
        }, item: { id, label, kind: spec.kind, rating: photo.rating, status: "ready" as const } };
      } catch {
        return { type: "conflict" as const, item: { id, label, kind: spec.kind, rating: photo.rating, status: "conflict" as const } };
      }
    }));
    for (const r of results) {
      if (r.type === "skip") { skipped += 1; items.push(r.item); }
      else if (r.type === "target") { items.push(r.item); targets.push(r.target); }
      else { conflicts += 1; items.push(r.item); }
    }
    operation.onProgress?.({
      phase: "scanning",
      completed: Math.min(i + batch.length, allSpecs.length),
      total: allSpecs.length,
      ...(items.at(-1)?.label === undefined ? {} : { relativePath: items.at(-1)!.label }),
    });
  }
  if (conflicts > 0) return { preview: { isDemo: false, conflicts, items, ready: targets.length, skipped } };
  const confirmationId = randomBytes(32).toString("hex");
  const skippedItems = items.filter((item) => item.status === "skipped");
  const immutable = {
    albumId: context.albumId,
    inventoryFingerprint: context.session.inventoryFingerprint,
    sessionExportDigest: sessionExportDigest(context),
    sourceRoot,
    skippedItems,
    targets,
  };
  const plan: InternalPlan = { ...immutable, confirmationId, createdAtMs: now, digest: stableDigest(immutable) };
  return { plan, preview: { confirmationId, isDemo: false, conflicts, items, ready: targets.length, skipped } };
}

async function prepareTarget(
  plan: TargetPlan,
  metadata: Pick<MetadataAdapter, "readRaw" | "writeRating">,
  images: Pick<ImageAdapter, "inspect" | "thumbnail">,
  inject?: CreateMetadataExportServiceOptions["failureInjection"],
  auditId?: string,
): Promise<PreparedTarget> {
  const temporaryPath = siblingPath(plan.snapshot.path, "tmp");
  const exifToolBackupPath = `${temporaryPath}_original`;
  const backupPath = siblingPath(plan.snapshot.path, "backup");
  try {
    await assertLexicalRegularFile(plan.snapshot.path, !plan.snapshot.exists);
    for (const source of plan.sourceSnapshots) {
      await assertLexicalRegularFile(source.path, !source.exists);
    }
    if (plan.snapshot.exists) {
      await inject?.("prepare-copy", { ...(auditId === undefined ? {} : { auditId }), target: plan.snapshot.path });
      await assertLexicalRegularFile(plan.snapshot.path, false);
      for (const source of plan.sourceSnapshots) await assertLexicalRegularFile(source.path, !source.exists);
      await copyFile(plan.snapshot.path, temporaryPath);
      if (plan.snapshot.mode !== undefined) await chmod(temporaryPath, plan.snapshot.mode);
    } else {
      await inject?.("prepare-write", { ...(auditId === undefined ? {} : { auditId }), target: plan.snapshot.path });
      await assertLexicalRegularFile(plan.snapshot.path, true);
      for (const source of plan.sourceSnapshots) await assertLexicalRegularFile(source.path, !source.exists);
      await writeFile(temporaryPath, xmpSkeleton(plan.sidecarForExtension), { flag: "wx", mode: 0o600 });
    }
    await metadata.writeRating(temporaryPath, plan.rating);
    await verifyTarget(plan, temporaryPath, metadata, images);
    await rm(exifToolBackupPath, { force: true });
    return { backupPath, plan, preparedSnapshot: await snapshotFile(temporaryPath), temporaryPath };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(exifToolBackupPath, { force: true }).catch(() => undefined);
    throw error instanceof MetadataExportError ? error : new MetadataExportError("PAIR_VERIFY_FAILED", error);
  }
}

async function restoreNoClobber(
  item: RecoveryOwnedTarget,
  inject?: CreateMetadataExportServiceOptions["failureInjection"],
  auditId?: string,
): Promise<void> {
  await inject?.("restore", { ...(auditId === undefined ? {} : { auditId }), target: item.plan.snapshot.path });
  await link(item.backupPath, item.plan.snapshot.path);
  await unlink(item.backupPath);
}

async function reverseInstalled(
  installed: readonly RecoveryOwnedTarget[],
  inject?: CreateMetadataExportServiceOptions["failureInjection"],
  auditId?: string,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const item of [...installed].reverse()) {
    try {
      if (item.retainBackup && !item.installed) continue;
      if (item.installed) {
        const current = await snapshotFile(item.plan.snapshot.path);
        if (!current.exists || current.hash !== item.preparedSnapshot.hash || current.size !== item.preparedSnapshot.size) {
          item.retainBackup = item.hadOriginal;
          item.concurrentTargetPreserved = current.exists;
          throw new Error("Installed target changed before recovery");
        }
        await unlink(item.plan.snapshot.path);
        if (!item.hadOriginal) item.createdTargetRemoved = true;
      }
      if (item.hadOriginal) {
        try {
          await restoreNoClobber(item, inject, auditId);
          item.retainBackup = false;
        } catch (error) {
          item.retainBackup = true;
          throw error;
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function withRootLock<T extends object>(
  appDataRoot: string,
  sourceRoot: string,
  operation: () => Promise<T>,
  inject?: CreateMetadataExportServiceOptions["failureInjection"],
): Promise<T> {
  const canonicalRoot = await canonicalPath(sourceRoot);
  const key = stableDigest(canonicalRoot);
  const predecessor = processLocks.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = predecessor.then(() => queued);
  processLocks.set(key, tail);
  await predecessor;
  const canonicalAppDataRoot = await canonicalPath(appDataRoot);
  const lockDirectory = join(canonicalAppDataRoot, "metadata-export-locks");
  const lockPath = join(lockDirectory, `${key}.lock`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  let cleanupFailed = false;
  try {
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ sourceRootHash: key, pid: process.pid }));
      await handle.sync();
    } catch (error) {
      // Check if lock is stale (process dead)
      try {
        const content = JSON.parse(await readFile(lockPath, "utf8"));
        if (content.pid && !isProcessAlive(content.pid)) {
          await rm(lockPath, { force: true });
          handle = await open(lockPath, "wx", 0o600);
          await handle.writeFile(JSON.stringify({ sourceRootHash: key, pid: process.pid }));
          await handle.sync();
        } else {
          throw new MetadataExportError("EXPORT_LOCKED", error);
        }
      } catch (nested) {
        if (nested instanceof MetadataExportError) throw nested;
        // Corrupt lock file — remove and retry
        await rm(lockPath, { force: true });
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ sourceRootHash: key, pid: process.pid }));
        await handle.sync();
      }
    }
    try {
      result = await operation();
    } catch (error) {
      primaryError = error;
    }
  } finally {
    if (handle !== undefined) {
      try {
        await inject?.("lock-close", { target: "metadata-operation.lock" });
        await handle.close();
      } catch {
        cleanupFailed = true;
        await handle.close().catch(() => undefined);
      }
      try {
        await inject?.("lock-cleanup", { target: "metadata-operation.lock" });
        await unlink(lockPath);
      } catch {
        cleanupFailed = true;
      }
    }
    releaseQueue();
    if (processLocks.get(key) === tail) processLocks.delete(key);
  }
  if (cleanupFailed) {
    if (primaryError instanceof MetadataExportError) primaryError.cleanupWarnings.push(LOCK_CLEANUP_WARNING);
    else if (primaryError instanceof Error) Object.assign(primaryError, { cleanupWarnings: [LOCK_CLEANUP_WARNING] });
    else if (result !== undefined) {
      const existing = "warnings" in result && Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === "string") : [];
      result = { ...result, warnings: [...existing, LOCK_CLEANUP_WARNING] };
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (result === undefined) throw new Error("Metadata operation returned no result");
  return result;
}

function mapSnapshotError(error: unknown): never {
  if (error instanceof Error && "code" in error && (error.code === "SOURCE_CHANGED" || error.code === "UNSAFE_METADATA_PATH")) {
    throw new MetadataExportError(error.code);
  }
  throw error;
}

export function createMetadataExportService(options: CreateMetadataExportServiceOptions): MetadataExportService {
  const now = options.now ?? Date.now;
  const ttl = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  const confirmations = new Map<string, InternalPlan>();

  return {
    async latest(context) {
      return withRootLock(options.appDataRoot, context.sourceRoot, async () => {
        const sourceRoot = await canonicalPath(context.sourceRoot);
        try {
          const canonicalAppDataRoot = await canonicalPath(options.appDataRoot);
          const pointer: unknown = JSON.parse(await readFile(join(canonicalAppDataRoot, "metadata-exports", "latest.json"), "utf8"));
          if (!isRecord(pointer) || typeof pointer.auditId !== "string" || !/^[0-9a-f]{32}$/u.test(pointer.auditId)) return { available: false };
          try {
            await readFile(join(canonicalAppDataRoot, "metadata-exports", pointer.auditId, "rolled-back.json"));
            return { available: false };
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return { available: false };
          }
          const manifest = parseAuditManifest(JSON.parse(await readFile(join(canonicalAppDataRoot, "metadata-exports", pointer.auditId, "audit.json"), "utf8")));
          if (manifest.albumId !== context.albumId || manifest.sourceRootHash !== stableDigest(sourceRoot)) return { available: false };
          return { available: true, auditId: manifest.id };
        } catch {
          return { available: false };
        }
      }, options.failureInjection);
    },
    async preview(context, _request?: Readonly<Record<string, never>>, operation: MetadataOperationOptions = {}) {
      return withRootLock(options.appDataRoot, context.sourceRoot, async () => {
      operation.signal?.throwIfAborted();
      for (const [id, confirmation] of confirmations) {
        const age = now() - confirmation.createdAtMs;
        if (age < 0 || age > ttl) confirmations.delete(id);
      }
      const built = await buildPlan(context, options.metadata, options.images, now(), operation);
      if (built.plan !== undefined) confirmations.set(built.plan.confirmationId, built.plan);
        return built.preview;
      }, options.failureInjection);
    },

    async commit(context, request, operation: MetadataOperationOptions = {}) {
      return withRootLock(options.appDataRoot, context.sourceRoot, async () => {
      operation.signal?.throwIfAborted();
      if (context.isDemo) throw new MetadataExportError("DEMO_EXPORT_DISABLED");
      if (request.lightroomSavedAndClosed !== true || typeof request.confirmationId !== "string") {
        throw new MetadataExportError("CONFIRMATION_REQUIRED");
      }
      const plan = confirmations.get(request.confirmationId);
      confirmations.delete(request.confirmationId);
      const confirmationAge = plan === undefined ? undefined : now() - plan.createdAtMs;
      if (plan === undefined || confirmationAge === undefined || confirmationAge < 0 || confirmationAge > ttl) {
        throw new MetadataExportError("CONFIRMATION_EXPIRED");
      }
      const sourceRoot = await canonicalPath(context.sourceRoot);
      const immutable = {
        albumId: plan.albumId,
        inventoryFingerprint: plan.inventoryFingerprint,
        sessionExportDigest: plan.sessionExportDigest,
        sourceRoot: plan.sourceRoot,
        skippedItems: plan.skippedItems,
        targets: plan.targets,
      };
      if (
        plan.albumId !== context.albumId ||
        plan.inventoryFingerprint !== context.session.inventoryFingerprint ||
        plan.sessionExportDigest !== sessionExportDigest(context) ||
        plan.sourceRoot !== sourceRoot ||
        plan.digest !== stableDigest(immutable)
      ) {
        throw new MetadataExportError("EXPORT_CONFLICT");
      }
      try {
        for (const target of plan.targets) for (const source of target.sourceSnapshots) await assertSnapshot(source);
      } catch (error) {
        mapSnapshotError(error);
      }
      const prepared: PreparedTarget[] = [];
      const installed: RecoveryOwnedTarget[] = [];
      const auditId = randomBytes(16).toString("hex");
      const canonicalAppDataRoot = await canonicalPath(options.appDataRoot);
      if (isSameOrInside(plan.sourceRoot, canonicalAppDataRoot)) throw new MetadataExportError("UNSAFE_METADATA_PATH");
      const auditRoot = join(canonicalAppDataRoot, "metadata-exports", auditId);
      const backupRoot = join(auditRoot, "backups");
      const auditEntries: AuditEntry[] = [];
      let stage = "preparation";
      try {
        await mkdir(auditRoot, { recursive: true, mode: 0o700 });
        for (const [index, target] of plan.targets.entries()) {
          operation.signal?.throwIfAborted();
          prepared.push(await prepareTarget(target, options.metadata, options.images, options.failureInjection, auditId));
          operation.onProgress?.({ phase: "writing", completed: index + 1, total: plan.targets.length, relativePath: target.label });
        }
        for (const target of plan.targets) for (const source of target.sourceSnapshots) await assertSnapshot(source);
        await mkdir(backupRoot, { recursive: true, mode: 0o700 });
        for (const [index, item] of prepared.entries()) {
          operation.signal?.throwIfAborted();
          const target = item.plan.snapshot.path;
          await assertLexicalRegularFile(target, !item.plan.snapshot.exists);
          for (const source of item.plan.sourceSnapshots) {
            await assertLexicalRegularFile(source.path, !source.exists);
          }
          await assertSnapshot(item.plan.snapshot);
          const backupName = item.plan.snapshot.exists ? `${index}${extname(target)}` : undefined;
          if (backupName !== undefined) {
            stage = "audit-backup-copy";
            await options.failureInjection?.("audit-backup-copy", { auditId, target });
            await copyFile(target, join(backupRoot, backupName));
          }
          await assertSnapshot(item.plan.snapshot);
          await assertLexicalRegularFile(target, !item.plan.snapshot.exists);
          stage = "original-rename";
          await options.failureInjection?.("before-original-rename", { auditId, target });
          if (item.plan.snapshot.exists) {
            await options.failureInjection?.("original-rename", { auditId, target });
            await rename(target, item.backupPath);
            installed.push({ ...item, concurrentTargetPreserved: false, createdTargetRemoved: false, hadOriginal: true, installed: false, retainBackup: false });
            await options.failureInjection?.("after-original-rename", { auditId, target });
            const renamed = await snapshotFile(item.backupPath);
            if (renamed.hash !== item.plan.snapshot.hash || renamed.size !== item.plan.snapshot.size) {
              stage = "stale-after-rename";
              const recovery = installed.at(-1)!;
              try {
                await restoreNoClobber(recovery, options.failureInjection, auditId);
                recovery.retainBackup = false;
                installed.pop();
              } catch {
                recovery.retainBackup = true;
                recovery.concurrentTargetPreserved = (await snapshotFile(target)).exists;
              }
              throw new MetadataExportError("SOURCE_CHANGED");
            }
          }
          try {
            stage = "install";
            await options.failureInjection?.("install", { auditId, target });
            await assertLexicalRegularFile(target, true);
            for (const source of item.plan.sourceSnapshots) {
              if (source.path !== target) await assertLexicalRegularFile(source.path, false);
            }
            await link(item.temporaryPath, target);
            if (item.plan.snapshot.exists) installed.at(-1)!.installed = true;
            else installed.push({ ...item, concurrentTargetPreserved: false, createdTargetRemoved: false, hadOriginal: false, installed: true, retainBackup: false });
            await unlink(item.temporaryPath);
          } catch (error) {
            if (!item.plan.snapshot.exists) {
              if (error instanceof Error && "code" in error && error.code === "EEXIST") {
                throw new MetadataExportError("RECOVERY_REQUIRED", error, {
                  auditRetained: true,
                  concurrentTargetPreserved: true,
                  createdTargetRemoved: false,
                  retainedBackup: false,
                });
              }
              throw error;
            }
            const recovery = installed.at(-1)!;
            if (error instanceof Error && "code" in error && error.code === "EEXIST") {
              recovery.retainBackup = true;
              recovery.concurrentTargetPreserved = true;
              throw new MetadataExportError("SOURCE_CHANGED", error);
            }
            if (recovery.installed) throw error;
            try {
              await restoreNoClobber(recovery, options.failureInjection, auditId);
              recovery.retainBackup = false;
              installed.pop();
            } catch (restoreError) {
              recovery.retainBackup = true;
              recovery.concurrentTargetPreserved = (await snapshotFile(target)).exists;
              throw new AggregateError([error, restoreError], "Metadata install and restore both failed");
            }
            throw error;
          }
          await verifyTarget(item.plan, target, options.metadata, options.images);
          const post = await snapshotFile(target);
          const { path: _redactedPath, ...redactedPost } = post;
          const { path: _redactedPrePath, ...redactedPre } = item.plan.snapshot;
          void _redactedPath;
          void _redactedPrePath;
          auditEntries.push({
            ...(backupName === undefined ? {} : { backupName }),
            created: !item.plan.snapshot.exists,
            kind: item.plan.kind,
            ...(item.plan.snapshot.mode === undefined ? {} : { mode: item.plan.snapshot.mode }),
            pre: redactedPre,
            post: redactedPost,
            protectedMetadataHash: stableDigest(normalizeProtectedMetadata(await options.metadata.readRaw(target))),
            rating: item.plan.rating,
            relativePath: item.plan.label,
          });
        }
        for (const [index, item] of installed.entries()) {
          operation.signal?.throwIfAborted();
          await verifyTarget(item.plan, item.plan.snapshot.path, options.metadata, options.images);
          operation.onProgress?.({ phase: "verifying", completed: index + 1, total: installed.length, relativePath: item.plan.label });
        }
        const manifest: AuditManifest = {
          albumId: plan.albumId,
          completedAt: new Date(now()).toISOString(),
          entries: auditEntries,
          id: auditId,
          sourceRootHash: stableDigest(plan.sourceRoot),
        };
        operation.signal?.throwIfAborted();
        await atomicWriteJson(join(auditRoot, "audit.json"), manifest);
        operation.signal?.throwIfAborted();
        stage = "latest-publication";
        await options.failureInjection?.("latest-publication", { auditId });
        await atomicWriteJson(
          join(canonicalAppDataRoot, "metadata-exports", "latest.json"),
          { albumId: manifest.albumId, auditId: manifest.id, sourceRootHash: manifest.sourceRootHash },
        );
        const warnings: string[] = [];
        for (const item of installed) {
          try {
            await options.failureInjection?.("cleanup", { auditId, target: item.backupPath });
            await rm(item.backupPath, { force: true });
          } catch {
            item.retainBackup = true;
            warnings.push("导出已成功，但清理事务备份失败；已保留文件供支持人员检查。");
          }
        }
        return {
          auditId,
          conflicts: 0,
          errors: 0,
          items: [
            ...plan.targets.map((item) => ({ id: item.id, label: item.label, status: "written" as const })),
            ...plan.skippedItems.map((item) => ({ id: item.id, label: item.label, status: "skipped" as const })),
          ],
          skipped: plan.skippedItems.length,
          ...(warnings.length === 0 ? {} : { warnings }),
          written: plan.targets.length,
        };
      } catch (error) {
        const recoveryFailures = await reverseInstalled(installed, options.failureInjection, auditId);
        for (const item of prepared) {
          await rm(item.temporaryPath, { force: true }).catch(() => undefined);
        }
        const retainedBackup = installed.some((item) => item.retainBackup);
        const inheritedRecovery = error instanceof MetadataExportError ? error.recovery : undefined;
        const createdTargetRemoved = inheritedRecovery?.createdTargetRemoved ?? installed.some((item) => item.createdTargetRemoved);
        const concurrentTargetPreserved = inheritedRecovery?.concurrentTargetPreserved ?? installed.some((item) => item.concurrentTargetPreserved);
        const recovery = recoveryFailures.length > 0 || error instanceof AggregateError ? "failed" : retainedBackup ? "retained" : "completed";
        const failedAudit = {
          id: auditId,
          items: plan.targets.map((item) => ({ label: item.label })),
          recovery,
          retainedBackup,
          concurrentTargetPreserved,
          createdTargetRemoved,
          stage,
        };
        let auditRetained = false;
        try {
          await options.failureInjection?.("failed-audit-publication", { auditId });
          await atomicWriteJson(join(auditRoot, "failed.json"), failedAudit);
          auditRetained = true;
        } catch {
          try {
            await options.failureInjection?.("failed-audit-fallback-publication", { auditId });
            await atomicWriteJson(join(auditRoot, "failed-fallback.json"), failedAudit);
            auditRetained = true;
          } catch {
            auditRetained = false;
          }
        }
        for (const item of prepared) {
          const owner = installed.find((candidate) => candidate.backupPath === item.backupPath);
          if (owner?.retainBackup !== true) await rm(item.backupPath, { force: true }).catch(() => undefined);
        }
        const recoveryOutcome: MetadataRecoveryOutcome = {
          auditRetained,
          concurrentTargetPreserved,
          createdTargetRemoved,
          retainedBackup,
        };
        if (!auditRetained) {
          throw new MetadataExportError("AUDIT_PERSIST_FAILED", error, recoveryOutcome);
        }
        if (recoveryFailures.length > 0) {
          throw new MetadataExportError("RECOVERY_REQUIRED", new AggregateError([error, ...recoveryFailures], "Metadata transaction recovery failed"), recoveryOutcome);
        }
        if (retainedBackup) {
          throw new MetadataExportError("RECOVERY_REQUIRED", error, recoveryOutcome);
        }
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof MetadataExportError && error.code === "RECOVERY_REQUIRED") throw new MetadataExportError("RECOVERY_REQUIRED", error, recoveryOutcome);
        if (error instanceof MetadataExportError) throw error;
        if (error instanceof Error && "code" in error && error.code === "SOURCE_CHANGED") throw new MetadataExportError("SOURCE_CHANGED", error);
        throw new MetadataExportError("PAIR_VERIFY_FAILED", error);
      }
      }, options.failureInjection);
    },

    async rollback(context) {
      return withRootLock(options.appDataRoot, context.sourceRoot, async () => {
      let audit: { manifest: AuditManifest; root: string } | undefined;
      const canonicalAppDataRoot = await canonicalPath(options.appDataRoot);
        try {
          const pointer: unknown = JSON.parse(await readFile(join(canonicalAppDataRoot, "metadata-exports", "latest.json"), "utf8"));
          if (!isRecord(pointer) ||
            typeof pointer.albumId !== "string" ||
            typeof pointer.auditId !== "string" || !/^[0-9a-f]{32}$/u.test(pointer.auditId) ||
            typeof pointer.sourceRootHash !== "string" || !/^[0-9a-f]{64}$/u.test(pointer.sourceRootHash)
          ) {
            throw new Error("Invalid latest export pointer");
          }
          const manifest = parseAuditManifest(JSON.parse(await readFile(join(canonicalAppDataRoot, "metadata-exports", pointer.auditId, "audit.json"), "utf8")));
          try {
            await readFile(join(canonicalAppDataRoot, "metadata-exports", pointer.auditId, "rolled-back.json"));
            throw new Error("Export was already rolled back");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
          const sourceRoot = await canonicalPath(context.sourceRoot);
          if (
            manifest.id !== pointer.auditId ||
            manifest.albumId !== pointer.albumId ||
            manifest.sourceRootHash !== pointer.sourceRootHash ||
            manifest.albumId !== context.albumId ||
            manifest.sourceRootHash !== stableDigest(sourceRoot)
          ) {
            throw new Error("Audit does not match active album");
          }
          audit = { manifest, root: sourceRoot };
        } catch {
          throw new MetadataExportError("ROLLBACK_NOT_FOUND");
        }
      if (audit === undefined || audit.manifest.albumId !== context.albumId) throw new MetadataExportError("ROLLBACK_NOT_FOUND");
      if (await canonicalPath(context.sourceRoot) !== audit.root) throw new MetadataExportError("ROLLBACK_STALE");
      for (const entry of audit.manifest.entries) {
        const target = (await assertContained(audit.root, join(audit.root, entry.relativePath))).path;
        const current = await snapshotFile(target);
        if (current.hash !== entry.post.hash || current.size !== entry.post.size || current.modifiedAtMs !== entry.post.modifiedAtMs) {
          throw new MetadataExportError("ROLLBACK_STALE");
        }
        const tags = await options.metadata.readRaw(target);
        if (metadataRating(tags) !== entry.rating || stableDigest(normalizeProtectedMetadata(tags)) !== entry.protectedMetadataHash) {
          throw new MetadataExportError("ROLLBACK_STALE");
        }
      }
      const preparedRollback: Array<{ entry: AuditEntry; target: string; temporary?: string; exportedBackup: string; installed: boolean; retainBackup: boolean; concurrentTargetPreserved: boolean }> = [];
      try {
        for (const entry of [...audit.manifest.entries].reverse()) {
          const target = (await assertContained(audit.root, join(audit.root, entry.relativePath))).path;
          const exportedBackup = siblingPath(target, "backup");
          if (entry.created) {
            preparedRollback.push({ entry, target, exportedBackup, installed: false, retainBackup: false, concurrentTargetPreserved: false });
            continue;
          }
          const backup = join(canonicalAppDataRoot, "metadata-exports", audit.manifest.id, "backups", entry.backupName!);
          const backupSnapshot = await snapshotFile(backup);
          if (!backupSnapshot.exists || backupSnapshot.hash !== entry.pre.hash || backupSnapshot.size !== entry.pre.size) {
            throw new MetadataExportError("ROLLBACK_STALE");
          }
          const temporary = siblingPath(target, "tmp");
          await copyFile(backup, temporary);
          if (entry.mode !== undefined) await chmod(temporary, entry.mode);
          const preparedSnapshot = await snapshotFile(temporary);
          if (preparedSnapshot.hash !== entry.pre.hash || preparedSnapshot.size !== entry.pre.size) {
            throw new MetadataExportError("ROLLBACK_STALE");
          }
          preparedRollback.push({ entry, target, temporary, exportedBackup, installed: false, retainBackup: false, concurrentTargetPreserved: false });
        }
      } catch (error) {
        for (const prepared of preparedRollback) {
          if (prepared.temporary !== undefined) await rm(prepared.temporary, { force: true }).catch(() => undefined);
        }
        throw error;
      }
      const applied: typeof preparedRollback = [];
      try {
        for (const prepared of preparedRollback) {
          const expected = await snapshotFile(prepared.target);
          if (expected.hash !== prepared.entry.post.hash || expected.size !== prepared.entry.post.size || expected.modifiedAtMs !== prepared.entry.post.modifiedAtMs) {
            throw new MetadataExportError("ROLLBACK_STALE");
          }
          await rename(prepared.target, prepared.exportedBackup);
          applied.push(prepared);
          const renamed = await snapshotFile(prepared.exportedBackup);
          if (renamed.hash !== prepared.entry.post.hash || renamed.size !== prepared.entry.post.size) {
            try {
              await link(prepared.exportedBackup, prepared.target);
              await unlink(prepared.exportedBackup);
              applied.pop();
            } catch {
              prepared.retainBackup = true;
            }
            throw new MetadataExportError("ROLLBACK_STALE");
          }
          await options.failureInjection?.("rollback-install", { auditId: audit.manifest.id, target: prepared.target });
          if (!prepared.entry.created) {
            await link(prepared.temporary!, prepared.target);
            prepared.installed = true;
            await unlink(prepared.temporary!);
          }
        }
        for (const prepared of preparedRollback) {
          if (prepared.entry.created) {
            const current = await snapshotFile(prepared.target);
            if (current.exists) throw new MetadataExportError("ROLLBACK_STALE");
          } else {
            const current = await snapshotFile(prepared.target);
            if (current.hash !== prepared.entry.pre.hash || current.size !== prepared.entry.pre.size) {
              throw new MetadataExportError("ROLLBACK_STALE");
            }
          }
        }
      } catch (error) {
        const recoveryFailures: unknown[] = [];
        for (const prepared of [...applied].reverse()) {
          try {
            if (prepared.installed) {
              const current = await snapshotFile(prepared.target);
              if (current.hash !== prepared.entry.pre.hash || current.size !== prepared.entry.pre.size) {
                prepared.retainBackup = true;
                prepared.concurrentTargetPreserved = current.exists;
                throw new Error("Rollback target changed before recovery");
              }
              await unlink(prepared.target);
              prepared.installed = false;
            }
            await options.failureInjection?.("rollback-restore", { auditId: audit.manifest.id, target: prepared.target });
            await link(prepared.exportedBackup, prepared.target);
            await unlink(prepared.exportedBackup);
          } catch (recoveryError) {
            prepared.retainBackup = true;
            const current = await snapshotFile(prepared.target).catch(() => undefined);
            if (prepared.concurrentTargetPreserved !== true && prepared.installed === false && current?.exists === true) {
              prepared.concurrentTargetPreserved = true;
            }
            recoveryFailures.push(recoveryError);
          }
        }
        const rollbackFailureId = randomBytes(16).toString("hex");
        const rollbackFailedAudit = {
          id: rollbackFailureId,
          items: applied.map((item) => ({ label: item.entry.relativePath.split(/[/\\]/u).join("/") })),
          recovery: recoveryFailures.length > 0 ? "failed" : "completed",
          retainedBackup: applied.some((item) => item.retainBackup),
          concurrentTargetPreserved: applied.some((item) => item.concurrentTargetPreserved),
          createdTargetRemoved: false,
          stage: "rollback-install",
        };
        let auditRetained = false;
        try {
          await options.failureInjection?.("failed-audit-publication", { auditId: rollbackFailureId });
          await atomicWriteJson(join(canonicalAppDataRoot, "metadata-exports", audit.manifest.id, `rollback-failed-${rollbackFailureId}.json`), rollbackFailedAudit);
          auditRetained = true;
        } catch {
          try {
            await options.failureInjection?.("failed-audit-fallback-publication", { auditId: rollbackFailureId });
            await atomicWriteJson(join(canonicalAppDataRoot, "metadata-exports", audit.manifest.id, `rollback-failed-fallback-${rollbackFailureId}.json`), rollbackFailedAudit);
            auditRetained = true;
          } catch {
            auditRetained = false;
          }
        }
        const retainedBackup = applied.some((item) => item.retainBackup);
        const recoveryOutcome: MetadataRecoveryOutcome = {
          auditRetained,
          concurrentTargetPreserved: applied.some((item) => item.concurrentTargetPreserved),
          createdTargetRemoved: false,
          retainedBackup,
        };
        if (!auditRetained) throw new MetadataExportError("AUDIT_PERSIST_FAILED", error, recoveryOutcome);
        if (recoveryFailures.length > 0) {
          throw new MetadataExportError("RECOVERY_REQUIRED", new AggregateError([error, ...recoveryFailures], "Rollback recovery failed"), recoveryOutcome);
        }
        throw error;
      } finally {
        for (const prepared of preparedRollback) {
          if (prepared.temporary !== undefined) await rm(prepared.temporary, { force: true }).catch(() => undefined);
        }
      }
      const warnings: string[] = [];
      for (const prepared of preparedRollback) {
        try {
          await options.failureInjection?.("cleanup", { auditId: audit.manifest.id, target: prepared.exportedBackup });
          await rm(prepared.exportedBackup, { force: true });
        } catch {
          warnings.push("回滚已成功，但清理事务备份失败；已保留文件供支持人员检查。");
        }
      }
      const restored = preparedRollback.map((prepared, index) => ({ id: `rollback-${index}`, label: prepared.entry.relativePath.split(/[/\\]/u).join("/"), status: "rolled-back" as const }));
      try {
        await atomicWriteJson(join(canonicalAppDataRoot, "metadata-exports", audit.manifest.id, "rolled-back.json"), {
          auditId: audit.manifest.id,
          completedAt: new Date(now()).toISOString(),
        });
      } catch {
        warnings.push("回滚已成功，但发布完成标记失败；已保留审计文件供支持人员检查。");
      }
      try {
        await options.failureInjection?.("cleanup", { auditId: audit.manifest.id, target: "latest.json" });
        await rm(join(canonicalAppDataRoot, "metadata-exports", "latest.json"), { force: true });
      } catch {
        warnings.push("回滚已成功，但清理最近导出标记失败；请保留审计文件供支持人员检查。");
      }
      return { auditId: audit.manifest.id, conflicts: 0, errors: 0, items: restored, skipped: 0, ...(warnings.length === 0 ? {} : { warnings }), written: 0 };
      }, options.failureInjection);
    },
  };
}

export async function previewMetadataExport(
  service: ReturnType<typeof createMetadataExportService>,
  context: ExportContext,
): Promise<MetadataExportPreview> {
  return service.preview(context, {});
}

export async function commitMetadataExport(
  service: ReturnType<typeof createMetadataExportService>,
  context: ExportContext,
  confirmation: { confirmationId: string; lightroomSavedAndClosed: true },
): Promise<MetadataExportResult> {
  return service.commit(context, confirmation);
}

export async function rollbackMetadataExport(
  service: ReturnType<typeof createMetadataExportService>,
  context: ExportContext,
): Promise<MetadataExportResult> {
  return service.rollback(context, {});
}
