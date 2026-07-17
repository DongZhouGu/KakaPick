import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createImageAdapter } from "../../src/server/adapters/image.js";
import { createMetadataAdapter } from "../../src/server/adapters/metadata.js";
import { createMetadataExportService, normalizeProtectedMetadata } from "../../src/server/export/metadata-export.js";
import { scanAlbum } from "../../src/server/scanner.js";
import { SessionService } from "../../src/server/session-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const tagValue = (tags: Record<string, unknown>, name: string) => Object.entries(tags).find(([key]) => (key.split(":").at(-1) ?? key) === name)?.[1];
async function pixels(path: string) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  return { hash: hash(data), width: info.width, height: info.height, channels: info.channels };
}

describe("generated-folder metadata safety smoke", () => {
  it("changes only ratings and rollback restores every original byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-metadata-smoke-")); roots.push(root);
    const cacheRoot = await mkdtemp(join(tmpdir(), "burstpick-cache-smoke-")); roots.push(cacheRoot);
    const appDataRoot = await mkdtemp(join(tmpdir(), "burstpick-data-smoke-")); roots.push(appDataRoot);
    const jpeg = join(root, "PAIR.JPG");
    const raw = join(root, "PAIR.ARW");
    const xmp = join(root, "PAIR.xmp");
    const acr = join(root, "PAIR.acr");
    const dng = join(root, "STANDALONE.DNG");
    const raster = Buffer.alloc(64 * 48 * 3);
    raster.forEach((_value, index) => { raster[index] = index % 251; });
    await sharp(raster, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 92 }).toFile(jpeg);
    await sharp(raster, { raw: { width: 64, height: 48, channels: 3 } }).tiff({ compression: "lzw" }).toFile(dng);
    await writeFile(raw, Buffer.from("generated proprietary RAW placeholder\n"));
    await writeFile(acr, Buffer.from("generated Lightroom 15 ACR sidecar\n"));
    await writeFile(xmp, `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmp:Rating="2" crs:ProcessVersion="15.4" crs:Exposure2012="+0.35" crs:Contrast2012="+12" crs:Texture="8" crs:CameraProfile="Adobe Color" /></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`);

    const exif = new ExifTool({ maxProcs: 1 });
    await exif.write(jpeg, { Artist: "BurstPick safety fixture" });
    await exif.write(dng, { DNGVersion: "1.4.0.0", Artist: "BurstPick safety fixture" });
    await exif.end();

    const metadata = createMetadataAdapter();
    const images = createImageAdapter({ cacheRoot });
    try {
      const paths = [jpeg, raw, xmp, acr, dng];
      const beforeBytes = new Map(await Promise.all(paths.map(async (path) => [path, await readFile(path)] as const)));
      const beforeStats = new Map(await Promise.all([raw, acr].map(async (path) => [path, await stat(path)] as const)));
      const beforePixels = new Map(await Promise.all([jpeg, dng].map(async (path) => [path, await pixels(path)] as const)));
      const beforeProtected = new Map(await Promise.all([jpeg, dng, xmp].map(async (path) => [path, normalizeProtectedMetadata(await metadata.readRaw(path))] as const)));

      const scanned = await scanAlbum({ root, cacheRoot, images, metadata, sessionStore: { load: async () => undefined, save: async () => undefined } });
      expect(scanned.photos).toHaveLength(2);
      const { warnings, ...scannedSession } = scanned;
      expect(warnings).toEqual(expect.any(Array));
      const session = new SessionService(scannedSession, { save: async () => undefined });
      for (const photo of session.snapshot().photos) await session.ratePhoto(photo.id, 4);
      const context = { albumId: hash(root), isDemo: false, sourceRoot: root, session: session.snapshot() };
      const exporter = createMetadataExportService({ appDataRoot, images, metadata });
      const preview = await exporter.preview(context, {});
      expect(preview.conflicts).toBe(0);
      expect(preview.items.map((item) => item.label).sort()).toEqual(["PAIR.xmp", "STANDALONE.DNG"]);
      const committed = await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
      expect(committed.errors).toBe(0);

      for (const path of [dng, xmp]) {
        expect(Number(tagValue(await metadata.readRaw(path), "Rating"))).toBe(4);
        expect(normalizeProtectedMetadata(await metadata.readRaw(path))).toEqual(beforeProtected.get(path));
      }
      expect(await readFile(jpeg)).toEqual(beforeBytes.get(jpeg));
      expect(normalizeProtectedMetadata(await metadata.readRaw(jpeg))).toEqual(beforeProtected.get(jpeg));
      for (const path of [raw, acr]) {
        expect(await readFile(path)).toEqual(beforeBytes.get(path));
        expect((await stat(path)).mtimeMs).toBe(beforeStats.get(path)!.mtimeMs);
      }
      for (const path of [jpeg, dng]) expect(await pixels(path)).toEqual(beforePixels.get(path));

      const rolledBack = await exporter.rollback(context, {});
      expect(rolledBack.errors).toBe(0);
      for (const path of paths) expect(await readFile(path)).toEqual(beforeBytes.get(path));
    } finally {
      await metadata.end();
    }
  }, 120_000);
});
