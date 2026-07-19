import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AlbumSessionSchema,
  PhotoUnitSchema,
  type AlbumSession,
  type PhotoUnit,
  type ScanWarning,
  type SourceFile,
} from "../shared/domain.js";
import type { ImageAdapter } from "./adapters/image.js";
import type { MetadataAdapter, MetadataReadResult } from "./adapters/metadata.js";
import { applyBoundaryOverrides, groupBursts } from "./grouping.js";
import { classifySourceFile, pairSourceFiles } from "./pairing.js";

const METADATA_CONCURRENCY = 8;
const IMAGE_CONCURRENCY = 6;
const HASH_PATTERN = /^[0-9a-f]{16}$/;
const IGNORED_DIRECTORIES = new Set([".burstpick", "node_modules"]);
const FILENAME_TIMESTAMP_PATTERN = /^(\d{13})(?:_|$)/;
const MIN_FILENAME_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FILENAME_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

export type ScanProgressPhase = "inventory" | "metadata" | "hashing" | "grouping";

export interface ScanProgress {
  readonly phase: ScanProgressPhase;
  readonly completed: number;
  readonly total: number;
}

export type AdapterScanWarningCode =
  | "CAPTURE_TIME_FALLBACK"
  | "IMAGE_HASH_FAILED"
  | "METADATA_READ_FAILED"
  | "PREVIEW_EXTRACT_FAILED";

export interface AdapterScanWarning {
  readonly code: AdapterScanWarningCode;
  readonly photoId: string;
  readonly relativePaths: string[];
}

export type ScanAlbumWarning = AdapterScanWarning | ScanWarning;

export interface AlbumSessionStore {
  load(): Promise<AlbumSession | undefined>;
  save(session: AlbumSession): Promise<void>;
}

export interface ScanAlbumOptions {
  readonly cacheRoot?: string;
  readonly destinationPaths?: readonly string[];
  readonly groupingSensitivity?: number;
  readonly images: ImageAdapter;
  readonly metadata: MetadataAdapter;
  readonly root: string;
  readonly sessionStore: AlbumSessionStore;
  readonly signal?: AbortSignal;
}

export type ScanAlbumResult = AlbumSession & {
  readonly warnings: ScanAlbumWarning[];
};

interface ConcurrentResult<T> {
  readonly value: T;
  readonly warning?: AdapterScanWarning;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

async function canonicalDestination(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      const parent = dirname(absolutePath);
      return parent === absolutePath
        ? absolutePath
        : join(await canonicalDestination(parent), basename(absolutePath));
    }
    throw error;
  }
}

async function inventory(
  root: string,
  destinationPaths: readonly string[],
  signal?: AbortSignal,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];

  async function walk(directory: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    signal?.throwIfAborted();
    entries.sort((left, right) => {
      const normalizedDifference = compareStrings(left.name.normalize("NFC"), right.name.normalize("NFC"));
      return normalizedDifference === 0 ? compareStrings(left.name, right.name) : normalizedDifference;
    });

    for (const entry of entries) {
      signal?.throwIfAborted();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (destinationPaths.some((destination) => isSameOrInside(destination, path))) continue;
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = portableRelativePath(root, path);
      const kind = classifySourceFile(relativePath);
      if (kind === undefined) continue;
      const fileStats = await stat(path);
      signal?.throwIfAborted();
      files.push({
        kind,
        modifiedAtMs: fileStats.mtimeMs,
        path,
        relativePath,
        size: fileStats.size,
      });
    }
  }

  await walk(root);
  return files;
}

async function mapLimited<T, U>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<U>,
  onCompleted: (completed: number) => void,
  signal?: AbortSignal,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let completed = 0;
  let stopped = false;
  const errors: unknown[] = [];

  async function worker(): Promise<void> {
    while (!stopped && signal?.aborted !== true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      try {
        signal?.throwIfAborted();
        const result = await operation(item, index);
        signal?.throwIfAborted();
        results[index] = result;
        completed += 1;
        onCompleted(completed);
        signal?.throwIfAborted();
      } catch (error) {
        stopped = true;
        errors.push(error);
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => worker()),
  );
  signal?.throwIfAborted();
  if (errors.length > 0) throw errors[0];
  return results;
}

function primaryFile(photo: PhotoUnit): SourceFile {
  const source = photo.raw ?? photo.jpeg;
  if (source === undefined) throw new Error("Validated photo unit has no source file");
  return source;
}

