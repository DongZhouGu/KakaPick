import { ExifTool, type WriteTags } from "exiftool-vendored";
import { lstat, rm } from "node:fs/promises";
import { extname } from "node:path";
import { RatingSchema, type Rating } from "../../shared/domain.js";

export const EXIFTOOL_MAX_PROCESSES = 4;
export const EXIFTOOL_TASK_TIMEOUT_MS = 30_000;
const WRITABLE_METADATA_EXTENSIONS = new Set([".dng", ".jpeg", ".jpg", ".xmp"]);

export class UnsafeMetadataTargetError extends Error {
  readonly code = "UNSAFE_METADATA_TARGET" as const;

  constructor() {
    super("Metadata ratings may only be written to XMP, JPEG, or DNG targets");
    this.name = "UnsafeMetadataTargetError";
  }
}

export class PreviewDestinationExistsError extends Error {
  readonly code = "PREVIEW_TARGET_EXISTS" as const;

  constructor() {
    super("Preview destination must not already exist");
    this.name = "PreviewDestinationExistsError";
  }
}

export interface MetadataReadResult {
  readonly burstId?: string;
  readonly cameraId?: string;
  readonly capturedAtMs?: number;
  readonly sequenceNumber?: number;
}

export interface MetadataAdapter {
  read(path: string): Promise<MetadataReadResult>;
  readRaw(path: string): Promise<Record<string, unknown>>;
  writeRating(path: string, rating: Rating): Promise<void>;
  extractPreview(sourcePath: string, destinationPath: string): Promise<void>;
  end(): Promise<void>;
}

export interface ExifToolClient {
  read(path: string): Promise<Record<string, unknown>>;
  readRaw(path: string): Promise<Record<string, unknown>>;
  write(path: string, tags: Record<string, unknown>): Promise<unknown>;
  extractPreview(sourcePath: string, destinationPath: string): Promise<void>;
  extractJpgFromRaw?(sourcePath: string, destinationPath: string): Promise<void>;
  extractThumbnail?(sourcePath: string, destinationPath: string): Promise<void>;
  end(gracefully?: boolean): Promise<void>;
}

export interface CreateMetadataAdapterOptions {
  readonly client?: ExifToolClient;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function finiteMilliseconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  if (typeof value === "object" && value !== null && "toMillis" in value) {
    const toMillis = value.toMillis;
    if (typeof toMillis === "function") {
      try {
        return finiteMilliseconds(toMillis.call(value));
      } catch {
        return undefined;
      }
    }
  }

  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const exifMatch = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/.exec(
    trimmed,
  );
  const normalized =
    exifMatch === null
      ? trimmed
      : `${exifMatch[1]}-${exifMatch[2]}-${exifMatch[3]}T${exifMatch[4]}:${exifMatch[5]}:${exifMatch[6]}${exifMatch[7] ?? ""}${exifMatch[8] ?? ""}`;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function subsecondMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = /^\.?([0-9]+)$/.exec(String(value).trim());
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  return Number(digits.slice(0, 3).padEnd(3, "0"));
}

function captureTime(tags: Readonly<Record<string, unknown>>): number | undefined {
  const subsecondOriginal = finiteMilliseconds(tags.SubSecDateTimeOriginal);
  if (subsecondOriginal !== undefined) return subsecondOriginal;

  const original = finiteMilliseconds(tags.DateTimeOriginal);
  if (original === undefined) return undefined;
  const subsecond = subsecondMilliseconds(tags.SubSecTimeOriginal ?? tags.SubSecTime);
  return subsecond === undefined ? original : Math.trunc(original / 1_000) * 1_000 + subsecond;
}

