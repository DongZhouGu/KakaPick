import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { differenceHash as hashPixels } from "../perceptual-hash.js";

export interface ImageFileDescriptor {
  readonly modifiedAtMs: number;
  readonly path: string;
  readonly size: number;
}

export type ImageSource = Buffer | ImageFileDescriptor | string;

export interface ThumbnailOptions {
  readonly height: number;
  readonly width: number;
}

export interface ImageInspection {
  readonly format: string;
  readonly height: number;
  readonly width: number;
}

export interface ImageAdapter {
  assertCacheOutsideSource(sourceRoot: string): Promise<void>;
  thumbnail(source: ImageSource, options: ThumbnailOptions): Promise<Buffer>;
  differenceHash(source: Buffer | string): Promise<string>;
  inspect(source: Buffer | string): Promise<ImageInspection>;
  sharpness?(source: Buffer | string): Promise<number>;
  exposure?(source: Buffer | string): Promise<{ overexposedRatio: number; underexposedRatio: number }>;
}

export interface SharpImageAdapterOptions {
  readonly cacheRoot: string;
}

export class UnsafeCacheLocationError extends Error {
  readonly code = "UNSAFE_CACHE_LOCATION" as const;

  constructor() {
    super("Image cache root must be outside the album source folder");
    this.name = "UnsafeCacheLocationError";
  }
}

interface CacheSource {
  readonly canonicalPath: string;
  readonly modifiedAtMs: number;
  readonly size: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function canonicalPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    const parent = dirname(absolutePath);
    return parent === absolutePath
      ? absolutePath
      : join(await canonicalPath(parent), basename(absolutePath));
  }
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function validateDimensions(options: ThumbnailOptions): void {
  if (!Number.isSafeInteger(options.width) || options.width <= 0) {
    throw new RangeError("Thumbnail width must be a positive integer");
  }
  if (!Number.isSafeInteger(options.height) || options.height <= 0) {
    throw new RangeError("Thumbnail height must be a positive integer");
  }
}

async function cacheSource(source: string | ImageFileDescriptor): Promise<CacheSource> {
  const sourcePath = typeof source === "string" ? source : source.path;
  const canonicalPath = await realpath(sourcePath);
  if (typeof source !== "string") {
    return {
      canonicalPath,
      modifiedAtMs: source.modifiedAtMs,
      size: source.size,
    };
  }

  const sourceStats = await stat(canonicalPath);
  return {
    canonicalPath,
    modifiedAtMs: sourceStats.mtimeMs,
    size: sourceStats.size,
  };
}

async function renderThumbnail(
  source: Buffer | string,
  options: ThumbnailOptions,
): Promise<Buffer> {
  return sharp(source)
    .rotate()
    .resize({
      fit: "inside",
      height: options.height,
      width: options.width,
      withoutEnlargement: true,
    })
    .toColourspace("srgb")
    .jpeg({ quality: 84 })
    .toBuffer();
}

export class SharpImageAdapter implements ImageAdapter {
  readonly #cacheRoot: string;

  constructor(options: SharpImageAdapterOptions) {
    if (options.cacheRoot.trim().length === 0) {
      throw new TypeError("Image cache root is required");
    }
    this.#cacheRoot = resolve(options.cacheRoot);
    void this.#purgeStale();
  }

  async #purgeStale(): Promise<void> {
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const dir = join(this.#cacheRoot, "thumbnails");
    try {
      for (const entry of await readdir(dir)) {
        if (!entry.endsWith(".jpg") && !entry.endsWith(".tmp")) continue;
        try { const s = await stat(join(dir, entry)); if (now - s.mtimeMs > maxAge) await rm(join(dir, entry), { force: true }); } catch { /* skip */ }
      }
    } catch { /* dir may not exist yet */ }
  }

  async assertCacheOutsideSource(sourceRoot: string): Promise<void> {
    const [canonicalSourceRoot, canonicalCacheRoot] = await Promise.all([
      realpath(sourceRoot),
      canonicalPath(this.#cacheRoot),
    ]);
    if (isSameOrInside(canonicalSourceRoot, canonicalCacheRoot)) {
      throw new UnsafeCacheLocationError();
    }
  }

  async thumbnail(source: ImageSource, options: ThumbnailOptions): Promise<Buffer> {
    validateDimensions(options);
    if (Buffer.isBuffer(source)) return renderThumbnail(source, options);

    const fingerprint = await cacheSource(source);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          fingerprint.canonicalPath,
          fingerprint.size,
          fingerprint.modifiedAtMs,
          options.width,
          options.height,
        ]),
      )
      .digest("hex");
    const thumbnailRoot = join(this.#cacheRoot, "thumbnails");
    const cachePath = join(thumbnailRoot, `${key}.jpg`);
    try {
      return await readFile(cachePath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }

    const rendered = await renderThumbnail(fingerprint.canonicalPath, options);
    await mkdir(thumbnailRoot, { mode: 0o700, recursive: true });
    const temporaryPath = join(thumbnailRoot, `.${key}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(rendered);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, cachePath);
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return rendered;
  }

  async differenceHash(source: Buffer | string): Promise<string> {
    const { data, info } = await sharp(source)
      .rotate()
      .resize({ fit: "fill", height: 8, width: 9 })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== 9 || info.height !== 8 || info.channels !== 1) {
      throw new Error("Sharp returned an invalid difference-hash raster");
    }
    return hashPixels(data);
  }

  async inspect(source: Buffer | string): Promise<ImageInspection> {
    const { info } = await sharp(source).rotate().toBuffer({ resolveWithObject: true });
    return { format: info.format, height: info.height, width: info.width };
  }

  async sharpness(source: Buffer | string): Promise<number> {
    const { data } = await sharp(source)
      .greyscale()
      .resize(128, 128, { fit: "inside", withoutEnlargement: true })
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const n = pixels.length;
    let sum = 0; let sumSq = 0;
    for (let i = 0; i < n; i++) { const v = pixels[i]!; sum += v; sumSq += v * v; }
    const mean = sum / n;
    return Math.sqrt(sumSq / n - mean * mean);
  }

  async exposure(source: Buffer | string): Promise<{ overexposedRatio: number; underexposedRatio: number }> {
    const { data } = await sharp(source)
      .resize(128, 128, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let over = 0; let under = 0; const n = pixels.length / 3;
    for (let i = 0; i < pixels.length; i += 3) {
      const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
      const brightness = (r + g + b) / 3;
      if (brightness > 240) over++;
      else if (brightness < 15) under++;
    }
    return { overexposedRatio: over / n, underexposedRatio: under / n };
  }
}

export function createImageAdapter(options: SharpImageAdapterOptions): ImageAdapter {
  return new SharpImageAdapter(options);
}
