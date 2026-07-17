import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rmdir, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Rating, SourceFile } from "../../shared/domain.js";
import type { ExportContext } from "../app.js";

const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_CONFIRMATIONS = 128;
const PROPRIETARY_RAW = new Set([".arw", ".cr2", ".cr3", ".nef", ".raf", ".rw2", ".orf"]);

export type CopyPreviewStatus = "copy" | "skip" | "conflict";
export type CopyResultStatus = "copied" | "skipped" | "conflict" | "failed";

export interface CopyExportPreviewItem {
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly status: CopyPreviewStatus;
  readonly generated: boolean;
}

export interface CopyExportPreview {
  readonly confirmationId?: string;
  readonly isDemo: boolean;
  readonly items: CopyExportPreviewItem[];
  readonly counts: { readonly copy: number; readonly skip: number; readonly conflicts: number };
  readonly totalBytes: number;
  readonly requiredBytes: number;
  readonly freeBytes?: number;
}

export interface CopyExportReportItem {
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly status: CopyResultStatus;
}

export interface CopyExportReport {
  readonly reportId: string;
  readonly albumId: string;
  readonly completedAt: string;
  readonly cancelled: boolean;
  readonly counts: { readonly copied: number; readonly skipped: number; readonly conflicts: number; readonly failed: number };
  readonly items: CopyExportReportItem[];
}

export interface CopyExportProgress {
  readonly completed: number;
  readonly total: number;
  readonly bytesCompleted: number;
  readonly totalBytes: number;
  readonly relativePath?: string;
  readonly status?: CopyResultStatus;
}

export class CopyExportError extends Error {
  readonly code: "CONFIRMATION_EXPIRED" | "CONFIRMATION_REQUIRED" | "DEMO_EXPORT_DISABLED" | "EXPORT_LOCKED" | "RECOVERY_REQUIRED" | "REPORT_NOT_FOUND" | "SOURCE_CHANGED" | "UNSAFE_COPY_PATH";
  readonly recoveryLabel: string | undefined;
  constructor(code: CopyExportError["code"], cause?: unknown, recoveryLabel?: string) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "CopyExportError";
    this.code = code;
    this.recoveryLabel = recoveryLabel;
  }
}

interface Snapshot {
  readonly exists: boolean;
  readonly path: string;
  readonly size?: number;
  readonly modifiedAtMs?: number;
  readonly sha256?: string;
}

interface PlannedItem extends CopyExportPreviewItem {
  readonly sourcePath?: string;
  readonly generatedContents?: Buffer;
  readonly source: Snapshot;
  readonly destination: Snapshot;
  readonly destinationPath: string;
}

