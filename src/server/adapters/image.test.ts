import { mkdtemp, mkdir, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { SharpImageAdapter } from "./image.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

describe("SharpImageAdapter", () => {
  it("rejects cache roots equal to or nested beneath the canonical source root", async () => {
    const sourceRoot = await temporaryDirectory("burstpick-image-boundary-source-");
    const nestedCache = join(sourceRoot, "generated", "cache");
    await mkdir(nestedCache, { recursive: true });
    const aliasRoot = await temporaryDirectory("burstpick-image-boundary-alias-");
    const nestedAlias = join(aliasRoot, "cache-link");
    await symlink(nestedCache, nestedAlias, "dir");

    for (const cacheRoot of [sourceRoot, nestedCache, nestedAlias]) {
      const adapter = new SharpImageAdapter({ cacheRoot });
      await expect(adapter.assertCacheOutsideSource(sourceRoot)).rejects.toMatchObject({
        code: "UNSAFE_CACHE_LOCATION",
      });
    }
  });

  it("accepts a cache root outside the canonical source root", async () => {
    const sourceRoot = await temporaryDirectory("burstpick-image-boundary-source-");
    const cacheRoot = await temporaryDirectory("burstpick-image-boundary-cache-");
    const adapter = new SharpImageAdapter({ cacheRoot });

    await expect(adapter.assertCacheOutsideSource(sourceRoot)).resolves.toBeUndefined();
  });

  it("autorotates into sRGB without upscaling and caches outside the source folder", async () => {
    const sourceRoot = await temporaryDirectory("burstpick-image-source-");
    const cacheRoot = await temporaryDirectory("burstpick-image-cache-");
    const sourcePath = join(sourceRoot, "oriented.jpg");
    const oriented = await sharp({
      create: { background: { b: 30, g: 20, r: 10 }, channels: 3, height: 2, width: 4 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await writeFile(sourcePath, oriented);
    const adapter = new SharpImageAdapter({ cacheRoot });

    const thumbnail = await adapter.thumbnail(sourcePath, { height: 40, width: 40 });
    const metadata = await sharp(thumbnail).metadata();

    expect(metadata).toMatchObject({ format: "jpeg", height: 4, space: "srgb", width: 2 });
    expect(await readdir(sourceRoot)).toEqual(["oriented.jpg"]);
    expect((await readdir(join(cacheRoot, "thumbnails"))).filter((name) => name.endsWith(".jpg"))).toHaveLength(1);
  });

  it("keys cached thumbnails by source fingerprint and requested dimensions", async () => {
    const sourceRoot = await temporaryDirectory("burstpick-image-key-source-");
    const cacheRoot = await temporaryDirectory("burstpick-image-key-cache-");
    const sourcePath = join(sourceRoot, "source.png");
    await sharp({
      create: { background: "#336699", channels: 3, height: 20, width: 30 },
    })
      .png()
      .toFile(sourcePath);
    const adapter = new SharpImageAdapter({ cacheRoot });

    const first = await adapter.thumbnail(sourcePath, { height: 10, width: 10 });
    const cached = await adapter.thumbnail(sourcePath, { height: 10, width: 10 });
    await adapter.thumbnail(sourcePath, { height: 11, width: 10 });
    const cacheFiles = (await readdir(join(cacheRoot, "thumbnails"))).filter((name) =>
      name.endsWith(".jpg"),
    );

    expect(cached).toEqual(first);
    expect(cacheFiles).toHaveLength(2);
  });

  it("changes the cache key when the actual source mtime or size changes", async () => {
    const sourceRoot = await temporaryDirectory("burstpick-image-stat-source-");
    const cacheRoot = await temporaryDirectory("burstpick-image-stat-cache-");
    const sourcePath = join(sourceRoot, "source.png");
    await sharp({
      create: { background: "#224466", channels: 3, height: 18, width: 24 },
    })
      .png()
      .toFile(sourcePath);
    const initial = await stat(sourcePath);
    const adapter = new SharpImageAdapter({ cacheRoot });

    await adapter.thumbnail(sourcePath, { height: 12, width: 12 });
    const changedTime = new Date(initial.mtimeMs + 60_000);
    await utimes(sourcePath, changedTime, changedTime);
    await adapter.thumbnail(sourcePath, { height: 12, width: 12 });

    await sharp({
      create: { background: "#aa7733", channels: 3, height: 31, width: 47 },
    })
      .png()
      .toFile(sourcePath);
    await utimes(sourcePath, changedTime, changedTime);
    expect((await stat(sourcePath)).size).not.toBe(initial.size);
    await adapter.thumbnail(sourcePath, { height: 12, width: 12 });

    expect(
      (await readdir(join(cacheRoot, "thumbnails"))).filter((name) => name.endsWith(".jpg")),
    ).toHaveLength(3);
  });

  it("requests 9 by 8 grayscale raw pixels for the difference hash", async () => {
    const cacheRoot = await temporaryDirectory("burstpick-image-hash-");
    const pixels = Buffer.from(
      Array.from({ length: 72 }, (_, index) => Math.floor(index / 9) * 9 + (index % 9)),
    );
    const image = await sharp(pixels, { raw: { channels: 1, height: 8, width: 9 } })
      .png()
      .toBuffer();
    const adapter = new SharpImageAdapter({ cacheRoot });

    await expect(adapter.differenceHash(image)).resolves.toBe("0000000000000000");
  });

  it("preserves row-major layout for a single isolated dHash bit", async () => {
    const cacheRoot = await temporaryDirectory("burstpick-image-hash-layout-");
    const pixels = Buffer.from(
      Array.from({ length: 72 }, (_, index) => {
        const row = Math.floor(index / 9);
        const column = index % 9;
        return row === 3 && column === 5 ? 3 : column;
      }),
    );
    const image = await sharp(pixels, { raw: { channels: 1, height: 8, width: 9 } })
      .png()
      .toBuffer();
    const adapter = new SharpImageAdapter({ cacheRoot });

    await expect(adapter.differenceHash(image)).resolves.toBe("0000000800000000");
  });

  it("decodes and reports auto-oriented image dimensions", async () => {
    const cacheRoot = await temporaryDirectory("burstpick-image-inspect-");
    const image = await sharp({
      create: { background: "#ffffff", channels: 3, height: 3, width: 7 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const adapter = new SharpImageAdapter({ cacheRoot });

    await expect(adapter.inspect(image)).resolves.toEqual({ format: "jpeg", height: 7, width: 3 });
  });
});