function validString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function filenameTimestampMs(source: SourceFile): number | undefined {
  const match = FILENAME_TIMESTAMP_PATTERN.exec(basename(source.relativePath).replace(/\.[^.]+$/u, ""));
  if (match === null) return undefined;

  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp >= MIN_FILENAME_TIMESTAMP_MS && timestamp < MAX_FILENAME_TIMESTAMP_MS
    ? timestamp
    : undefined;
}

function validSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function enrichPhoto(photo: PhotoUnit, metadata: MetadataReadResult): PhotoUnit {
  const source = primaryFile(photo);
  const exifCaptureTime = validTimestamp(metadata.capturedAtMs);
  const fileNameCaptureTime = exifCaptureTime === undefined ? filenameTimestampMs(source) : undefined;
  const capturedAtMs = exifCaptureTime ?? fileNameCaptureTime ?? source.modifiedAtMs;
  const cameraId = validString(metadata.cameraId);
  const burstId = validString(metadata.burstId);
  const sequenceNumber = validSequence(metadata.sequenceNumber);
  return PhotoUnitSchema.parse({
    ...photo,
    capturedAtMs,
    captureTimeSource: exifCaptureTime !== undefined ? "exif" : fileNameCaptureTime !== undefined ? "filename" : "file-mtime",
    ...(cameraId === undefined ? {} : { cameraId }),
    ...(burstId === undefined ? {} : { burstId }),
    ...(sequenceNumber === undefined ? {} : { sequenceNumber }),
  });
}

function warningFor(
  code: AdapterScanWarningCode,
  photo: PhotoUnit,
  source: SourceFile,
): AdapterScanWarning {
  return { code, photoId: photo.id, relativePaths: [source.relativePath] };
}

function defaultCacheRoot(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "BurstPick")
    : join(homedir(), ".cache", "burstpick");
}

