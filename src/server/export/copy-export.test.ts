import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlbumSession, PhotoUnit, SourceFile } from "../../shared/domain.js";
import { createCopyExportService } from "./copy-export.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "burstpick-copy-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  const appDataRoot = join(root, "app-data");
  await Promise.all([mkdir(join(sourceRoot, "day"), { recursive: true }), mkdir(destinationRoot), mkdir(appDataRoot)]);
  return { appDataRoot, destinationRoot, sourceRoot };
}

function file<T extends SourceFile["kind"]>(path: string, relativePath: string, kind: T, contents: string): Extract<SourceFile, { kind: T }> {
  return { path, relativePath, kind, size: Buffer.byteLength(contents), modifiedAtMs: 0 } as Extract<SourceFile, { kind: T }>;
}

function session(photos: PhotoUnit[]): AlbumSession {
  return { schemaVersion: 1, sourcePathHash: "album", inventoryFingerprint: "inventory", boundaryOverrides: [], photos, groups: [], groupingSensitivity: 1, history: [], rejectedIds: [], updatedAt: new Date(0).toISOString() };
}

describe("collision-safe copy export", () => {
  it("copies RAW, JPEG and XMP for rated units and verifies hashes", async () => {
    const setupResult = await setup();
    const rawPath = join(setupResult.sourceRoot, "day/one.arw");
    const jpegPath = join(setupResult.sourceRoot, "day/one.jpg");
    const xmpPath = join(setupResult.sourceRoot, "day/one.xmp");
    await Promise.all([writeFile(rawPath, "raw"), writeFile(jpegPath, "jpeg"), writeFile(xmpPath, "xmp")]);
    const photo: PhotoUnit = {
      id: "one", stem: "one", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 5,
      raw: file(rawPath, "day/one.arw", "raw", "raw"),
      jpeg: file(jpegPath, "day/one.jpg", "jpeg", "jpeg"),
      xmp: file(xmpPath, "day/one.xmp", "xmp", "xmp"),
    };
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot });
    const preview = await exporter.preview({ albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) }, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    expect(preview.items.map((item) => item.relativePath)).toEqual(["day/one.arw", "day/one.jpg", "day/one.xmp"]);
    expect(Object.keys(preview.items[0]!).sort()).toEqual(["generated", "relativePath", "sha256", "size", "status"]);
    const result = await exporter.commit({ albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) }, { confirmationId: preview.confirmationId! });
    expect(result.counts).toEqual({ copied: 3, skipped: 0, conflicts: 0, failed: 0 });
    await expect(readFile(join(setupResult.destinationRoot, "day/one.arw"), "utf8")).resolves.toBe("raw");
  });

  it("reports preparation progress once for every selected photo", async () => {
    const setupResult = await setup();
    const paths = [join(setupResult.sourceRoot, "day/one.jpg"), join(setupResult.sourceRoot, "day/two.jpg")];
    await Promise.all(paths.map((path) => writeFile(path, path)));
    const photos: PhotoUnit[] = paths.map((path, index) => ({
      id: String(index), stem: String(index), capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1,
      jpeg: file(path, `day/${index === 0 ? "one" : "two"}.jpg`, "jpeg", path),
    }));
    const onProgress = vi.fn();

    await createCopyExportService({ appDataRoot: setupResult.appDataRoot }).preview(
      { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session(photos) },
      { destinationRoot: setupResult.destinationRoot, minRating: 1 },
      { onProgress },
    );

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2, relativePath: "day/one.jpg" },
      { completed: 2, total: 2, relativePath: "day/two.jpg" },
    ]);
  });

  it("reports different existing content and never overwrites it", async () => {
    const setupResult = await setup();
    const rawPath = join(setupResult.sourceRoot, "day/one.arw");
    const destinationFile = join(setupResult.destinationRoot, "day/one.arw");
    await mkdir(join(setupResult.destinationRoot, "day"));
    await Promise.all([writeFile(rawPath, "source"), writeFile(destinationFile, "keep me")]);
    const photo: PhotoUnit = { id: "one", stem: "one", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, raw: file(rawPath, "day/one.arw", "raw", "source") };
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot });
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    expect(preview.items.find((item) => item.relativePath === "day/one.arw")?.status).toBe("conflict");
    const result = await exporter.commit(context, { confirmationId: preview.confirmationId! });
    expect(result.counts.conflicts).toBe(1);
    await expect(readFile(destinationFile, "utf8")).resolves.toBe("keep me");
  });

  it("includes only rated units, skips exact copies, and generates rated XMP only in the destination", async () => {
    const setupResult = await setup();
    const selectedPath = join(setupResult.sourceRoot, "day/selected.nef");
    const rejectedPath = join(setupResult.sourceRoot, "day/rejected.jpg");
    await Promise.all([writeFile(selectedPath, "raw"), writeFile(rejectedPath, "jpeg"), mkdir(join(setupResult.destinationRoot, "day"))]);
    await writeFile(join(setupResult.destinationRoot, "day/selected.nef"), "raw");
    const selected: PhotoUnit = { id: "selected", stem: "selected", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 4, raw: file(selectedPath, "day/selected.nef", "raw", "raw") };
    const rejected: PhotoUnit = { id: "rejected", stem: "rejected", capturedAtMs: 1, captureTimeSource: "file-mtime", rating: 0, jpeg: file(rejectedPath, "day/rejected.jpg", "jpeg", "jpeg") };
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot });
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([selected, rejected]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    expect(preview.items.map(({ relativePath, status, generated }) => ({ relativePath, status, generated }))).toEqual([
      { relativePath: "day/selected.nef", status: "skip", generated: false },
      { relativePath: "day/selected.xmp", status: "copy", generated: true },
    ]);
    const result = await exporter.commit(context, { confirmationId: preview.confirmationId! });
    expect(result.counts).toEqual({ copied: 1, skipped: 1, conflicts: 0, failed: 0 });
    expect(await readFile(join(setupResult.destinationRoot, "day/selected.xmp"), "utf8")).toContain('xmp:Rating="4"');
    await expect(readFile(join(setupResult.sourceRoot, "day/selected.xmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers an XMP sidecar that appeared after scanning", async () => {
    const setupResult = await setup();
    const rawPath = join(setupResult.sourceRoot, "day/late.arw");
    await writeFile(rawPath, "raw");
    const photo: PhotoUnit = { id: "late", stem: "late", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 2, raw: file(rawPath, "day/late.arw", "raw", "raw") };
    await writeFile(join(setupResult.sourceRoot, "day/LATE.XMP"), "late-sidecar");
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot });
    const preview = await exporter.preview({ albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) }, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    expect(preview.items.find(({ relativePath }) => relativePath.toLocaleLowerCase("en-US") === "day/late.xmp")).toMatchObject({ generated: false });
  });

  it("rejects stale sources and consumes confirmations even on failure", async () => {
    const setupResult = await setup();
    const rawPath = join(setupResult.sourceRoot, "day/stale.arw");
    await writeFile(rawPath, "before");
    const photo: PhotoUnit = { id: "stale", stem: "stale", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, raw: file(rawPath, "day/stale.arw", "raw", "before") };
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot });
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await writeFile(rawPath, "after");
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("expires confirmations", async () => {
    const setupResult = await setup();
    const jpegPath = join(setupResult.sourceRoot, "day/expiry.jpg");
    await writeFile(jpegPath, "jpeg");
    const photo: PhotoUnit = { id: "expiry", stem: "expiry", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(jpegPath, "day/expiry.jpg", "jpeg", "jpeg") };
    let now = 1;
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, confirmationTtlMs: 5, now: () => now });
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    now = 7;
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    const abandoned = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    now = 13;
    await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await expect(exporter.commit(context, { confirmationId: abandoned.confirmationId! })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("rejects source symlink escapes and case-folded target collisions", async () => {
    const setupResult = await setup();
    const outside = join(setupResult.destinationRoot, "outside.jpg");
    const escaped = join(setupResult.sourceRoot, "day/escaped.jpg");
    await writeFile(outside, "outside");
    await symlink(outside, escaped);
    const escapedPhoto: PhotoUnit = { id: "escaped", stem: "escaped", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(escaped, "day/escaped.jpg", "jpeg", "outside") };
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, platform: "darwin" });
    await expect(exporter.preview({ albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([escapedPhoto]) }, { destinationRoot: setupResult.destinationRoot, minRating: 1 })).rejects.toMatchObject({ code: "UNSAFE_COPY_PATH" });

    await rm(escaped);
    const upper = join(setupResult.sourceRoot, "day/A.jpg");
    const lower = join(setupResult.sourceRoot, "day/a.jpg");
    await Promise.all([writeFile(upper, "A"), writeFile(lower, "a")]);
    const photos: PhotoUnit[] = [
      { id: "A", stem: "A", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(upper, "day/A.jpg", "jpeg", "A") },
      { id: "a", stem: "a", capturedAtMs: 1, captureTimeSource: "file-mtime", rating: 1, jpeg: file(lower, "day/a.jpg", "jpeg", "a") },
    ];
    await expect(exporter.preview({ albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session(photos) }, { destinationRoot: setupResult.destinationRoot, minRating: 1 })).rejects.toMatchObject({ code: "UNSAFE_COPY_PATH" });
  });

  it("rejects case-folded nested roots and destination ancestor symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-copy-case-"));
    roots.push(root);
    const sourceRoot = join(root, "Source");
    const destinationRoot = join(root, "source/nested");
    const appDataRoot = join(root, "app-data");
    await mkdir(sourceRoot);
    await Promise.all([mkdir(destinationRoot, { recursive: true }), mkdir(appDataRoot)]);
    const sourcePath = join(sourceRoot, "one.jpg");
    await writeFile(sourcePath, "one");
    const photo: PhotoUnit = { id: "one", stem: "one", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(sourcePath, "one.jpg", "jpeg", "one") };
    const exporter = createCopyExportService({ appDataRoot, platform: "darwin" });
    await expect(exporter.preview({ albumId: "album", isDemo: false, sourceRoot, session: session([photo]) }, { destinationRoot, minRating: 1 })).rejects.toMatchObject({ code: "UNSAFE_COPY_PATH" });

    const safeDestination = join(root, "safe-destination");
    const outside = join(root, "outside");
    await Promise.all([mkdir(safeDestination), mkdir(outside), mkdir(join(sourceRoot, "escape"))]);
    await symlink(outside, join(safeDestination, "escape"));
    const escapedSource = join(sourceRoot, "escape/one.jpg");
    await writeFile(escapedSource, "one");
    const escapedPhoto: PhotoUnit = { ...photo, jpeg: file(escapedSource, "escape/one.jpg", "jpeg", "one") };
    await expect(exporter.preview({ albumId: "album", isDemo: false, sourceRoot, session: session([escapedPhoto]) }, { destinationRoot: safeDestination, minRating: 1 })).rejects.toMatchObject({ code: "UNSAFE_COPY_PATH" });
  });

  it("handles an install race without overwriting the winner", async () => {
    const setupResult = await setup();
    const jpegPath = join(setupResult.sourceRoot, "day/race.jpg");
    await writeFile(jpegPath, "source");
    const photo: PhotoUnit = { id: "race", stem: "race", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(jpegPath, "day/race.jpg", "jpeg", "source") };
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "before-install" && detail.relativePath === "day/race.jpg") await writeFile(join(setupResult.destinationRoot, "day/race.jpg"), "winner");
    } });
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    const result = await exporter.commit(context, { confirmationId: preview.confirmationId! });
    expect(result.counts.conflicts).toBe(1);
    await expect(readFile(join(setupResult.destinationRoot, "day/race.jpg"), "utf8")).resolves.toBe("winner");
  });

  it("rejects replacement of the confirmed destination root", async () => {
    const setupResult = await setup();
    const jpegPath = join(setupResult.sourceRoot, "day/root-race.jpg");
    await writeFile(jpegPath, "source");
    const photo: PhotoUnit = { id: "root-race", stem: "root-race", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(jpegPath, "day/root-race.jpg", "jpeg", "source") };
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot });
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    const originalDestination = `${setupResult.destinationRoot}-original`;
    const outside = `${setupResult.destinationRoot}-outside`;
    await rename(setupResult.destinationRoot, originalDestination);
    await mkdir(outside);
    await symlink(outside, setupResult.destinationRoot);
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "UNSAFE_COPY_PATH" });
    await expect(readFile(join(outside, "day/root-race.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a hash-failing temporary and cancels between completed files", async () => {
    const setupResult = await setup();
    const one = join(setupResult.sourceRoot, "day/one.jpg");
    const two = join(setupResult.sourceRoot, "day/two.jpg");
    await Promise.all([writeFile(one, "one"), writeFile(two, "two")]);
    const photos: PhotoUnit[] = [
      { id: "one", stem: "one", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(one, "day/one.jpg", "jpeg", "one") },
      { id: "two", stem: "two", capturedAtMs: 1, captureTimeSource: "file-mtime", rating: 1, jpeg: file(two, "day/two.jpg", "jpeg", "two") },
    ];
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "after-copy" && detail.relativePath === "day/one.jpg") await writeFile(detail.temporaryPath!, "corrupt");
    } });
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session(photos) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    const controller = new AbortController();
    const result = await exporter.commit(context, { confirmationId: preview.confirmationId!, signal: controller.signal, onProgress: () => controller.abort() });
    expect(result).toMatchObject({ cancelled: true, counts: { copied: 0, failed: 1 } });
    expect(await readdir(join(setupResult.destinationRoot, "day"))).toEqual([]);
  });

  it.each(["before-create", "before-link"] as const)("fails closed when a final ancestor is replaced at %s", async (stage) => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/ancestor.jpg");
    const outside = join(dirname(setupResult.destinationRoot), `outside-${stage}`);
    await Promise.all([writeFile(source, "source"), mkdir(outside)]);
    await writeFile(join(outside, "unrelated.txt"), "keep");
    let swapped = false;
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (current, detail) => {
      if (!swapped && current === stage && detail.relativePath === "day/ancestor.jpg") {
        swapped = true;
        const parent = join(setupResult.destinationRoot, "day");
        await rename(parent, `${parent}-owned`);
        await symlink(outside, parent);
      }
    } });
    const photo: PhotoUnit = { id: "ancestor", stem: "ancestor", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/ancestor.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(readFile(join(outside, "unrelated.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(outside, "ancestor.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains owned inodes and reports recovery when an ancestor changes after link", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/after-link.jpg");
    const outside = join(dirname(setupResult.destinationRoot), "outside-after-link");
    await Promise.all([writeFile(source, "source"), mkdir(outside)]);
    await writeFile(join(outside, "unrelated.txt"), "keep");
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "after-link" && detail.relativePath === "day/after-link.jpg") {
        const parent = join(setupResult.destinationRoot, "day");
        await rename(parent, `${parent}-owned`);
        await symlink(outside, parent);
      }
    } });
    const photo: PhotoUnit = { id: "after-link", stem: "after-link", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/after-link.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", recoveryLabel: "day/after-link.jpg" });
    await expect(readFile(join(outside, "unrelated.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(outside, "after-link.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(setupResult.destinationRoot, "day-owned/after-link.jpg"), "utf8")).resolves.toBe("source");
  });

  it("does not delete an attacker replacement during temporary cleanup", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/cleanup.jpg");
    await writeFile(source, "source");
    let attackerPath = "";
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "cleanup" && detail.relativePath === "day/cleanup.jpg") {
        attackerPath = detail.temporaryPath!;
        await unlink(attackerPath);
        await writeFile(attackerPath, "attacker");
      }
    } });
    const photo: PhotoUnit = { id: "cleanup", stem: "cleanup", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/cleanup.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", recoveryLabel: "day/cleanup.jpg" });
    await expect(readFile(attackerPath, "utf8")).resolves.toBe("attacker");
  });

  it("does not follow a staging-directory substitution during cleanup", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/cleanup-parent.jpg");
    const outside = join(dirname(setupResult.destinationRoot), "outside-cleanup-parent");
    await Promise.all([writeFile(source, "source"), mkdir(outside)]);
    await writeFile(join(outside, "unrelated.txt"), "keep");
    let retained = "";
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "cleanup" && detail.relativePath === "day/cleanup-parent.jpg") {
        const staging = dirname(detail.temporaryPath!);
        retained = `${staging}-owned`;
        await rename(staging, retained);
        await symlink(outside, staging);
      }
    } });
    const photo: PhotoUnit = { id: "cleanup-parent", stem: "cleanup-parent", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/cleanup-parent.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", recoveryLabel: "day/cleanup-parent.jpg" });
    await expect(readFile(join(outside, "unrelated.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(outside, basename(retained)))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(retained)).length).toBe(1);
  });

  it("re-verifies the installed target after the after-install window", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/mutated.jpg");
    await writeFile(source, "source");
    const final = join(setupResult.destinationRoot, "day/mutated.jpg");
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "after-install" && detail.relativePath === "day/mutated.jpg") await writeFile(final, "mutated");
    } });
    const photo: PhotoUnit = { id: "mutated", stem: "mutated", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/mutated.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    const report = await exporter.commit(context, { confirmationId: preview.confirmationId! });
    expect(report.counts).toMatchObject({ copied: 0, failed: 1 });
    await expect(lstat(final)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an attacker replacement in the after-install cleanup window", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/replaced.jpg");
    const final = join(setupResult.destinationRoot, "day/replaced.jpg");
    await writeFile(source, "source");
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "after-install" && detail.relativePath === "day/replaced.jpg") {
        await unlink(final);
        await writeFile(final, "attacker");
      }
    } });
    const photo: PhotoUnit = { id: "replaced", stem: "replaced", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/replaced.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", recoveryLabel: "day/replaced.jpg" });
    await expect(readFile(final, "utf8")).resolves.toBe("attacker");
  });

  it("stages only in a private job directory directly under the pinned root", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/private.jpg");
    await writeFile(source, "source");
    let stagingName = "";
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage) => {
      if (stage === "before-create") {
        stagingName = (await readdir(setupResult.destinationRoot)).find((name) => name.startsWith(".burstpick-copy-job-")) ?? "";
        const details = await lstat(join(setupResult.destinationRoot, stagingName));
        expect(details.isDirectory()).toBe(true);
        expect(details.mode & 0o077).toBe(0);
        expect(await readdir(join(setupResult.destinationRoot, "day"))).toEqual([]);
      }
    } });
    const photo: PhotoUnit = { id: "private", stem: "private", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/private.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await exporter.commit(context, { confirmationId: preview.confirmationId! });
    expect(stagingName).not.toBe("");
    await expect(lstat(join(setupResult.destinationRoot, stagingName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects destination-root drift during final job-directory cleanup", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "day/job-cleanup.jpg");
    await writeFile(source, "source");
    const movedRoot = `${setupResult.destinationRoot}-owned`;
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage, detail) => {
      if (stage === "job-cleanup" && detail.relativePath === "destination-root") {
        const stagingName = (await readdir(setupResult.destinationRoot)).find((name) => name.startsWith(".burstpick-copy-job-"))!;
        await rename(setupResult.destinationRoot, movedRoot);
        await mkdir(setupResult.destinationRoot);
        await rename(join(movedRoot, stagingName), join(setupResult.destinationRoot, stagingName));
      }
    } });
    const photo: PhotoUnit = { id: "job-cleanup", stem: "job-cleanup", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "day/job-cleanup.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", recoveryLabel: "destination-root" });
    await expect(readFile(join(movedRoot, "day/job-cleanup.jpg"), "utf8")).resolves.toBe("source");
  });

  it.each(["final-parent-sync", "report-directory-sync"] as const)("surfaces injected %s failure", async (syncStage) => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, `day/${syncStage}.jpg`);
    await writeFile(source, "source");
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: async (stage) => {
      if (stage === syncStage) throw new Error("injected sync failure");
    } });
    const photo: PhotoUnit = { id: syncStage, stem: syncStage, capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, `day/${syncStage}.jpg`, "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    if (syncStage === "final-parent-sync") {
      await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toThrow("injected sync failure");
      await expect(lstat(join(setupResult.destinationRoot, `day/${syncStage}.jpg`))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(exporter.commit(context, { confirmationId: preview.confirmationId! })).rejects.toThrow("injected sync failure");
    }
  });

  it("syncs every owning directory in crash-durable entry order", async () => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "one/two/durable.jpg");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "source");
    const events: string[] = [];
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: (stage, detail) => {
      events.push(`${stage}:${detail.operation ?? detail.relativePath}`);
    } });
    const photo: PhotoUnit = { id: "durable", stem: "durable", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "one/two/durable.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    await exporter.commit(context, { confirmationId: preview.confirmationId! });
    const required = [
      "destination-root-sync:staging-create",
      "destination-parent-sync:parent-create:one",
      "destination-parent-sync:parent-create:one/two",
      "before-create:one/two/durable.jpg",
      "staging-directory-sync:temporary-create",
      "before-link:one/two/durable.jpg",
      "final-parent-sync:final-link",
      "cleanup:one/two/durable.jpg",
      "staging-directory-sync:temporary-unlink",
      "app-data-root-sync:report-directory-create",
      "report-directory-sync:report-temporary-create",
      "report-directory-sync:report-link",
      "report-directory-sync:report-temporary-unlink",
      "job-cleanup:destination-root",
      "destination-root-sync:staging-rmdir",
    ];
    expect(events.filter((event) => required.includes(event))).toEqual(required);
  });

  it.each([
    ["destination-root-sync", "staging-create"],
    ["destination-parent-sync", "parent-create:one"],
    ["staging-directory-sync", "temporary-create"],
    ["staging-directory-sync", "temporary-unlink"],
    ["app-data-root-sync", "report-directory-create"],
    ["destination-root-sync", "staging-rmdir"],
  ] as const)("surfaces injected %s failure at %s", async (syncStage, operation) => {
    const setupResult = await setup();
    const source = join(setupResult.sourceRoot, "one/two/injected-durable.jpg");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "source");
    const exporter = createCopyExportService({ appDataRoot: setupResult.appDataRoot, failureInjection: (stage, detail) => {
      if (stage === syncStage && detail.operation === operation) throw new Error(`injected ${operation}`);
    } });
    const photo: PhotoUnit = { id: "injected-durable", stem: "injected-durable", capturedAtMs: 0, captureTimeSource: "file-mtime", rating: 1, jpeg: file(source, "one/two/injected-durable.jpg", "jpeg", "source") };
    const context = { albumId: "album", isDemo: false, sourceRoot: setupResult.sourceRoot, session: session([photo]) };
    const preview = await exporter.preview(context, { destinationRoot: setupResult.destinationRoot, minRating: 1 });
    const commit = exporter.commit(context, { confirmationId: preview.confirmationId! });
    if (syncStage === "destination-parent-sync" || (syncStage === "staging-directory-sync" && operation === "temporary-create")) {
      await expect(commit).resolves.toMatchObject({ counts: { copied: 0, failed: 1 } });
    } else {
      await expect(commit).rejects.toThrow();
    }
  });
});
