import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { AlbumSessionSchema, type AlbumSession, type Rating } from "../../shared/domain.js";
import { SharpImageAdapter, type ImageAdapter } from "../adapters/image.js";
import { createMetadataAdapter, type MetadataAdapter } from "../adapters/metadata.js";
import {
  createMetadataExportService,
  normalizeProtectedMetadata,
} from "./metadata-export.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function rawTags(contents: string): Record<string, unknown> {
  const attribute = (name: string) => new RegExp(`${name}="([^"]*)"`, "u").exec(contents)?.[1];
  return {
    SourceFile: "/secret/fixture.xmp",
    Rating: Number(attribute("xmp:Rating") ?? /RATING="(\d)"/u.exec(contents)?.[1] ?? 0),
    MetadataDate: attribute("xmp:MetadataDate"),
    ProcessVersion: attribute("crs:ProcessVersion"),
    Exposure2012: attribute("crs:Exposure2012"),
    Contrast2012: attribute("crs:Contrast2012"),
    Texture: attribute("crs:Texture"),
    CameraProfile: attribute("crs:CameraProfile"),
  };
}

function tagValue(tags: Record<string, unknown>, name: string): unknown {
  return Object.entries(tags).find(([key]) => (key.split(":").at(-1) ?? key) === name)?.[1];
}

function metadataAdapter(): MetadataAdapter {
  return {
    read: vi.fn(async () => ({})),
    readRaw: vi.fn(async (path: string) => rawTags(await readFile(path, "utf8"))),
    writeRating: vi.fn(async (path: string, rating: Rating) => {
      const before = await readFile(path, "utf8");
      const next = /xmp:Rating="[^"]*"/u.test(before)
        ? before.replace(/xmp:Rating="[^"]*"/u, `xmp:Rating="${rating}"`)
        : before.includes("<rdf:Description")
          ? before.replace("<rdf:Description", `<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${rating}"`)
          : `${before}\nRATING="${rating}"`;
      await writeFile(path, next);
    }),
    extractPreview: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
  };
}

function imageAdapter(): ImageAdapter {
  return {
    assertCacheOutsideSource: vi.fn(async () => undefined),
    thumbnail: vi.fn(async () => Buffer.from("decoded")),
    differenceHash: vi.fn(async () => "0000000000000000"),
    inspect: vi.fn(async () => ({ format: "jpeg", width: 24, height: 16 })),
  };
}