async function rawPreviewPath(
  photo: PhotoUnit,
  source: SourceFile,
  cacheRoot: string,
  metadata: MetadataAdapter,
): Promise<string> {
  const previewRoot = join(resolve(cacheRoot), "previews");
  await mkdir(previewRoot, { mode: 0o700, recursive: true });
  const key = createHash("sha256")
    .update(JSON.stringify([source.path, source.size, source.modifiedAtMs]))
    .digest("hex");
  const previewPath = join(previewRoot, `${key}.jpg`);
  try {
    await access(previewPath);
    await chmod(previewPath, 0o600);
    return previewPath;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  const temporaryPath = join(previewRoot, `.${photo.id}.${randomUUID()}.tmp`);
  try {
    await metadata.extractPreview(source.path, temporaryPath);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, previewPath);
    await chmod(previewPath, 0o600);
    return previewPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sourcePathHash(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function inventoryFingerprint(files: readonly SourceFile[]): string {
  const fingerprint = files.map((file) => [
    file.relativePath.normalize("NFC"),
    file.kind,
    file.size,
    file.modifiedAtMs,
  ]);
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
}

function samePhotoIds(left: readonly PhotoUnit[], right: readonly PhotoUnit[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right.map((photo) => photo.id));
  return left.every((photo) => rightIds.has(photo.id));
}

function sameVisualSources(left: readonly PhotoUnit[], right: readonly PhotoUnit[]): boolean {
  if (!samePhotoIds(left, right)) return false;
  const rightById = new Map(right.map((photo) => [photo.id, photo]));
  const descriptor = (photo: PhotoUnit) => [photo.raw, photo.jpeg].map((source) => source === undefined
    ? undefined
    : [source.kind, source.path, source.size, source.modifiedAtMs]);
  return left.every((photo) => JSON.stringify(descriptor(photo)) === JSON.stringify(descriptor(rightById.get(photo.id)!)));
}

function refreshSourceFiles(prior: PhotoUnit, current: PhotoUnit): PhotoUnit {
  const { raw: _raw, jpeg: _jpeg, xmp: _xmp, ...preserved } = prior;
  void _raw; void _jpeg; void _xmp;
  return PhotoUnitSchema.parse({
    ...preserved,
    ...(current.raw === undefined ? {} : { raw: current.raw }),
    ...(current.jpeg === undefined ? {} : { jpeg: current.jpeg }),
    ...(current.xmp === undefined ? {} : { xmp: current.xmp }),
  });
}

function validPriorSession(value: unknown, expectedSourcePathHash: string): AlbumSession | undefined {
  const parsed = AlbumSessionSchema.safeParse(value);
  if (!parsed.success || parsed.data.sourcePathHash !== expectedSourcePathHash) return undefined;
  return parsed.data;
}

export async function scanAlbum(
  options: ScanAlbumOptions,
  onProgress: (progress: ScanProgress) => void = () => undefined,
): Promise<ScanAlbumResult> {
  options.signal?.throwIfAborted();
  const root = await realpath(options.root);
  options.signal?.throwIfAborted();
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) throw new TypeError("Album root must be a readable directory");
  options.signal?.throwIfAborted();
  await options.images.assertCacheOutsideSource(root);
  options.signal?.throwIfAborted();
  const cacheRoot = await canonicalDestination(options.cacheRoot ?? defaultCacheRoot());
  if (isSameOrInside(root, cacheRoot)) {
    throw new TypeError("Application cache root must be outside the album source folder");
  }
  const destinations = await Promise.all(
    (options.destinationPaths ?? []).map(async (path) => canonicalDestination(path)),
  );
  options.signal?.throwIfAborted();

  onProgress({ phase: "inventory", completed: 0, total: 0 });
  options.signal?.throwIfAborted();
  const files = await inventory(root, destinations, options.signal);
  options.signal?.throwIfAborted();
  onProgress({ phase: "inventory", completed: files.length, total: files.length });
  options.signal?.throwIfAborted();
  const paired = pairSourceFiles(root, files);
  const total = paired.photos.length;
  const currentSourcePathHash = sourcePathHash(root);
  const currentInventoryFingerprint = inventoryFingerprint(files);
  const prior = validPriorSession(await options.sessionStore.load(), currentSourcePathHash);
  const requestedSensitivity = options.groupingSensitivity ?? prior?.groupingSensitivity ?? 1;
  const canFastResume =
    prior !== undefined &&
    prior.groupingSensitivity === requestedSensitivity &&
    sameVisualSources(prior.photos, paired.photos);
  if (canFastResume) {
    onProgress({ phase: "metadata", completed: total, total });
    const currentById = new Map(paired.photos.map((photo) => [photo.id, photo]));
    let resumedPhotos = prior.photos.map((photo) => refreshSourceFiles(photo, currentById.get(photo.id)!));
    // Compute sharpness for photos that lack it (incremental, even on fast resume)
    const needsSharpness = resumedPhotos.filter((p) => p.sharpness === undefined);
    if (needsSharpness.length > 0 && options.images.sharpness) {
      onProgress({ phase: "hashing", completed: 0, total: needsSharpness.length });
      const metricsById = new Map(
        (await mapLimited(
          needsSharpness,
          IMAGE_CONCURRENCY,
          async (photo): Promise<readonly [string, PhotoUnit]> => {
            const source = photo.jpeg ?? photo.raw;
            if (source === undefined) return [photo.id, photo];
            try {
              const [sharpness, exposure] = await Promise.all([
                options.images.sharpness!(source.path),
                options.images.exposure?.(source.path) ?? Promise.resolve(undefined),
              ]);
              return [photo.id, {
                ...photo,
                sharpness,
                ...(exposure === undefined ? {} : {
                  overexposedRatio: exposure.overexposedRatio,
                  underexposedRatio: exposure.underexposedRatio,
                }),
              }];
            } catch {
              return [photo.id, photo];
            }
          },
          (completed) => onProgress({ phase: "hashing", completed, total: needsSharpness.length }),
          options.signal,
        )).map((entry) => entry as readonly [string, PhotoUnit]),
      );
      resumedPhotos = resumedPhotos.map((photo) => metricsById.get(photo.id) ?? photo);
    }
    onProgress({ phase: "hashing", completed: total, total });
    onProgress({ phase: "grouping", completed: 1, total: 1 });
    const session = AlbumSessionSchema.parse({ ...prior, inventoryFingerprint: currentInventoryFingerprint, photos: resumedPhotos, updatedAt: new Date().toISOString() });
    await options.sessionStore.save(session);
    const fallbackWarnings = session.photos
      .filter((photo) => photo.captureTimeSource === "file-mtime")
      .map((photo) => warningFor("CAPTURE_TIME_FALLBACK", photo, primaryFile(photo)));
    return { ...session, warnings: [...paired.warnings, ...fallbackWarnings] };
  }

  onProgress({ phase: "metadata", completed: 0, total });
  options.signal?.throwIfAborted();
  const metadataResults = await mapLimited(
    paired.photos,
    METADATA_CONCURRENCY,
    async (photo): Promise<ConcurrentResult<PhotoUnit>> => {
      const source = primaryFile(photo);
      try {
        options.signal?.throwIfAborted();
        const metadata = await options.metadata.read(source.path);
        options.signal?.throwIfAborted();
        return { value: enrichPhoto(photo, metadata) };
      } catch {
        options.signal?.throwIfAborted();
        return {
          value: photo,
          warning: warningFor("METADATA_READ_FAILED", photo, source),
        };
      }
    },
    (completed) => onProgress({ phase: "metadata", completed, total }),
    options.signal,
  );

  onProgress({ phase: "hashing", completed: 0, total });
  options.signal?.throwIfAborted();
  const imageResults = await mapLimited(
    metadataResults.map((result) => result.value),
    IMAGE_CONCURRENCY,
    async (photo): Promise<ConcurrentResult<PhotoUnit>> => {
      const source = photo.jpeg ?? photo.raw;
      if (source === undefined) return { value: photo };
      options.signal?.throwIfAborted();
      let imageSource = source.path;
      if (photo.jpeg === undefined && photo.raw !== undefined) {
        try {
          imageSource = await rawPreviewPath(photo, photo.raw, cacheRoot, options.metadata);
          options.signal?.throwIfAborted();
        } catch {
          options.signal?.throwIfAborted();
          return {
            value: photo,
            warning: warningFor("PREVIEW_EXTRACT_FAILED", photo, photo.raw),
          };
        }
      }

      try {
        options.signal?.throwIfAborted();
        const [perceptualHash, sharpnessScore, expo, inspection] = await Promise.all([
          options.images.differenceHash(imageSource),
          options.images.sharpness?.(imageSource) ?? Promise.resolve(undefined),
          options.images.exposure?.(imageSource) ?? Promise.resolve(undefined),
          options.images.inspect(imageSource).catch(() => undefined),
        ]);
        options.signal?.throwIfAborted();
        if (!HASH_PATTERN.test(perceptualHash)) throw new TypeError("Invalid image hash");
        const dims = inspection ? { previewWidth: inspection.width, previewHeight: inspection.height } : {};
        const exposureFields = expo ? { overexposedRatio: expo.overexposedRatio, underexposedRatio: expo.underexposedRatio } : {};
        return { value: PhotoUnitSchema.parse({ ...photo, perceptualHash, ...dims, ...exposureFields, ...(sharpnessScore === undefined ? {} : { sharpness: sharpnessScore }) }) };
      } catch {
        options.signal?.throwIfAborted();
        return {
          value: photo,
          warning: warningFor("IMAGE_HASH_FAILED", photo, source),
        };
      }
    },
    (completed) => onProgress({ phase: "hashing", completed, total }),
    options.signal,
  );

  options.signal?.throwIfAborted();
  options.signal?.throwIfAborted();
  const priorRatings = new Map(prior?.photos.map((photo) => [photo.id, photo.rating]) ?? []);
  const photos = imageResults.map((result) => {
    const rating = priorRatings.get(result.value.id);
    return rating === undefined ? result.value : PhotoUnitSchema.parse({ ...result.value, rating });
  });
  const groupingSensitivity = requestedSensitivity;

  onProgress({ phase: "grouping", completed: 0, total: 1 });
  options.signal?.throwIfAborted();
  const automaticGroups = groupBursts(photos, { sensitivity: groupingSensitivity });
  const appliedOverrides = applyBoundaryOverrides(
    automaticGroups,
    prior?.boundaryOverrides ?? [],
    photos,
  );
  const canRestoreGroups =
    prior !== undefined &&
    prior.inventoryFingerprint === currentInventoryFingerprint &&
    prior.groupingSensitivity === groupingSensitivity &&
    samePhotoIds(prior.photos, photos);
  const session = AlbumSessionSchema.parse({
    schemaVersion: 1,
    sourcePathHash: currentSourcePathHash,
    inventoryFingerprint: currentInventoryFingerprint,
    boundaryOverrides: canRestoreGroups ? prior.boundaryOverrides : appliedOverrides.overrides,
    photos,
    groups: canRestoreGroups ? prior.groups : appliedOverrides.groups,
    groupingSensitivity,
    history: canRestoreGroups ? prior.history : [],
    rejectedIds: (prior?.rejectedIds ?? []).filter((id) => photos.some((photo) => photo.id === id)),
    updatedAt: new Date().toISOString(),
  });
  options.signal?.throwIfAborted();
  await options.sessionStore.save(session);
  options.signal?.throwIfAborted();
  onProgress({ phase: "grouping", completed: 1, total: 1 });

  const adapterWarnings = [
    ...metadataResults.flatMap((result) => (result.warning === undefined ? [] : [result.warning])),
    ...imageResults.flatMap((result) => (result.warning === undefined ? [] : [result.warning])),
  ];
  const fallbackWarnings = photos
    .filter((photo) => photo.captureTimeSource === "file-mtime")
    .map((photo) => warningFor("CAPTURE_TIME_FALLBACK", photo, primaryFile(photo)));
  return { ...session, warnings: [...paired.warnings, ...adapterWarnings, ...fallbackWarnings] };
}