function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function firstString(
  tags: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = nonemptyString(tags[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function cameraId(tags: Readonly<Record<string, unknown>>): string | undefined {
  const serial = firstString(tags, [
    "BodySerialNumber",
    "SerialNumber",
    "InternalSerialNumber",
    "CameraSerialNumber",
  ]);
  if (serial !== undefined) return serial;

  const make = firstString(tags, ["Make"]);
  const model = firstString(tags, ["Model", "CameraModelName"]);
  const fallback = [make, model].filter((value): value is string => value !== undefined).join(" ");
  return fallback.length === 0 ? undefined : fallback;
}

function sequenceNumber(tags: Readonly<Record<string, unknown>>): number | undefined {
  for (const name of [
    "SequenceNumber",
    "SequenceImageNumber",
    "ImageNumber",
    "RawBurstImageNum",
    "ShotNumber",
  ]) {
    const value = tags[name];
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function metadataErrors(tags: Readonly<Record<string, unknown>>): string[] {
  const errors = tags.errors ?? tags.Errors;
  if (Array.isArray(errors)) {
    return errors.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  const error = nonemptyString(errors);
  return error === undefined ? [] : [error];
}

function normalizeMetadata(tags: Readonly<Record<string, unknown>>): MetadataReadResult {
  const errors = metadataErrors(tags);
  if (errors.length > 0) throw new Error("ExifTool reported metadata read errors");

  const capturedAtMs = captureTime(tags);
  const normalizedCameraId = cameraId(tags);
  const burstId = firstString(tags, ["BurstID", "BurstUUID", "BurstGuid", "BurstGUID"]);
  const normalizedSequenceNumber = sequenceNumber(tags);
  return {
    ...(capturedAtMs === undefined ? {} : { capturedAtMs }),
    ...(normalizedCameraId === undefined ? {} : { cameraId: normalizedCameraId }),
    ...(burstId === undefined ? {} : { burstId }),
    ...(normalizedSequenceNumber === undefined ? {} : { sequenceNumber: normalizedSequenceNumber }),
  };
}

function defaultClient(): ExifToolClient {
  const exifTool = new ExifTool({
    maxProcs: EXIFTOOL_MAX_PROCESSES,
    taskTimeoutMillis: EXIFTOOL_TASK_TIMEOUT_MS,
  });
  return {
    async read(path) {
      return (await exifTool.read(path)) as unknown as Record<string, unknown>;
    },
    async readRaw(path) {
      return (await exifTool.readRaw(path, { readArgs: ["-G1"] })) as unknown as Record<string, unknown>;
    },
    async write(path, tags) {
      return exifTool.write(path, tags as WriteTags);
    },
    async extractPreview(sourcePath, destinationPath) {
      await exifTool.extractPreview(sourcePath, destinationPath);
    },
    async extractJpgFromRaw(sourcePath, destinationPath) {
      await exifTool.extractJpgFromRaw(sourcePath, destinationPath);
    },
    async extractThumbnail(sourcePath, destinationPath) {
      await exifTool.extractThumbnail(sourcePath, destinationPath);
    },
    async end(gracefully) {
      await exifTool.end(gracefully);
    },
  };
}

export function createMetadataAdapter(
  options: CreateMetadataAdapterOptions = {},
): MetadataAdapter {
  const client = options.client ?? defaultClient();
  return {
    async read(path) {
      return normalizeMetadata(await client.read(path));
    },
    async readRaw(path) {
      const tags = await client.readRaw(path);
      if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
        throw new TypeError("ExifTool returned malformed raw metadata");
      }
      return tags;
    },
    async writeRating(path, rating) {
      if (!WRITABLE_METADATA_EXTENSIONS.has(extname(path).toLocaleLowerCase("en-US"))) {
        throw new UnsafeMetadataTargetError();
      }
      const validatedRating = RatingSchema.parse(rating);
      await client.write(path, { "XMP-xmp:Rating": validatedRating });
    },
    async extractPreview(sourcePath, destinationPath) {
      try {
        await lstat(destinationPath);
        throw new PreviewDestinationExistsError();
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
      const extractors = [
        client.extractPreview.bind(client),
        client.extractJpgFromRaw?.bind(client),
        client.extractThumbnail?.bind(client),
      ].filter(
        (extractor): extractor is (source: string, destination: string) => Promise<void> =>
          extractor !== undefined,
      );
      const failures: unknown[] = [];
      for (const extract of extractors) {
        try {
          await extract(sourcePath, destinationPath);
          return;
        } catch (error) {
          failures.push(error);
          await rm(destinationPath, { force: true }).catch(() => undefined);
        }
      }
      throw new AggregateError(failures, "ExifTool could not extract an embedded preview");
    },
    async end() {
      await client.end(true);
    },
  };
}