function session(root: string, rating: Rating, withJpeg = false, withXmp = true): AlbumSession {
  const rawPath = join(root, "IMG_0001.ARW");
  const xmpPath = join(root, "IMG_0001.xmp");
  return AlbumSessionSchema.parse({
    schemaVersion: 1,
    sourcePathHash: "source-hash",
    inventoryFingerprint: "inventory-hash",
    photos: [{
      id: "photo-1",
      stem: "IMG_0001",
      raw: { kind: "raw", path: rawPath, relativePath: "IMG_0001.ARW", size: 3, modifiedAtMs: 1 },
      ...(withJpeg ? { jpeg: { kind: "jpeg", path: join(root, "IMG_0001.JPG"), relativePath: "IMG_0001.JPG", size: 4, modifiedAtMs: 1 } } : {}),
      ...(withXmp ? { xmp: { kind: "xmp", path: xmpPath, relativePath: "IMG_0001.xmp", size: 1, modifiedAtMs: 1 } } : {}),
      capturedAtMs: 1,
      captureTimeSource: "exif",
      rating,
    }],
    groups: [{ id: "group-1", photoIds: ["photo-1"], startedAtMs: 1, endedAtMs: 1, confidence: 1, manual: false }],
    groupingSensitivity: 1,
    history: [],
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
}

async function fixture(rating: Rating, withJpeg = false, withXmp = true) {
  const root = await mkdtemp(join(tmpdir(), "burstpick-export-"));
  const appDataRoot = await mkdtemp(join(tmpdir(), "burstpick-audit-"));
  roots.push(root, appDataRoot);
  await writeFile(join(root, "IMG_0001.ARW"), "raw");
  if (withXmp) await copyFile(join(process.cwd(), "tests/fixtures/existing-lightroom.xmp"), join(root, "IMG_0001.xmp"));
  if (withJpeg) await writeFile(join(root, "IMG_0001.JPG"), "jpeg");
  const rawInfo = await stat(join(root, "IMG_0001.ARW"));
  const xmpInfo = withXmp ? await stat(join(root, "IMG_0001.xmp")) : undefined;
  const jpegInfo = withJpeg ? await stat(join(root, "IMG_0001.JPG")) : undefined;
  const value = session(root, rating, withJpeg, withXmp);
  const photo = value.photos[0]!;
  const fixed = AlbumSessionSchema.parse({ ...value, photos: [{ ...photo,
    raw: { ...photo.raw!, size: rawInfo.size, modifiedAtMs: rawInfo.mtimeMs },
    ...(photo.xmp === undefined ? {} : { xmp: { ...photo.xmp, size: xmpInfo!.size, modifiedAtMs: xmpInfo!.mtimeMs } }),
    ...(photo.jpeg === undefined ? {} : { jpeg: { ...photo.jpeg, size: jpegInfo!.size, modifiedAtMs: jpegInfo!.mtimeMs } }),
  }] });
  return { root, appDataRoot, session: fixed };
}

describe("transactional Lightroom metadata export", () => {
  it("reports real scanning, writing, and verification progress", async () => {
    const setup = await fixture(4);
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const progress: Array<{ phase: string; completed: number; total: number; relativePath?: string | undefined }> = [];

    const preview = await exporter.preview(context, {}, { onProgress: (value) => progress.push(value) });
    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }, { onProgress: (value) => progress.push(value) });

    expect(progress).toContainEqual({ phase: "scanning", completed: 1, total: 1, relativePath: "IMG_0001.xmp" });
    expect(progress).toContainEqual({ phase: "writing", completed: 1, total: 1, relativePath: "IMG_0001.xmp" });
    expect(progress).toContainEqual({ phase: "verifying", completed: 1, total: 1, relativePath: "IMG_0001.xmp" });
  });

  it("honors an aborted metadata export before scanning", async () => {
    const setup = await fixture(4);
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const controller = new AbortController();
    controller.abort();

    await expect(exporter.preview(context, {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts safely between preparation and installation", async () => {
    const setup = await fixture(4);
    const original = await readFile(join(setup.root, "IMG_0001.xmp"));
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    const controller = new AbortController();

    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }, {
      signal: controller.signal,
      onProgress(progress) { if (progress.phase === "writing") controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(join(setup.root, "IMG_0001.xmp"))).toEqual(original);
  });

  it("keeps nested error-shaped metadata protected and rejects ExifTool errors", () => {
    expect(normalizeProtectedMetadata({ Rating: 2, nested: { errors: ["camera profile"] } }))
      .toEqual({ nested: { errors: ["camera profile"] } });
    expect(() => normalizeProtectedMetadata({ Error: "bad file" })).toThrow(/ExifTool/u);
  });

  it("ignores MP layout offsets while keeping substantive metadata protected", () => {
    expect(normalizeProtectedMetadata({ MPImageStart: 4846592, MPImageLength: 485_000, CameraModelName: "Canon R5" }))
      .toEqual({ CameraModelName: "Canon R5" });
  });

  it("targets only the XMP sidecar for a proprietary RAW and JPEG pair", async () => {
    const setup = await fixture(4, true);
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };

    const preview = await exporter.preview(context, {});

    expect(preview.items.map(({ kind }) => kind)).toEqual(["xmp"]);
    expect(preview.ready).toBe(1);
  });

  it("keeps a standalone JPEG as a direct rating target", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-jpeg-only-"));
    const appDataRoot = await mkdtemp(join(tmpdir(), "burstpick-audit-"));
    roots.push(root, appDataRoot);
    const jpegPath = join(root, "ONLY.JPG");
    await writeFile(jpegPath, "jpeg");
    const details = await stat(jpegPath);
    const value = AlbumSessionSchema.parse({
      schemaVersion: 1, sourcePathHash: "jpeg-source", inventoryFingerprint: "jpeg-inventory",
      photos: [{ id: "jpeg", stem: "ONLY", jpeg: { kind: "jpeg", path: jpegPath, relativePath: "ONLY.JPG", size: details.size, modifiedAtMs: details.mtimeMs }, capturedAtMs: 1, captureTimeSource: "file-mtime", rating: 3 }],
      groups: [{ id: "jpeg-group", photoIds: ["jpeg"], startedAtMs: 1, endedAtMs: 1, confidence: 1, manual: false }],
      groupingSensitivity: 1, history: [], updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot });

    const preview = await exporter.preview({ albumId: "jpeg-album", isDemo: false, sourceRoot: root, session: value }, {});

    expect(preview.items.map(({ kind }) => kind)).toEqual(["jpeg"]);
  });

  it("removes ExifTool backup files created for transaction temporaries", async () => {
    const setup = await fixture(4);
    const metadata = metadataAdapter();
    vi.mocked(metadata.writeRating).mockImplementation(async (path, rating) => {
      await writeFile(`${path}_original`, await readFile(path));
      const before = await readFile(path, "utf8");
      await writeFile(path, before.replace(/xmp:Rating="[^"]*"/u, `xmp:Rating="${rating}"`));
    });
    const exporter = createMetadataExportService({ metadata, images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});

    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });

    expect((await readdir(setup.root)).filter((name) => name.endsWith("_original"))).toEqual([]);
  });

  it("auto-clears corrupt or stale locks but blocks when lock owner is alive", async () => {
    const setup = await fixture(4);
    const key = createHash("sha256").update(JSON.stringify(await realpath(setup.root))).digest("hex");
    const lockRoot = join(setup.appDataRoot, "metadata-export-locks");
    await mkdir(lockRoot, { recursive: true });
    // Valid lock from current process → should block
    await writeFile(join(lockRoot, `${key}.lock`), JSON.stringify({ sourceRootHash: key, pid: process.pid }));
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    await expect(exporter.preview(context, {})).rejects.toMatchObject({ code: "EXPORT_LOCKED" });

    // Corrupt lock → should auto-clear
    await writeFile(join(lockRoot, `${key}.lock`), "garbage");
    const exporter2 = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    await expect(exporter2.preview(context, {})).resolves.toBeDefined();
  });

  it("changes only Rating in an existing Lightroom sidecar", async () => {
    const setup = await fixture(4);
    const metadata = metadataAdapter();
    const exporter = createMetadataExportService({ metadata, images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const before = await metadata.readRaw(join(setup.root, "IMG_0001.xmp"));
    const preview = await exporter.preview(context, {});
    const result = await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
    const after = await metadata.readRaw(join(setup.root, "IMG_0001.xmp"));

    expect(after.Rating).toBe(4);
    expect(normalizeProtectedMetadata(after)).toEqual(normalizeProtectedMetadata(before));
    expect(result.items[0]?.status).toBe("written");
  });

  it("restores a standalone JPEG when verification fails", async () => {
    const setup = await fixture(5, true);
    const originalJpeg = await readFile(join(setup.root, "IMG_0001.JPG"));
    const paired = setup.session.photos[0]!;
    const jpegOnlySession = AlbumSessionSchema.parse({
      ...setup.session,
      photos: [{
        id: paired.id, stem: paired.stem, jpeg: paired.jpeg,
        capturedAtMs: paired.capturedAtMs, captureTimeSource: paired.captureTimeSource,
        rating: paired.rating,
      }],
    });
    const images = imageAdapter();
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images, appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: jpegOnlySession };
    const preview = await exporter.preview(context, {});
    let postPreviewInspections = 0;
    vi.mocked(images.inspect).mockImplementation(async () => {
      postPreviewInspections += 1;
      if (postPreviewInspections === 2) throw new Error("decode failed after replacement");
      return { format: "jpeg", height: 16, width: 24 };
    });

    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "PAIR_VERIFY_FAILED" });
    expect(await readFile(join(setup.root, "IMG_0001.JPG"))).toEqual(originalJpeg);
  });

  it("retains the recovery-owned backup when install and restore both fail", async () => {
    const setup = await fixture(5);
    const original = await readFile(join(setup.root, "IMG_0001.xmp"));
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => {
        if (stage === "install") throw new Error("injected install failure");
        if (stage === "restore") throw new Error("injected restore failure");
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});

    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const sourceArtifacts = await readdir(setup.root);
    const retained = sourceArtifacts.find((name) => name.includes(".backup.xmp"));
    expect(retained).toBeDefined();
    expect(await readFile(join(setup.root, retained!))).toEqual(original);
    const audits = (await readdir(join(setup.appDataRoot, "metadata-exports"))).filter((name) => /^[0-9a-f]{32}$/u.test(name));
    const failedAudit = await readFile(join(setup.appDataRoot, "metadata-exports", audits[0]!, "failed.json"), "utf8");
    expect(failedAudit).not.toContain(setup.root);
    expect(JSON.parse(failedAudit)).toMatchObject({ retainedBackup: true, recovery: "failed", stage: "install" });
  });

  it("detects an edit between final check and rename and restores that edit", async () => {
    const setup = await fixture(5);
    const changed = "changed just before rename";
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage, detail) => {
        if (stage === "before-original-rename") await writeFile(detail.target!, changed);
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});

    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await readFile(join(setup.root, "IMG_0001.xmp"), "utf8")).toBe(changed);
  });

  it("never overwrites a target recreated between rename and no-clobber install", async () => {
    const setup = await fixture(5);
    const concurrent = "concurrent Lightroom recreation";
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage, detail) => {
        if (stage === "after-original-rename") await writeFile(detail.target!, concurrent);
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});

    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await readFile(join(setup.root, "IMG_0001.xmp"), "utf8")).toBe(concurrent);
    expect((await readdir(setup.root)).some((name) => name.includes(".backup.xmp"))).toBe(true);
  });

  it("serializes an overlapping commit and rollback for the same canonical root", async () => {
    const setup = await fixture(5);
    const original = await readFile(join(setup.root, "IMG_0001.xmp"));
    let signalRenamed!: () => void;
    let continueCommit!: () => void;
    const renamed = new Promise<void>((resolve) => { signalRenamed = resolve; });
    const resume = new Promise<void>((resolve) => { continueCommit = resolve; });
    const first = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => {
        if (stage === "after-original-rename") {
          signalRenamed();
          await resume;
        }
      },
    });
    const second = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await first.preview(context, {});
    const committing = first.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
    await renamed;
    const rollingBack = second.rollback(context, {});
    continueCommit();

    await expect(committing).resolves.toMatchObject({ written: 1 });
    await expect(rollingBack).resolves.toMatchObject({ items: [{ status: "rolled-back" }] });
    expect(await readFile(join(setup.root, "IMG_0001.xmp"))).toEqual(original);
  });

  it("reports cleanup warnings and suppresses stale rollback availability", async () => {
    const setup = await fixture(5);
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => { if (stage === "cleanup") throw new Error("injected cleanup failure"); },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    const committed = await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
    const rolledBack = await exporter.rollback(context, {});

    expect(committed.warnings).toContain("导出已成功，但清理事务备份失败；已保留文件供支持人员检查。");
    expect(rolledBack.warnings).toEqual(expect.arrayContaining([
      "回滚已成功，但清理事务备份失败；已保留文件供支持人员检查。",
      "回滚已成功，但清理最近导出标记失败；请保留审计文件供支持人员检查。",
    ]));
    await expect(exporter.latest(context)).resolves.toEqual({ available: false });
  });

  it("falls back to a second redacted failed-audit publication", async () => {
    const setup = await fixture(5);
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => {
        if (stage === "prepare-copy" || stage === "failed-audit-publication") throw new Error(`injected ${stage}`);
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "PAIR_VERIFY_FAILED" });
    const auditIds = (await readdir(join(setup.appDataRoot, "metadata-exports"))).filter((name) => /^[0-9a-f]{32}$/u.test(name));
    const files = await readdir(join(setup.appDataRoot, "metadata-exports", auditIds[0]!));
    expect(files).toContain("failed-fallback.json");
    const contents = await readFile(join(setup.appDataRoot, "metadata-exports", auditIds[0]!, "failed-fallback.json"), "utf8");
    expect(contents).not.toContain(setup.root);
  });

  it("returns a localized warning when successful lock cleanup fails", async () => {
    const setup = await fixture(4);
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => { if ((stage as string) === "lock-cleanup") throw new Error("injected lock cleanup"); },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    expect(preview.warnings).toContain("操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。");

    const closeSetup = await fixture(4);
    const closeService = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: closeSetup.appDataRoot,
      failureInjection: async (stage) => { if (stage === "lock-close") throw new Error("injected lock close"); },
    });
    const closePreview = await closeService.preview({ albumId: "close", isDemo: false, sourceRoot: closeSetup.root, session: closeSetup.session }, {});
    expect(closePreview.warnings).toContain("操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。");

    const commitSetup = await fixture(4);
    let failCommitCleanup = false;
    const commitService = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: commitSetup.appDataRoot,
      failureInjection: async (stage) => { if (failCommitCleanup && stage === "lock-cleanup") throw new Error("injected commit lock cleanup"); },
    });
    const commitContext = { albumId: "commit", isDemo: false, sourceRoot: commitSetup.root, session: commitSetup.session };
    const commitPreview = await commitService.preview(commitContext, {});
    failCommitCleanup = true;
    const committed = await commitService.commit(commitContext, { confirmationId: commitPreview.confirmationId!, lightroomSavedAndClosed: true });
    expect(committed.warnings).toContain("操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。");

    const rollbackSetup = await fixture(4);
    let failRollbackCleanup = false;
    const rollbackService = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: rollbackSetup.appDataRoot,
      failureInjection: async (stage) => { if (failRollbackCleanup && stage === "lock-cleanup") throw new Error("injected rollback lock cleanup"); },
    });
    const rollbackContext = { albumId: "rollback", isDemo: false, sourceRoot: rollbackSetup.root, session: rollbackSetup.session };
    const rollbackPreview = await rollbackService.preview(rollbackContext, {});
    await rollbackService.commit(rollbackContext, { confirmationId: rollbackPreview.confirmationId!, lightroomSavedAndClosed: true });
    failRollbackCleanup = true;
    const rolledBack = await rollbackService.rollback(rollbackContext, {});
    expect(rolledBack.warnings).toContain("操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。");
  });

  it("fails safely when both failed-audit publications fail", async () => {
    const setup = await fixture(4);
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => {
        if (stage === "prepare-copy" || stage === "failed-audit-publication" || (stage as string) === "failed-audit-fallback-publication") {
          throw new Error(`injected ${stage}`);
        }
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "AUDIT_PERSIST_FAILED", recovery: { auditRetained: false, retainedBackup: false } });
  });

  it("preserves the primary error and attaches a safe lock-cleanup warning", async () => {
    const setup = await fixture(4);
    let failCleanup = false;
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => {
        if (stage === "prepare-copy" || (failCleanup && stage === "lock-cleanup")) throw new Error(`injected ${stage}`);
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    failCleanup = true;
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({
        code: "PAIR_VERIFY_FAILED",
        cleanupWarnings: ["操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。"],
      });
  });

  it("reports truthful recovery details when a concurrent new target is preserved", async () => {
    const setup = await fixture(4, false, false);
    const concurrent = "concurrent sidecar";
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage, detail) => {
        if (stage === "install") await writeFile(detail.target!, concurrent);
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({
        code: "RECOVERY_REQUIRED",
        recovery: { auditRetained: true, concurrentTargetPreserved: true, createdTargetRemoved: false, retainedBackup: false },
      });
    expect(await readFile(join(setup.root, "IMG_0001.xmp"), "utf8")).toBe(concurrent);
  });

  it("covers preparation write, audit copy, rename, latest publication, expiry, symlink escape, and acr preservation", async () => {
    const stages = ["prepare-write", "audit-backup-copy", "original-rename", "latest-publication"] as const;
    for (const stageToFail of stages) {
      const setup = await fixture(4, false, stageToFail !== "prepare-write");
      const target = join(setup.root, "IMG_0001.xmp");
      const before = stageToFail === "prepare-write" ? undefined : await readFile(target);
      const exporter = createMetadataExportService({
        metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
        failureInjection: async (stage) => { if (stage === stageToFail) throw new Error(`injected ${stage}`); },
      });
      const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
      const preview = await exporter.preview(context, {});
      await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true })).rejects.toBeInstanceOf(Error);
      if (before === undefined) await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(target)).toEqual(before);
    }

    const expiring = await fixture(4);
    let clock = 100;
    const expiryService = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: expiring.appDataRoot, now: () => clock, confirmationTtlMs: 10 });
    const expiryContext = { albumId: "album-1", isDemo: false, sourceRoot: expiring.root, session: expiring.session };
    const expiringPreview = await expiryService.preview(expiryContext, {});
    clock = 111;
    await expect(expiryService.commit(expiryContext, { confirmationId: expiringPreview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });

    const escaped = await fixture(4, false, false);
    const outside = await mkdtemp(join(tmpdir(), "burstpick-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "IMG_0001.xmp"), "outside");
    await symlink(join(outside, "IMG_0001.xmp"), join(escaped.root, "IMG_0001.xmp"));
    const escapedSession = AlbumSessionSchema.parse({ ...escaped.session, photos: escaped.session.photos.map((photo) => ({ ...photo, xmp: { kind: "xmp", path: join(escaped.root, "IMG_0001.xmp"), relativePath: "IMG_0001.xmp", size: 7, modifiedAtMs: 1 } })) });
    const escapeService = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: escaped.appDataRoot });
    const escapePreview = await escapeService.preview({ albumId: "escape", isDemo: false, sourceRoot: escaped.root, session: escapedSession }, {});
    expect(escapePreview).toMatchObject({ conflicts: 1 });
    expect(escapePreview).not.toHaveProperty("confirmationId");

    const acrSetup = await fixture(4);
    const acrPath = join(acrSetup.root, "IMG_0001.acr");
    await writeFile(acrPath, "ACR-BYTES");
    const acrBefore = await stat(acrPath);
    const acrService = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: acrSetup.appDataRoot });
    const acrContext = { albumId: "acr", isDemo: false, sourceRoot: acrSetup.root, session: acrSetup.session };
    const acrPreview = await acrService.preview(acrContext, {});
    await acrService.commit(acrContext, { confirmationId: acrPreview.confirmationId!, lightroomSavedAndClosed: true });
    const acrAfter = await stat(acrPath);
    expect(await readFile(acrPath, "utf8")).toBe("ACR-BYTES");
    expect(acrAfter.mtimeMs).toBe(acrBefore.mtimeMs);
  });

  it("rejects an inside-root same-stem XMP symlink without touching unrelated metadata", async () => {
    const setup = await fixture(4, false, false);
    const unrelated = join(setup.root, "unrelated.xmp");
    const target = join(setup.root, "IMG_0001.xmp");
    await writeFile(unrelated, "UNRELATED-XMP");
    await symlink(unrelated, target);
    const descriptor = await stat(target);
    const session = AlbumSessionSchema.parse({
      ...setup.session,
      photos: setup.session.photos.map((photo) => ({
        ...photo,
        xmp: { kind: "xmp", path: target, relativePath: "IMG_0001.xmp", size: descriptor.size, modifiedAtMs: descriptor.mtimeMs },
      })),
    });
    const beforeBytes = await readFile(unrelated);
    const before = await stat(unrelated);
    const service = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });

    const preview = await service.preview({ albumId: "inside-symlink", isDemo: false, sourceRoot: setup.root, session }, {});

    expect(preview.conflicts).toBe(1);
    expect(preview).not.toHaveProperty("confirmationId");
    expect(await readFile(unrelated)).toEqual(beforeBytes);
    expect((await stat(unrelated)).mtimeMs).toBe(before.mtimeMs);
  });

  it("preserves the exported target on rollback no-clobber failure and surfaces double audit failure", async () => {
    for (const failAudit of [false, true]) {
      const setup = await fixture(5);
      let rollingBack = false;
      const exporter = createMetadataExportService({
        metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
        failureInjection: async (stage, detail) => {
          if (rollingBack && stage === "rollback-install") await writeFile(detail.target!, "concurrent rollback target");
          if (rollingBack && failAudit && (stage === "failed-audit-publication" || (stage as string) === "failed-audit-fallback-publication")) {
            throw new Error(`injected ${stage}`);
          }
        },
      });
      const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
      const preview = await exporter.preview(context, {});
      await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
      rollingBack = true;
      await expect(exporter.rollback(context, {})).rejects.toMatchObject(failAudit
        ? { code: "AUDIT_PERSIST_FAILED", recovery: { auditRetained: false, concurrentTargetPreserved: true } }
        : { code: "RECOVERY_REQUIRED", recovery: { auditRetained: true, concurrentTargetPreserved: true } });
      expect(await readFile(join(setup.root, "IMG_0001.xmp"), "utf8")).toBe("concurrent rollback target");
      if (!failAudit) {
        const auditRoot = join(setup.appDataRoot, "metadata-exports");
        const auditId = (await readdir(auditRoot)).find((name) => /^[0-9a-f]{32}$/u.test(name))!;
        const failedName = (await readdir(join(auditRoot, auditId))).find((name) => name.startsWith("rollback-failed-"))!;
        expect(JSON.parse(await readFile(join(auditRoot, auditId, failedName), "utf8"))).toMatchObject({
          concurrentTargetPreserved: true,
          retainedBackup: true,
        });
      }
    }
  });

  it("reports a retained rollback backup without claiming an absent target was concurrent", async () => {
    const setup = await fixture(5);
    let rollingBack = false;
    const exporter = createMetadataExportService({
      metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot,
      failureInjection: async (stage) => {
        if (rollingBack && stage === "rollback-install") throw new Error("injected rollback install failure");
        if (rollingBack && (stage as string) === "rollback-restore") throw new Error("injected rollback restore failure");
      },
    });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
    rollingBack = true;

    await expect(exporter.rollback(context, {})).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      recovery: { auditRetained: true, concurrentTargetPreserved: false, retainedBackup: true },
    });
    await expect(readFile(join(setup.root, "IMG_0001.xmp"))).rejects.toMatchObject({ code: "ENOENT" });
    const auditRoot = join(setup.appDataRoot, "metadata-exports");
    const auditId = (await readdir(auditRoot)).find((name) => /^[0-9a-f]{32}$/u.test(name))!;
    const failedName = (await readdir(join(auditRoot, auditId))).find((name) => name.startsWith("rollback-failed-"))!;
    expect(JSON.parse(await readFile(join(auditRoot, auditId, failedName), "utf8"))).toMatchObject({
      concurrentTargetPreserved: false,
      retainedBackup: true,
    });
  });

  it("recovers when preparation metadata writing fails", async () => {
    const setup = await fixture(4);
    const original = await readFile(join(setup.root, "IMG_0001.xmp"));
    const metadata = metadataAdapter();
    vi.mocked(metadata.writeRating).mockRejectedValueOnce(new Error("injected metadata write"));
    const exporter = createMetadataExportService({ metadata, images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "PAIR_VERIFY_FAILED" });
    expect(await readFile(join(setup.root, "IMG_0001.xmp"))).toEqual(original);
    expect((await readdir(setup.root)).every((name) => !name.includes(".tmp.xmp"))).toBe(true);
  });

  it("rolls back only the completed export and keeps its audit path-redacted", async () => {
    const setup = await fixture(5);
    const original = await readFile(join(setup.root, "IMG_0001.xmp"));
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });

    const [auditId] = await readdir(join(setup.appDataRoot, "metadata-exports"));
    const audit = await readFile(join(setup.appDataRoot, "metadata-exports", auditId!, "audit.json"), "utf8");
    expect(audit).not.toContain(setup.root);
    expect(audit).not.toContain("Exposure2012");
    const restarted = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    await restarted.rollback(context, {});
    expect(await readFile(join(setup.root, "IMG_0001.xmp"))).toEqual(original);
    await expect(restarted.rollback(context, {})).rejects.toMatchObject({ code: "ROLLBACK_NOT_FOUND" });
  });

  it("rejects stale rollback targets and single-use confirmations", async () => {
    const setup = await fixture(4);
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true }))
      .rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    await writeFile(join(setup.root, "IMG_0001.xmp"), "changed after export");
    await expect(exporter.rollback(context, {})).rejects.toMatchObject({ code: "ROLLBACK_STALE" });
  });

  it("binds confirmation IDs to the immutable rating preview", async () => {
    const setup = await fixture(4);
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    const changed = AlbumSessionSchema.parse({
      ...setup.session,
      photos: setup.session.photos.map((photo) => ({ ...photo, rating: 5 })),
    });

    await expect(exporter.commit({ ...context, session: changed }, {
      confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true,
    })).rejects.toMatchObject({ code: "EXPORT_CONFLICT" });
    expect(rawTags(await readFile(join(setup.root, "IMG_0001.xmp"), "utf8")).Rating).toBe(2);
  });

  it("uses same-extension temporary files and never writes proprietary RAW", async () => {
    const setup = await fixture(3);
    const metadata = metadataAdapter();
    const exporter = createMetadataExportService({ metadata, images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });

    const writes = vi.mocked(metadata.writeRating).mock.calls.map(([path]) => path);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\.tmp\.xmp$/u);
    expect(writes[0]).not.toMatch(/\.ARW$/u);
    expect(await readFile(join(setup.root, "IMG_0001.ARW"), "utf8")).toBe("raw");
  });

  it("does not create an empty zero-rating sidecar", async () => {
    const setup = await fixture(0, false, false);
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});

    expect(preview).toMatchObject({ ready: 0, skipped: 1, conflicts: 0 });
    await expect(readFile(join(setup.root, "IMG_0001.xmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a standards XMP sidecar and removes it on explicit rollback", async () => {
    const setup = await fixture(4, false, false);
    const exporter = createMetadataExportService({ metadata: metadataAdapter(), images: imageAdapter(), appDataRoot: setup.appDataRoot });
    const context = { albumId: "album-1", isDemo: false, sourceRoot: setup.root, session: setup.session };
    const preview = await exporter.preview(context, {});
    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });

    const created = await readFile(join(setup.root, "IMG_0001.xmp"), "utf8");
    expect(created).toContain("<x:xmpmeta");
    expect(created).toContain('photoshop:SidecarForExtension="ARW"');
    expect(created).toContain('xmp:Rating="4"');
    await exporter.rollback(context, {});
    await expect(readFile(join(setup.root, "IMG_0001.xmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("embeds DNG ratings through a same-extension copy and verifies image decode", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-dng-"));
    const appDataRoot = await mkdtemp(join(tmpdir(), "burstpick-audit-"));
    roots.push(root, appDataRoot);
    const dngPath = join(root, "IMG_0002.DNG");
    await writeFile(dngPath, "dng-image");
    const details = await stat(dngPath);
    const value = AlbumSessionSchema.parse({
      schemaVersion: 1, sourcePathHash: "dng-source", inventoryFingerprint: "dng-inventory",
      photos: [{
        id: "dng-photo", stem: "IMG_0002",
        raw: { kind: "raw", path: dngPath, relativePath: "IMG_0002.DNG", size: details.size, modifiedAtMs: details.mtimeMs },
        capturedAtMs: 1, captureTimeSource: "exif", rating: 4,
      }],
      groups: [{ id: "dng-group", photoIds: ["dng-photo"], startedAtMs: 1, endedAtMs: 1, confidence: 1, manual: false }],
      groupingSensitivity: 1, history: [], rejectedIds: [], updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const metadata = metadataAdapter();
    const images = imageAdapter();
    const exporter = createMetadataExportService({ metadata, images, appDataRoot });
    const context = { albumId: "dng-album", isDemo: false, sourceRoot: root, session: value };
    const preview = await exporter.preview(context, {});
    await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });

    expect(vi.mocked(metadata.writeRating).mock.calls[0]?.[0]).toMatch(/\.tmp\.DNG$/u);
    expect(await readFile(dngPath, "utf8")).toContain('RATING="4"');
    expect(images.thumbnail).toHaveBeenCalled();
    expect(images.inspect).toHaveBeenCalled();
  });

  it("preserves real Sharp JPEG and TIFF-based DNG pixels and protected ExifTool tags", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-real-export-"));
    const appDataRoot = await mkdtemp(join(tmpdir(), "burstpick-real-audit-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "burstpick-real-cache-"));
    roots.push(root, appDataRoot, cacheRoot);
    const jpegPath = join(root, "REAL.JPG");
    const dngPath = join(root, "REAL.DNG");
    await sharp({ create: { width: 18, height: 12, channels: 3, background: { r: 25, g: 75, b: 125 } } }).jpeg({ quality: 95 }).toFile(jpegPath);
    await sharp({ create: { width: 14, height: 10, channels: 3, background: { r: 160, g: 90, b: 30 } } }).tiff().toFile(dngPath);
    const [jpegInfo, dngInfo] = await Promise.all([stat(jpegPath), stat(dngPath)]);
    const value = AlbumSessionSchema.parse({
      schemaVersion: 1, sourcePathHash: "real-source", inventoryFingerprint: "real-inventory",
      photos: [
        { id: "real-jpeg", stem: "REAL-JPEG", jpeg: { kind: "jpeg", path: jpegPath, relativePath: "REAL.JPG", size: jpegInfo.size, modifiedAtMs: jpegInfo.mtimeMs }, capturedAtMs: 1, captureTimeSource: "file-mtime", rating: 3 },
        { id: "real-dng", stem: "REAL-DNG", raw: { kind: "raw", path: dngPath, relativePath: "REAL.DNG", size: dngInfo.size, modifiedAtMs: dngInfo.mtimeMs }, capturedAtMs: 2, captureTimeSource: "file-mtime", rating: 5 },
      ],
      groups: [
        { id: "real-group-jpeg", photoIds: ["real-jpeg"], startedAtMs: 1, endedAtMs: 1, confidence: 1, manual: false },
        { id: "real-group-dng", photoIds: ["real-dng"], startedAtMs: 2, endedAtMs: 2, confidence: 1, manual: false },
      ],
      groupingSensitivity: 1, history: [], rejectedIds: [], updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const metadata = createMetadataAdapter();
    const images = new SharpImageAdapter({ cacheRoot });
    try {
      const beforeTags = await Promise.all([metadata.readRaw(jpegPath), metadata.readRaw(dngPath)]);
      const beforePixels = await Promise.all([sharp(jpegPath).raw().toBuffer(), sharp(dngPath).raw().toBuffer()]);
      const exporter = createMetadataExportService({ metadata, images, appDataRoot });
      const context = { albumId: "real-album", isDemo: false, sourceRoot: root, session: value };
      const preview = await exporter.preview(context, {});
      const result = await exporter.commit(context, { confirmationId: preview.confirmationId!, lightroomSavedAndClosed: true });
      const afterTags = await Promise.all([metadata.readRaw(jpegPath), metadata.readRaw(dngPath)]);
      const afterPixels = await Promise.all([sharp(jpegPath).raw().toBuffer(), sharp(dngPath).raw().toBuffer()]);

      expect(result.written).toBe(2);
      expect(afterTags.map((tags) => tagValue(tags, "Rating"))).toEqual([3, 5]);
      expect(afterTags.map(normalizeProtectedMetadata)).toEqual(beforeTags.map(normalizeProtectedMetadata));
      expect(afterPixels).toEqual(beforePixels);
      expect(await images.inspect(jpegPath)).toEqual({ format: "jpeg", width: 18, height: 12 });
      expect(await images.inspect(dngPath)).toEqual({ format: "tiff", width: 14, height: 10 });
    } finally {
      await metadata.end();
    }
  });

  it("keeps duplicate WhiteBalance namespaces stable when writing an XMP rating", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-xmp-namespaces-"));
    roots.push(root);
    const path = join(root, "DUPLICATE.xmp");
    await writeFile(path, `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" exif:WhiteBalance="0" crs:WhiteBalance="Custom" /></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`);
    const metadata = createMetadataAdapter();
    try {
      const before = normalizeProtectedMetadata(await metadata.readRaw(path));
      await metadata.writeRating(path, 1);
      const after = normalizeProtectedMetadata(await metadata.readRaw(path));

      expect(after).toEqual(before);
      expect(after).toMatchObject({ "XMP-exif:WhiteBalance": "Auto", "XMP-crs:WhiteBalance": "Custom" });
    } finally {
      await metadata.end();
    }
  });
});