interface Plan {
  readonly albumId: string;
  readonly confirmationId: string;
  readonly createdAtMs: number;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly destinationRootIdentity: DirectoryIdentity;
  readonly inventoryFingerprint: string;
  readonly ratingDigest: string;
  readonly items: readonly PlannedItem[];
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface PinnedDirectory extends DirectoryIdentity {
  readonly handle: FileHandle;
}

interface OwnedFile {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly handle: FileHandle;
}

type SyncStage = "app-data-root-sync" | "destination-parent-sync" | "destination-root-sync" | "final-parent-sync" | "report-directory-sync" | "staging-directory-sync";
type FailureStage = "before-copy" | "after-copy" | "before-install" | "after-install" | "before-create" | "before-link" | "after-link" | "cleanup" | "job-cleanup" | SyncStage;
interface FailureDetail { readonly relativePath: string; readonly temporaryPath?: string; readonly operation?: string }

export interface CreateCopyExportServiceOptions {
  readonly appDataRoot: string;
  readonly confirmationTtlMs?: number;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly failureInjection?: (stage: FailureStage, detail: FailureDetail) => void | Promise<void>;
}

export interface CopyExportServiceBoundary {
  preview(context: ExportContext, request: { readonly destinationRoot: string; readonly minRating: number }, operation?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: { readonly completed: number; readonly total: number; readonly relativePath?: string }) => void }): Promise<CopyExportPreview>;
  commit(context: ExportContext, request: { readonly confirmationId: string; readonly signal?: AbortSignal; readonly onProgress?: (progress: CopyExportProgress) => void }): Promise<CopyExportReport>;
  report(reportId: string): Promise<CopyExportReport>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function hash(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function safeRelativePath(value: string): boolean {
  if (value === "" || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function canonicalRoot(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const details = await lstat(canonical);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new CopyExportError("UNSAFE_COPY_PATH");
  return canonical;
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const pinned = await pinDirectory(path);
  try { return { path: pinned.path, dev: pinned.dev, ino: pinned.ino }; }
  finally { await pinned.handle.close(); }
}

function sameInode(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function pinDirectory(path: string, containmentRoot?: string): Promise<PinnedDirectory> {
  const canonical = await realpath(resolve(path));
  if (containmentRoot !== undefined && !contained(containmentRoot, canonical)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const lexical = await lstat(path);
  if (lexical.isSymbolicLink() || !lexical.isDirectory() || !sameInode(lexical, await lstat(canonical))) throw new CopyExportError("UNSAFE_COPY_PATH");
  const directoryFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(canonical, directoryFlags);
  try {
    const opened = await handle.stat();
    const current = await lstat(canonical);
    if (!opened.isDirectory() || !sameInode(opened, lexical) || !sameInode(current, lexical)) throw new CopyExportError("UNSAFE_COPY_PATH");
    return { path: canonical, dev: opened.dev, ino: opened.ino, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function revalidatePinned(directory: PinnedDirectory, containmentRoot?: string): Promise<void> {
  const opened = await directory.handle.stat();
  if (!opened.isDirectory() || !sameInode(opened, directory)) throw new CopyExportError("RECOVERY_REQUIRED");
  const lexical = await lstat(directory.path).catch((error: unknown) => {
    throw new CopyExportError("RECOVERY_REQUIRED", error);
  });
  const canonical = await realpath(directory.path).catch((error: unknown) => {
    throw new CopyExportError("RECOVERY_REQUIRED", error);
  });
  if (lexical.isSymbolicLink() || !lexical.isDirectory() || canonical !== directory.path || !sameInode(lexical, directory) || (containmentRoot !== undefined && !contained(containmentRoot, canonical))) {
    throw new CopyExportError("RECOVERY_REQUIRED");
  }
}

async function revalidateFor(directory: PinnedDirectory, relativePath: string, containmentRoot?: string): Promise<void> {
  await revalidatePinned(directory, containmentRoot).catch((error: unknown) => {
    throw new CopyExportError("RECOVERY_REQUIRED", error, relativePath);
  });
}

async function syncEntryOwner(owner: PinnedDirectory, root: PinnedDirectory, stage: SyncStage, options: CreateCopyExportServiceOptions, relativePath: string, operation: string): Promise<void> {
  await revalidateFor(root, relativePath);
  await revalidateFor(owner, relativePath, root.path);
  await options.failureInjection?.(stage, { relativePath, operation });
  await owner.handle.sync();
  await revalidateFor(owner, relativePath, root.path);
  await revalidateFor(root, relativePath);
}

async function createOwnedFile(parent: PinnedDirectory, prefix: string): Promise<OwnedFile> {
  await revalidatePinned(parent);
  for (;;) {
    const path = join(parent.path, `${prefix}-${randomBytes(8).toString("hex")}.tmp`);
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        const details = await handle.stat();
        if (!details.isFile()) throw new CopyExportError("RECOVERY_REQUIRED");
        await revalidatePinned(parent);
        const lexical = await lstat(path);
        if (lexical.isSymbolicLink() || !sameInode(lexical, details)) throw new CopyExportError("RECOVERY_REQUIRED");
        return { path, dev: details.dev, ino: details.ino, handle };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
}

async function copyIntoHandle(sourcePath: string, destination: FileHandle): Promise<void> {
  const source = await open(sourcePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
  } finally { await source.close(); }
}

async function ownedAtPath(owned: OwnedFile): Promise<boolean> {
  try {
    const details = await lstat(owned.path);
    return !details.isSymbolicLink() && details.isFile() && sameInode(details, owned);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function cleanupOwned(owned: OwnedFile, parent: PinnedDirectory, root: PinnedDirectory, options: CreateCopyExportServiceOptions, relativePath: string, syncStage: SyncStage, operation: string): Promise<void> {
  await revalidatePinned(parent).catch((error: unknown) => { throw new CopyExportError("RECOVERY_REQUIRED", error, relativePath); });
  const current = await lstat(owned.path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (current === undefined) return;
  if (current.isSymbolicLink() || !sameInode(current, owned)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, relativePath);
  await unlink(owned.path);
  await revalidatePinned(parent).catch((error: unknown) => { throw new CopyExportError("RECOVERY_REQUIRED", error, relativePath); });
  await syncEntryOwner(parent, root, syncStage, options, relativePath, operation);
}

async function removePinnedDirectory(directory: PinnedDirectory, root: PinnedDirectory, options: CreateCopyExportServiceOptions, relativePath: string): Promise<void> {
  await revalidateFor(root, relativePath);
  await revalidateFor(directory, relativePath, root.path);
  const current = await lstat(directory.path);
  if (current.isSymbolicLink() || !sameInode(current, directory)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, relativePath);
  await rmdir(directory.path);
  await revalidateFor(root, relativePath);
  const opened = await directory.handle.stat();
  if (!sameInode(opened, directory)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, relativePath);
  try {
    await lstat(directory.path);
    throw new CopyExportError("RECOVERY_REQUIRED", undefined, relativePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await syncEntryOwner(root, root, "destination-root-sync", options, relativePath, "staging-rmdir");
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const lexical = await lstat(path);
    if (lexical.isSymbolicLink()) throw new CopyExportError("UNSAFE_COPY_PATH");
    const canonical = await realpath(path);
    const details = lexical;
    if (!details.isFile() || details.isSymbolicLink()) throw new CopyExportError("UNSAFE_COPY_PATH");
    return { exists: true, path: canonical, size: details.size, modifiedAtMs: details.mtimeMs, sha256: await hashFile(canonical) };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return { exists: false, path: resolve(path) };
  }
}

async function assertSafeDestinationAncestors(root: string, target: string): Promise<void> {
  if (!contained(root, target)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const child = relative(root, dirname(target));
  let cursor = root;
  for (const segment of child === "" ? [] : child.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink() || !details.isDirectory()) throw new CopyExportError("UNSAFE_COPY_PATH");
      const canonical = await realpath(cursor);
      if (!contained(root, canonical)) throw new CopyExportError("UNSAFE_COPY_PATH");
    } catch (error) {
      if (errorCode(error) === "ENOENT") break;
      throw error;
    }
  }
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return left.exists === right.exists && left.path === right.path && (!left.exists || (left.size === right.size && left.modifiedAtMs === right.modifiedAtMs && left.sha256 === right.sha256));
}

function generatedXmp(rating: Rating): Buffer {
  return Buffer.from(`<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="BurstPick"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${rating}"/></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>\n`);
}

function ratingDigest(context: ExportContext): string {
  return hash(JSON.stringify(context.session.photos.map(({ id, rating }) => [id, rating])));
}

async function discoverXmp(raw: SourceFile): Promise<string | undefined> {
  const directory = dirname(raw.path);
  const target = `${basename(raw.path, extname(raw.path))}.xmp`.toLocaleLowerCase("en-US");
  const names = await readdir(directory);
  const matches = names.filter((name) => name.toLocaleLowerCase("en-US") === target).sort();
  return matches[0] === undefined ? undefined : join(directory, matches[0]);
}

function relativeXmp(raw: SourceFile): string {
  return `${raw.relativePath.slice(0, -extname(raw.relativePath).length)}.xmp`;
}

async function planSource(sourceRoot: string, destinationRoot: string, source: SourceFile, relativePath = source.relativePath): Promise<PlannedItem> {
  if (!safeRelativePath(relativePath)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const sourceSnapshot = await snapshot(source.path);
  if (!sourceSnapshot.exists || !contained(sourceRoot, sourceSnapshot.path)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const expectedSource = resolve(sourceRoot, ...source.relativePath.split("/"));
  if (sourceSnapshot.path !== await realpath(expectedSource)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const destinationPath = resolve(destinationRoot, ...relativePath.split("/"));
  if (!contained(destinationRoot, destinationPath)) throw new CopyExportError("UNSAFE_COPY_PATH");
  await assertSafeDestinationAncestors(destinationRoot, destinationPath);
  const destination = await snapshot(destinationPath);
  if (destination.exists && !contained(destinationRoot, destination.path)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const status: CopyPreviewStatus = !destination.exists ? "copy" : destination.size === sourceSnapshot.size && destination.sha256 === sourceSnapshot.sha256 ? "skip" : "conflict";
  return { relativePath, size: sourceSnapshot.size!, sha256: sourceSnapshot.sha256!, status, generated: false, sourcePath: sourceSnapshot.path, source: sourceSnapshot, destination, destinationPath };
}

async function planGenerated(destinationRoot: string, relativePath: string, contents: Buffer): Promise<PlannedItem> {
  if (!safeRelativePath(relativePath)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const destinationPath = resolve(destinationRoot, ...relativePath.split("/"));
  if (!contained(destinationRoot, destinationPath)) throw new CopyExportError("UNSAFE_COPY_PATH");
  await assertSafeDestinationAncestors(destinationRoot, destinationPath);
  const destination = await snapshot(destinationPath);
  if (destination.exists && !contained(destinationRoot, destination.path)) throw new CopyExportError("UNSAFE_COPY_PATH");
  const sha256 = hash(contents);
  const status: CopyPreviewStatus = !destination.exists ? "copy" : destination.size === contents.length && destination.sha256 === sha256 ? "skip" : "conflict";
  return { relativePath, size: contents.length, sha256, status, generated: true, generatedContents: contents, source: { exists: false, path: "generated" }, destination, destinationPath };
}

async function ensureSafeParent(root: PinnedDirectory, path: string, options: CreateCopyExportServiceOptions, relativePath: string): Promise<PinnedDirectory> {
  if (!contained(root.path, path)) throw new CopyExportError("UNSAFE_COPY_PATH");
  await assertSafeDestinationAncestors(root.path, path);
  const parentRelative = relative(root.path, dirname(path));
  let cursor = await pinDirectory(root.path);
  if (!sameInode(cursor, root)) {
    await cursor.handle.close();
    throw new CopyExportError("RECOVERY_REQUIRED", undefined, relativePath);
  }
  let built = "";
  try {
    for (const segment of parentRelative === "" ? [] : parentRelative.split(sep)) {
      built = built === "" ? segment : join(built, segment);
      const childPath = join(cursor.path, segment);
      let child: PinnedDirectory | undefined;
      try {
        child = await pinDirectory(childPath, root.path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        await revalidateFor(root, relativePath);
        await revalidateFor(cursor, relativePath, root.path);
        await mkdir(childPath);
        await revalidateFor(root, relativePath);
        await revalidateFor(cursor, relativePath, root.path);
        child = await pinDirectory(childPath, root.path);
        try { await syncEntryOwner(cursor, root, "destination-parent-sync", options, relativePath, `parent-create:${built.split(sep).join("/")}`); }
        catch (error) {
          await child.handle.close().catch(() => undefined);
          throw error;
        }
      }
      await cursor.handle.close();
      cursor = child;
    }
    await revalidateFor(root, relativePath);
    await revalidateFor(cursor, relativePath, root.path);
    return cursor;
  } catch (error) {
    await cursor.handle.close().catch(() => undefined);
    throw error;
  }
}

async function persistReport(appDataRoot: string, report: CopyExportReport, options: CreateCopyExportServiceOptions): Promise<void> {
  const directory = join(appDataRoot, "copy-exports");
  const appRoot = await pinDirectory(appDataRoot);
  let pinned: PinnedDirectory | undefined;
  try {
    try { pinned = await pinDirectory(directory, appRoot.path); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await revalidateFor(appRoot, "copy-report");
      await mkdir(directory);
      await revalidateFor(appRoot, "copy-report");
      pinned = await pinDirectory(directory, appRoot.path);
      await syncEntryOwner(appRoot, appRoot, "app-data-root-sync", options, "copy-report", "report-directory-create");
    }
  } catch (error) {
    await appRoot.handle.close().catch(() => undefined);
    await pinned?.handle.close().catch(() => undefined);
    throw error;
  }
  const target = join(directory, `${report.reportId}.json`);
  let temporary: OwnedFile | undefined;
  try {
    temporary = await createOwnedFile(pinned, `.${report.reportId}`);
    await syncEntryOwner(pinned, pinned, "report-directory-sync", options, "copy-report", "report-temporary-create");
    await temporary.handle.writeFile(`${JSON.stringify(report, undefined, 2)}\n`);
    await temporary.handle.sync();
    await revalidatePinned(pinned);
    if (!await ownedAtPath(temporary)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, "copy-report");
    await link(temporary.path, target);
    await syncEntryOwner(pinned, pinned, "report-directory-sync", options, "copy-report", "report-link");
    await revalidatePinned(pinned);
    const installed = await lstat(target);
    if (installed.isSymbolicLink() || !sameInode(installed, temporary)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, "copy-report");
    await cleanupOwned(temporary, pinned, pinned, options, "copy-report", "report-directory-sync", "report-temporary-unlink");
    await temporary.handle.close();
    temporary = undefined;
  } finally {
    let cleanupError: unknown;
    if (temporary !== undefined) {
      try { await cleanupOwned(temporary, pinned, pinned, options, "copy-report", "report-directory-sync", "report-temporary-unlink"); }
      catch (error) { cleanupError = error; }
      await temporary.handle.close().catch(() => undefined);
    }
    await pinned.handle.close().catch(() => undefined);
    await appRoot.handle.close().catch(() => undefined);
    if (cleanupError !== undefined) throw cleanupError;
  }
}

export function createCopyExportService(options: CreateCopyExportServiceOptions): CopyExportServiceBoundary {
  const confirmations = new Map<string, Plan>();
  const activeAlbums = new Set<string>();
  const now = options.now ?? Date.now;
  const ttl = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  const platform = options.platform ?? process.platform;
  const appDataRoot = resolve(options.appDataRoot);

  return {
    async preview(context, request, operation) {
      for (const [id, plan] of confirmations) if (now() - plan.createdAtMs > ttl) confirmations.delete(id);
      while (confirmations.size >= MAX_CONFIRMATIONS) {
        const oldest = confirmations.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        confirmations.delete(oldest);
      }
      if (context.isDemo) {
        const items = context.session.photos.filter(({ rating }) => rating >= request.minRating).flatMap((photo) => [photo.raw, photo.jpeg, photo.xmp].filter((item): item is SourceFile => item !== undefined).map((item) => ({ relativePath: item.relativePath, size: item.size, sha256: hash(`demo:${item.relativePath}:${item.size}`), status: "copy" as const, generated: false })));
        return { isDemo: true, items, counts: { copy: items.length, skip: 0, conflicts: 0 }, totalBytes: items.reduce((sum, item) => sum + item.size, 0), requiredBytes: items.reduce((sum, item) => sum + item.size, 0) };
      }
      const [sourceRoot, destinationRoot] = await Promise.all([canonicalRoot(context.sourceRoot), canonicalRoot(request.destinationRoot)]);
      const fold = (value: string) => platform === "darwin" ? value.normalize("NFC").toLocaleLowerCase("en-US") : value;
      const foldedSource = fold(sourceRoot);
      const foldedDestination = fold(destinationRoot);
      if (foldedSource === foldedDestination || contained(foldedSource, foldedDestination) || contained(foldedDestination, foldedSource)) throw new CopyExportError("UNSAFE_COPY_PATH");
      const byTarget = new Map<string, PlannedItem>();
      const caseTargets = new Map<string, string>();
      const selectedPhotos = context.session.photos.filter((photo) => photo.rating >= request.minRating);
      let completed = 0;
      operation?.onProgress?.({ completed, total: selectedPhotos.length });
      for (const photo of selectedPhotos) {
        if (operation?.signal?.aborted) throw new DOMException("copy preview cancelled", "AbortError");
        for (const source of [photo.raw, photo.jpeg].filter((item): item is NonNullable<typeof item> => item !== undefined)) {
          const planned = await planSource(sourceRoot, destinationRoot, source);
          if (!byTarget.has(planned.relativePath)) byTarget.set(planned.relativePath, planned);
        }
        const existingXmp = photo.xmp?.path ?? (photo.raw === undefined ? undefined : await discoverXmp(photo.raw));
        if (existingXmp !== undefined) {
          const canonicalExistingXmp = await realpath(existingXmp);
          const relativePath = photo.xmp?.relativePath ?? relative(sourceRoot, canonicalExistingXmp).split(sep).join("/");
          const details = await lstat(canonicalExistingXmp);
          const source: SourceFile = photo.xmp ?? { kind: "xmp", path: canonicalExistingXmp, relativePath, size: details.size, modifiedAtMs: details.mtimeMs };
          const planned = await planSource(sourceRoot, destinationRoot, source, relativePath);
          if (!byTarget.has(relativePath)) byTarget.set(relativePath, planned);
        } else if (photo.raw !== undefined && PROPRIETARY_RAW.has(extname(photo.raw.path).toLocaleLowerCase("en-US"))) {
          const relativePath = relativeXmp(photo.raw);
          if (!byTarget.has(relativePath)) byTarget.set(relativePath, await planGenerated(destinationRoot, relativePath, generatedXmp(photo.rating)));
        }
        completed += 1;
        const relativePath = photo.raw?.relativePath ?? photo.jpeg?.relativePath ?? photo.xmp?.relativePath;
        operation?.onProgress?.({ completed, total: selectedPhotos.length, ...(relativePath === undefined ? {} : { relativePath }) });
      }
      for (const relativePath of byTarget.keys()) {
        const key = fold(relativePath);
        const prior = caseTargets.get(key);
        if (prior !== undefined && prior !== relativePath) throw new CopyExportError("UNSAFE_COPY_PATH");
        caseTargets.set(key, relativePath);
      }
      const items = [...byTarget.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en-US"));
      const confirmationId = randomBytes(32).toString("hex");
      confirmations.set(confirmationId, { albumId: context.albumId, confirmationId, createdAtMs: now(), sourceRoot, destinationRoot, destinationRootIdentity: await directoryIdentity(destinationRoot), inventoryFingerprint: context.session.inventoryFingerprint, ratingDigest: ratingDigest(context), items });
      const fileSystem = await statfs(destinationRoot);
      const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
      const requiredBytes = items.filter(({ status }) => status === "copy").reduce((sum, item) => sum + item.size, 0);
      const publicItems = items.map(({ relativePath, size, sha256, status, generated }) => ({ relativePath, size, sha256, status, generated }));
      return { confirmationId, isDemo: false, items: publicItems, counts: { copy: items.filter(({ status }) => status === "copy").length, skip: items.filter(({ status }) => status === "skip").length, conflicts: items.filter(({ status }) => status === "conflict").length }, totalBytes, requiredBytes, freeBytes: fileSystem.bavail * fileSystem.bsize };
    },

    async commit(context, request) {
      const plan = confirmations.get(request.confirmationId);
      confirmations.delete(request.confirmationId);
      if (plan === undefined) throw new CopyExportError("CONFIRMATION_REQUIRED");
      if (now() - plan.createdAtMs > ttl) throw new CopyExportError("CONFIRMATION_EXPIRED");
      if (context.isDemo) throw new CopyExportError("DEMO_EXPORT_DISABLED");
      if (plan.albumId !== context.albumId || plan.inventoryFingerprint !== context.session.inventoryFingerprint || plan.ratingDigest !== ratingDigest(context)) throw new CopyExportError("SOURCE_CHANGED");
      if (activeAlbums.has(context.albumId)) throw new CopyExportError("EXPORT_LOCKED");
      activeAlbums.add(context.albumId);
      const results: CopyExportReportItem[] = [];
      let bytesCompleted = 0;
      let root: PinnedDirectory | undefined;
      let staging: PinnedDirectory | undefined;
      let pendingError: unknown;
      try {
        root = await pinDirectory(plan.destinationRoot);
        if (!sameInode(root, plan.destinationRootIdentity)) throw new CopyExportError("RECOVERY_REQUIRED");
        await revalidateFor(root, "destination-root");
        const stagingPath = join(root.path, `.burstpick-copy-job-${randomBytes(16).toString("hex")}`);
        await mkdir(stagingPath, { mode: 0o700 });
        staging = await pinDirectory(stagingPath, root.path);
        await revalidateFor(root, "destination-root");
        await revalidateFor(staging, "destination-root", root.path);
        await syncEntryOwner(root, root, "destination-root-sync", options, "destination-root", "staging-create");
        for (const item of plan.items) {
          if (request.signal?.aborted) break;
          let status: CopyResultStatus = "failed";
          let temporary: OwnedFile | undefined;
          let installed: OwnedFile | undefined;
          let parent: PinnedDirectory | undefined;
          try {
            await revalidateFor(root, item.relativePath);
            if (!item.generated) {
              const currentSource = await snapshot(item.sourcePath!);
              if (!sameSnapshot(item.source, currentSource) || !contained(plan.sourceRoot, currentSource.path)) throw new CopyExportError("SOURCE_CHANGED");
            }
            await revalidateFor(root, item.relativePath);
            parent = await ensureSafeParent(root, item.destinationPath, options, item.relativePath);
            await revalidateFor(root, item.relativePath);
            await revalidateFor(parent, item.relativePath, root.path);
            const currentDestination = await snapshot(item.destinationPath);
            if (!sameSnapshot(item.destination, currentDestination)) {
              status = currentDestination.exists && currentDestination.size === item.size && currentDestination.sha256 === item.sha256 ? "skipped" : "conflict";
            }
            else if (currentDestination.exists) status = currentDestination.size === item.size && currentDestination.sha256 === item.sha256 ? "skipped" : "conflict";
            else {
              await options.failureInjection?.("before-create", { relativePath: item.relativePath });
              await options.failureInjection?.("before-copy", { relativePath: item.relativePath });
              await revalidateFor(root, item.relativePath);
              await revalidateFor(staging, item.relativePath, root.path);
              await revalidateFor(parent, item.relativePath, root.path);
              temporary = await createOwnedFile(staging, ".burstpick-copy");
              await syncEntryOwner(staging, root, "staging-directory-sync", options, item.relativePath, "temporary-create");
              if (item.generatedContents !== undefined) {
                await temporary.handle.writeFile(item.generatedContents);
              } else {
                await copyIntoHandle(item.sourcePath!, temporary.handle);
              }
              await temporary.handle.sync();
              await options.failureInjection?.("after-copy", { relativePath: item.relativePath, temporaryPath: temporary.path });
              const prepared = await snapshot(temporary.path);
              const preparedHandle = await temporary.handle.stat();
              if (!prepared.exists || prepared.size !== item.size || prepared.sha256 !== item.sha256 || !sameInode(preparedHandle, temporary)) throw new Error("COPY_VERIFY_FAILED");
              if (!item.generated) {
                const afterCopySource = await snapshot(item.sourcePath!);
                if (!sameSnapshot(item.source, afterCopySource)) throw new CopyExportError("SOURCE_CHANGED");
              }
              await options.failureInjection?.("before-link", { relativePath: item.relativePath, temporaryPath: temporary.path });
              await options.failureInjection?.("before-install", { relativePath: item.relativePath, temporaryPath: temporary.path });
              await revalidateFor(root, item.relativePath);
              await revalidateFor(staging, item.relativePath, root.path);
              await revalidateFor(parent, item.relativePath, root.path);
              if (!await ownedAtPath(temporary)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, item.relativePath);
              try {
                await link(temporary.path, item.destinationPath);
                installed = { ...temporary, path: item.destinationPath };
                await syncEntryOwner(parent, root, "final-parent-sync", options, item.relativePath, "final-link");
              }
              catch (error) {
                if (errorCode(error) !== "EEXIST") throw error;
                await revalidateFor(parent, item.relativePath, root.path);
                const raced = await snapshot(item.destinationPath);
                status = raced.exists && raced.size === item.size && raced.sha256 === item.sha256 ? "skipped" : "conflict";
              }
              if (installed !== undefined) {
                await revalidateFor(root, item.relativePath);
                await revalidateFor(parent, item.relativePath, root.path);
                const linked = await lstat(item.destinationPath);
                const canonicalFinal = await realpath(item.destinationPath);
                if (linked.isSymbolicLink() || !sameInode(linked, installed) || !contained(root.path, canonicalFinal)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, item.relativePath);
                await options.failureInjection?.("after-link", { relativePath: item.relativePath, temporaryPath: temporary.path });
                await revalidateFor(root, item.relativePath);
                await revalidateFor(parent, item.relativePath, root.path);
                const linkedAfterHook = await lstat(item.destinationPath);
                const canonicalAfterHook = await realpath(item.destinationPath);
                if (linkedAfterHook.isSymbolicLink() || !sameInode(linkedAfterHook, installed) || !contained(root.path, canonicalAfterHook)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, item.relativePath);
                await options.failureInjection?.("after-install", { relativePath: item.relativePath, temporaryPath: temporary.path });
                await revalidateFor(parent, item.relativePath, root.path);
                const verified = await snapshot(item.destinationPath);
                if (!verified.exists || verified.size !== item.size || verified.sha256 !== item.sha256 || !contained(root.path, verified.path)) throw new Error("COPY_VERIFY_FAILED");
                const installedAgain = await lstat(item.destinationPath);
                if (installedAgain.isSymbolicLink() || !sameInode(installedAgain, installed)) throw new CopyExportError("RECOVERY_REQUIRED", undefined, item.relativePath);
                await revalidateFor(root, item.relativePath);
                await revalidateFor(parent, item.relativePath, root.path);
                await revalidateFor(root, item.relativePath);
                await revalidateFor(parent, item.relativePath, root.path);
                const durable = await snapshot(item.destinationPath);
                const durableIdentity = await lstat(item.destinationPath);
                if (!durable.exists || durable.size !== item.size || durable.sha256 !== item.sha256 || !contained(root.path, durable.path) || durableIdentity.isSymbolicLink() || !sameInode(durableIdentity, installed)) throw new Error("COPY_VERIFY_FAILED");
                await revalidateFor(root, item.relativePath);
                await revalidateFor(parent, item.relativePath, root.path);
                status = "copied";
              }
            }
          } catch (error) {
            if (error instanceof CopyExportError) throw error;
            if (installed !== undefined && parent !== undefined) {
              await cleanupOwned(installed, parent, root, options, item.relativePath, "final-parent-sync", "final-unlink");
              installed = undefined;
            }
            status = "failed";
          } finally {
            try {
              if (temporary !== undefined && staging !== undefined) {
                await options.failureInjection?.("cleanup", { relativePath: item.relativePath, temporaryPath: temporary.path });
                await cleanupOwned(temporary, staging, root, options, item.relativePath, "staging-directory-sync", "temporary-unlink");
              }
            } finally {
              await temporary?.handle.close().catch(() => undefined);
              await parent?.handle.close().catch(() => undefined);
            }
          }
          results.push({ relativePath: item.relativePath, size: item.size, sha256: item.sha256, status });
          bytesCompleted += item.size;
          request.onProgress?.({ completed: results.length, total: plan.items.length, bytesCompleted, totalBytes: plan.items.reduce((sum, candidate) => sum + candidate.size, 0), relativePath: item.relativePath, status });
        }
        const report: CopyExportReport = {
          reportId: randomBytes(16).toString("hex"), albumId: plan.albumId, completedAt: new Date(now()).toISOString(), cancelled: request.signal?.aborted ?? false,
          counts: { copied: results.filter(({ status }) => status === "copied").length, skipped: results.filter(({ status }) => status === "skipped").length, conflicts: results.filter(({ status }) => status === "conflict").length, failed: results.filter(({ status }) => status === "failed").length }, items: results,
        };
        await persistReport(appDataRoot, report, options);
        return report;
      } catch (error) {
        pendingError = error;
        throw error;
      } finally {
        let stagingCleanupError: unknown;
        if (staging !== undefined) {
          try {
            if (root !== undefined && pendingError === undefined) {
              await options.failureInjection?.("job-cleanup", { relativePath: "destination-root" });
              await removePinnedDirectory(staging, root, options, "destination-root");
            } else if (root !== undefined) await removePinnedDirectory(staging, root, options, "destination-root");
          } catch (error) {
            stagingCleanupError = error instanceof CopyExportError ? error : new CopyExportError("RECOVERY_REQUIRED", error, "destination-root");
          } finally { await staging.handle.close().catch(() => undefined); }
        }
        await root?.handle.close().catch(() => undefined);
        activeAlbums.delete(context.albumId);
        if (stagingCleanupError !== undefined && (pendingError === undefined || !(pendingError instanceof CopyExportError && pendingError.code === "RECOVERY_REQUIRED"))) throw stagingCleanupError;
      }
    },

    async report(reportId) {
      if (!/^[0-9a-f]{32}$/u.test(reportId)) throw new CopyExportError("UNSAFE_COPY_PATH");
      try { return JSON.parse(await readFile(join(appDataRoot, "copy-exports", `${reportId}.json`), "utf8")) as CopyExportReport; }
      catch (error) { if (errorCode(error) === "ENOENT") throw new CopyExportError("REPORT_NOT_FOUND", error); throw error; }
    },
  };
}

export async function previewCopyExport(context: ExportContext, destinationRoot: string, options: CreateCopyExportServiceOptions, minRating = 1): Promise<CopyExportPreview> {
  return createCopyExportService(options).preview(context, { destinationRoot, minRating });
}

export async function commitCopyExport(
  service: Pick<CopyExportServiceBoundary, "commit">,
  context: ExportContext,
  confirmationId: string,
  options: { readonly signal?: AbortSignal; readonly onProgress?: (progress: CopyExportProgress) => void } = {},
): Promise<CopyExportReport> {
  return service.commit(context, { confirmationId, ...options });
}
