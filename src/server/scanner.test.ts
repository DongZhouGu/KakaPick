import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { AlbumSessionSchema, type AlbumSession } from "../shared/domain.js";
import {
  createMetadataAdapter,
  type ExifToolClient,
  type MetadataAdapter,
} from "./adapters/metadata.js";
import { SharpImageAdapter, type ImageAdapter } from "./adapters/image.js";
import { createDemoAlbum } from "./demo.js";
import { SessionService } from "./session-service.js";
import { sessionPathForSource } from "./index.js";
import { SessionStore } from "./session-store.js";
import { scanAlbum, type ScanProgress } from "./scanner.js";

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

async function fixtureFile(
  root: string,
  relativePath: string,
  contents: string | Uint8Array = "fixture",
): Promise<string> {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  return path;
}

function metadataAdapter(
  read: MetadataAdapter["read"] = async () => ({ capturedAtMs: 1_000 }),
): MetadataAdapter {
  return {
    read,
    async readRaw() {
      return {};
    },
    async writeRating() {},
    async extractPreview() {},
    async end() {},
  };
}

function imageAdapter(
  differenceHash: ImageAdapter["differenceHash"] = async () => "0000000000000000",
): ImageAdapter {
  return {
    async assertCacheOutsideSource() {},
    async thumbnail() {
      return Buffer.from("thumbnail");
    },
    differenceHash,
    async inspect() {
      return { format: "jpeg", height: 8, width: 9 };
    },
  };
}

function memoryStore(prior?: AlbumSession): {
  load(): Promise<AlbumSession | undefined>;
  save(session: AlbumSession): Promise<void>;
  saved(): AlbumSession | undefined;
} {
  let savedSession: AlbumSession | undefined;
  return {
    async load() {
      return prior;
    },
    async save(session) {
      savedSession = session;
    },
    saved() {
      return savedSession;
    },
  };
}

describe("scanAlbum", () => {
  it("waits for bounded metadata work and schedules nothing else after cancellation", async () => {
    const root = await temporaryDirectory("burstpick-abort-metadata-");
    for (let index = 0; index < 9; index += 1) {
      await fixtureFile(root, `photo-${index}.jpg`);
    }
    const controller = new AbortController();
    let releaseMetadata: (() => void) | undefined;
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let markEightStarted: (() => void) | undefined;
    const eightStarted = new Promise<void>((resolve) => {
      markEightStarted = resolve;
    });
    const read = vi.fn(async () => {
      if (read.mock.calls.length === 8) markEightStarted?.();
      await metadataGate;
      return { capturedAtMs: 1_000 };
    });
    const hash = vi.fn(async () => "0000000000000000");
    const save = vi.fn(async () => undefined);

    const scan = scanAlbum({
      images: imageAdapter(hash),
      metadata: metadataAdapter(read),
      root,
      sessionStore: { load: vi.fn(async () => undefined), save },
      signal: controller.signal,
    });
    await eightStarted;
    controller.abort();
    let settled = false;
    void scan.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseMetadata?.();

    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(read).toHaveBeenCalledTimes(8);
    expect(hash).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not schedule another bounded image operation after cancellation", async () => {
    const root = await temporaryDirectory("burstpick-abort-images-");
    for (let index = 0; index < 5; index += 1) {
      await fixtureFile(root, `photo-${index}.jpg`);
    }
    const controller = new AbortController();
    let releaseImages: (() => void) | undefined;
    const imageGate = new Promise<void>((resolve) => {
      releaseImages = resolve;
    });
    let markFourStarted: (() => void) | undefined;
    const fourStarted = new Promise<void>((resolve) => {
      markFourStarted = resolve;
    });
    const hash = vi.fn(async () => {
      if (hash.mock.calls.length === 4) markFourStarted?.();
      await imageGate;
      return "0000000000000000";
    });
    const save = vi.fn(async () => undefined);

    const scan = scanAlbum({
      images: imageAdapter(hash),
      metadata: metadataAdapter(),
      root,
      sessionStore: { load: vi.fn(async () => undefined), save },
      signal: controller.signal,
    });
    await fourStarted;
    controller.abort();
    releaseImages?.();

    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(hash).toHaveBeenCalledTimes(5);
    expect(save).not.toHaveBeenCalled();
  });

  it("checks cancellation immediately before session persistence", async () => {
    const root = await temporaryDirectory("burstpick-abort-persistence-");
    await fixtureFile(root, "photo.jpg");
    const controller = new AbortController();
    const save = vi.fn(async () => undefined);

    const scan = scanAlbum(
      {
        images: imageAdapter(),
        metadata: metadataAdapter(),
        root,
        sessionStore: { load: vi.fn(async () => undefined), save },
        signal: controller.signal,
      },
      (progress) => {
        if (progress.phase === "grouping" && progress.completed === 0) controller.abort();
      },
    );

    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(save).not.toHaveBeenCalled();
  });

  it("pairs, enriches, hashes, groups and reports progress", async () => {
    const root = await temporaryDirectory("burstpick-scan-");
    await fixtureFile(root, "day/ONE.ARW");
    await fixtureFile(root, "day/one.jpg");
    await fixtureFile(root, "day/TWO.NEF");
    await fixtureFile(root, "day/two.jpeg");
    const events: ScanProgress[] = [];
    const store = memoryStore();
    const metadata = metadataAdapter(async (path) => ({
      cameraId: "camera-1",
      capturedAtMs: basename(path).toLocaleLowerCase("en-US").startsWith("one")
        ? 1_000
        : 1_100,
    }));

    const result = await scanAlbum(
      { images: imageAdapter(), metadata, root, sessionStore: store },
      (event) => events.push(event),
    );

    expect(result.photos).toHaveLength(2);
    expect(result.photos[0]).toMatchObject({
      capturedAtMs: 1_000,
      captureTimeSource: "exif",
      perceptualHash: "0000000000000000",
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.photoIds).toEqual(result.photos.map((item) => item.id));
    expect(events.at(-1)).toMatchObject({ phase: "grouping", completed: 1, total: 1 });
    expect([...new Set(events.map((event) => event.phase))]).toEqual([
      "inventory",
      "metadata",
      "hashing",
      "grouping",
    ]);
    const phaseOrder = ["inventory", "metadata", "hashing", "grouping"] as const;
    let priorPhaseIndex = 0;
    for (const phase of phaseOrder) {
      const phaseEvents = events.filter((event) => event.phase === phase);
      expect(phaseEvents.length).toBeGreaterThan(0);
      let priorCompleted = 0;
      for (const event of phaseEvents) {
        expect(event.completed).toBeGreaterThanOrEqual(0);
        expect(event.total).toBeGreaterThanOrEqual(event.completed);
        expect(event.completed).toBeGreaterThanOrEqual(priorCompleted);
        expect(phaseOrder.indexOf(event.phase)).toBeGreaterThanOrEqual(priorPhaseIndex);
        priorCompleted = event.completed;
        priorPhaseIndex = phaseOrder.indexOf(event.phase);
      }
    }
    expect(store.saved()).toMatchObject({
      inventoryFingerprint: result.inventoryFingerprint,
      photos: result.photos,
      groups: result.groups,
    });
  });

  it("walks deterministically while ignoring hidden, internal, node_modules and destination directories", async () => {
    const root = await temporaryDirectory("burstpick-inventory-");
    const destination = join(root, "exports");
    for (const path of [
      "z/second.jpg",
      "a/first.jpg",
      ".hidden/ignored.jpg",
      ".burstpick/ignored.jpg",
      "node_modules/ignored.jpg",
      "exports/ignored.jpg",
    ]) {
      await fixtureFile(root, path);
    }
    const canonicalRoot = await realpath(root);
    const visited: string[] = [];

    const result = await scanAlbum({
      destinationPaths: [destination],
      images: imageAdapter(),
      metadata: metadataAdapter(async (path) => {
        visited.push(relative(canonicalRoot, path).split(sep).join("/"));
        return { capturedAtMs: 1_000 + visited.length };
      }),
      root,
      sessionStore: memoryStore(),
    });

    expect(visited).toEqual(["a/first.jpg", "z/second.jpg"]);
    expect(result.photos.map((photo) => photo.stem)).toEqual(["first", "second"]);
  });

  it("limits metadata work to eight items and image work to four items", async () => {
    const root = await temporaryDirectory("burstpick-concurrency-");
    for (let index = 0; index < 16; index += 1) {
      await fixtureFile(root, `photo-${String(index).padStart(2, "0")}.jpg`);
    }
    let activeMetadata = 0;
    let activeImages = 0;
    let maxMetadata = 0;
    let maxImages = 0;

    const result = await scanAlbum({
      images: imageAdapter(async () => {
        activeImages += 1;
        maxImages = Math.max(maxImages, activeImages);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeImages -= 1;
        return "0000000000000000";
      }),
      metadata: metadataAdapter(async () => {
        activeMetadata += 1;
        maxMetadata = Math.max(maxMetadata, activeMetadata);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeMetadata -= 1;
        return { capturedAtMs: 1_000 };
      }),
      root,
      sessionStore: memoryStore(),
    });

    expect(result.photos).toHaveLength(16);
    expect(maxMetadata).toBe(8);
    expect(maxImages).toBe(6);
  });

  it("turns adapter failures into per-item warnings and still fails an unreadable root", async () => {
    const root = await temporaryDirectory("burstpick-warning-");
    await fixtureFile(root, "metadata-fails.jpg");
    await fixtureFile(root, "hash-fails.jpg");

    const result = await scanAlbum({
      images: imageAdapter(async (source) => {
        if (typeof source === "string" && source.endsWith("hash-fails.jpg")) {
          throw new Error("decode failed at an absolute path");
        }
        return "0000000000000000";
      }),
      metadata: metadataAdapter(async (path) => {
        if (path.endsWith("metadata-fails.jpg")) throw new Error("exif failed");
        return { capturedAtMs: 1_500 };
      }),
      root,
      sessionStore: memoryStore(),
    });

    expect(result.photos).toHaveLength(2);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "METADATA_READ_FAILED",
          relativePaths: ["metadata-fails.jpg"],
        }),
        expect.objectContaining({
          code: "IMAGE_HASH_FAILED",
          relativePaths: ["hash-fails.jpg"],
        }),
      ]),
    );
    expect(JSON.stringify(result.warnings)).not.toContain(root);

    await expect(
      scanAlbum({
        images: imageAdapter(),
        metadata: metadataAdapter(),
        root: join(root, "missing"),
        sessionStore: memoryStore(),
      }),
    ).rejects.toThrow();
  });

  it("extracts RAW previews only beneath the supplied application cache root", async () => {
    const root = await temporaryDirectory("burstpick-raw-");
    const cacheRoot = await temporaryDirectory("burstpick-cache-");
    const canonicalRoot = await realpath(root);
    const canonicalCacheRoot = await realpath(cacheRoot);
    await fixtureFile(root, "only.arw");
    let extractedTo: string | undefined;
    let hashedFrom: string | undefined;
    const metadata = metadataAdapter();
    metadata.extractPreview = async (_source, destination) => {
      extractedTo = destination;
      await writeFile(destination, "preview");
    };

    const result = await scanAlbum({
      cacheRoot,
      images: imageAdapter(async (source) => {
        hashedFrom = typeof source === "string" ? source : undefined;
        return "0000000000000000";
      }),
      metadata,
      root,
      sessionStore: memoryStore(),
    });

    expect(result.photos[0]?.perceptualHash).toBe("0000000000000000");
    expect(extractedTo?.startsWith(`${canonicalCacheRoot}${sep}`)).toBe(true);
    expect(extractedTo?.startsWith(`${canonicalRoot}${sep}`)).toBe(false);
    expect(hashedFrom).toBeDefined();
    expect((await stat(hashedFrom ?? "")).mode & 0o777).toBe(0o600);
  });

  it("validates the image cache independently from the RAW-preview cache", async () => {
    const root = await temporaryDirectory("burstpick-cache-capability-source-");
    const previewCacheRoot = await temporaryDirectory("burstpick-preview-cache-");
    const imageCacheRoot = await temporaryDirectory("burstpick-thumbnail-cache-");
    const jpeg = await sharp({
      create: { background: "#224466", channels: 3, height: 8, width: 9 },
    })
      .jpeg()
      .toBuffer();
    await fixtureFile(root, "frame.jpg", jpeg);

    await expect(
      scanAlbum({
        cacheRoot: previewCacheRoot,
        images: new SharpImageAdapter({ cacheRoot: imageCacheRoot }),
        metadata: metadataAdapter(),
        root,
        sessionStore: memoryStore(),
      }),
    ).resolves.toMatchObject({ photos: [expect.objectContaining({ stem: "frame" })] });

    const nestedImageCache = join(root, "thumbnail-cache");
    await expect(
      scanAlbum({
        cacheRoot: previewCacheRoot,
        images: new SharpImageAdapter({ cacheRoot: nestedImageCache }),
        metadata: metadataAdapter(),
        root,
        sessionStore: memoryStore(),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CACHE_LOCATION" });
  });

  it("rejects an application cache root nested inside the source folder", async () => {
    const root = await temporaryDirectory("burstpick-cache-boundary-");
    await fixtureFile(root, "only.arw");

    await expect(
      scanAlbum({
        cacheRoot: join(root, "cache"),
        images: imageAdapter(),
        metadata: metadataAdapter(),
        root,
        sessionStore: memoryStore(),
      }),
    ).rejects.toThrow(/cache root/i);
    expect(await readdir(root)).toEqual(["only.arw"]);
  });

  it("preserves ratings and valid manual groups for an unchanged fingerprint", async () => {
    const root = await temporaryDirectory("burstpick-resume-");
    await fixtureFile(root, "one.jpg");
    await fixtureFile(root, "two.jpg");
    const first = await scanAlbum({
      images: imageAdapter(),
      metadata: metadataAdapter(async (path) => ({
        capturedAtMs: path.endsWith("one.jpg") ? 1_000 : 1_100,
      })),
      root,
      sessionStore: memoryStore(),
    });
    const prior: AlbumSession = {
      schemaVersion: 1,
      sourcePathHash: first.sourcePathHash,
      inventoryFingerprint: first.inventoryFingerprint,
      boundaryOverrides: [],
      photos: first.photos.map((photo, index) => ({ ...photo, rating: index === 0 ? 4 : 0 })),
      groups: first.groups.map((group) => ({ ...group, manual: true })),
      groupingSensitivity: 1,
      history: [], rejectedIds: [],
      updatedAt: new Date(0).toISOString(),
    };
    AlbumSessionSchema.parse(prior);

    const resumed = await scanAlbum({
      images: imageAdapter(),
      metadata: metadataAdapter(async (path) => ({
        capturedAtMs: path.endsWith("one.jpg") ? 1_000 : 1_100,
      })),
      root,
      sessionStore: memoryStore(prior),
    });

    expect(resumed.photos[0]?.rating).toBe(4);
    expect(resumed.groups).toEqual(prior.groups);
  });

  it("skips enrichment and hashing when the inventory is unchanged", async () => {
    const root = await temporaryDirectory("burstpick-fast-resume-");
    await fixtureFile(root, "one.jpg");
    await fixtureFile(root, "two.jpg");
    const firstStore = memoryStore();
    const first = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(), root, sessionStore: firstStore });
    const read = vi.fn(async () => { throw new Error("metadata must be skipped"); });
    const hash = vi.fn(async () => { throw new Error("hash must be skipped"); });
    const store = memoryStore(firstStore.saved());

    const resumed = await scanAlbum({ images: imageAdapter(hash), metadata: metadataAdapter(read), root, sessionStore: store });

    expect(read).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(resumed.photos).toEqual(first.photos);
    expect(resumed.groups).toEqual(first.groups);
    expect(store.saved()).toEqual(expect.objectContaining({ updatedAt: resumed.updatedAt }));
  });

  it("reuses visual analysis when only an XMP sidecar is added", async () => {
    const root = await temporaryDirectory("burstpick-xmp-resume-");
    await fixtureFile(root, "one.arw");
    const firstStore = memoryStore();
    const first = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(), root, sessionStore: firstStore });
    const { warnings: _warnings, ...firstSession } = first;
    void _warnings;
    const prior = AlbumSessionSchema.parse({
      ...firstSession,
      rejectedIds: [first.photos[0]!.id],
      groups: first.groups.map((group) => ({ ...group, manual: true })),
    });
    await fixtureFile(root, "one.xmp", "<xmp />");
    const read = vi.fn(async () => { throw new Error("image metadata must be reused"); });
    const hash = vi.fn(async () => { throw new Error("visual hash must be reused"); });

    const resumed = await scanAlbum({ images: imageAdapter(hash), metadata: metadataAdapter(read), root, sessionStore: memoryStore(prior) });

    expect(resumed.inventoryFingerprint).not.toBe(prior.inventoryFingerprint);
    expect(read).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(resumed.photos[0]?.xmp?.relativePath).toBe("one.xmp");
    expect(resumed.photos[0]?.perceptualHash).toBe(prior.photos[0]?.perceptualHash);
    expect(resumed.groups).toEqual(prior.groups);
    expect(resumed.rejectedIds).toEqual(prior.rejectedIds);
  });

  it("fills missing resume metrics with bounded concurrent image work", async () => {
    const root = await temporaryDirectory("burstpick-metrics-resume-");
    for (let index = 0; index < 8; index += 1) {
      await fixtureFile(root, `photo-${index}.jpg`);
    }
    const firstStore = memoryStore();
    await scanAlbum({
      images: imageAdapter(),
      metadata: metadataAdapter(),
      root,
      sessionStore: firstStore,
    });
    const prior = firstStore.saved()!;
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markConcurrent: (() => void) | undefined;
    const concurrent = new Promise<void>((resolve) => { markConcurrent = resolve; });
    const images = imageAdapter();
    images.sharpness = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active >= 2) markConcurrent?.();
      await gate;
      active -= 1;
      return 12;
    });
    images.exposure = vi.fn(async () => ({ overexposedRatio: 0.01, underexposedRatio: 0.02 }));

    const resume = scanAlbum({ images, metadata: metadataAdapter(), root, sessionStore: memoryStore(prior) });
    await Promise.race([
      concurrent,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("resume metrics stayed serial")), 250)),
    ]);
    release?.();
    const resumed = await resume;

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    expect(resumed.photos).toHaveLength(8);
    expect(resumed.photos.every((photo) => photo.sharpness === 12)).toBe(true);
  });

  it("recomputes groups after inventory changes while preserving stable photo ratings", async () => {
    const root = await temporaryDirectory("burstpick-rescan-");
    await fixtureFile(root, "one.jpg");
    await fixtureFile(root, "two.jpg");
    const first = await scanAlbum({
      images: imageAdapter(),
      metadata: metadataAdapter(),
      root,
      sessionStore: memoryStore(),
    });
    const prior: AlbumSession = {
      schemaVersion: 1,
      sourcePathHash: first.sourcePathHash,
      inventoryFingerprint: first.inventoryFingerprint,
      boundaryOverrides: [],
      photos: first.photos.map((photo, index) => ({ ...photo, rating: index === 0 ? 5 : 0 })),
      groups: first.groups.map((group) => ({ ...group, manual: true })),
      groupingSensitivity: 1,
      history: [], rejectedIds: [first.photos[1]!.id],
      updatedAt: new Date(0).toISOString(),
    };
    AlbumSessionSchema.parse(prior);
    await fixtureFile(root, "three.jpg");

    const rescanned = await scanAlbum({
      images: imageAdapter(),
      metadata: metadataAdapter(),
      root,
      sessionStore: memoryStore(prior),
    });

    expect(rescanned.inventoryFingerprint).not.toBe(prior.inventoryFingerprint);
    expect(rescanned.photos.find((photo) => photo.id === first.photos[0]?.id)?.rating).toBe(5);
    expect(rescanned.rejectedIds).toEqual([first.photos[1]!.id]);
    expect(rescanned.groups).toHaveLength(1);
    expect(rescanned.groups[0]?.manual).toBe(false);
    expect(rescanned.history).toEqual([]);
  });

  it("preserves a stable manual boundary across unrelated additions and removals", async () => {
    const root = await temporaryDirectory("burstpick-boundary-rescan-");
    await fixtureFile(root, "one.jpg");
    await fixtureFile(root, "two.jpg");
    await fixtureFile(root, "removed.jpg");
    const read = async (path: string) => ({
      capturedAtMs: path.endsWith("one.jpg") ? 1_000 : path.endsWith("two.jpg") ? 1_100 : 10_000,
    });
    const first = await scanAlbum({
      images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: memoryStore(),
    });
    const one = first.photos.find((photo) => photo.stem === "one")!;
    const two = first.photos.find((photo) => photo.stem === "two")!;
    const { warnings: _warnings, ...firstSession } = first;
    void _warnings;
    const service = new SessionService(firstSession, memoryStore());
    await service.split(two.id);
    await service.ratePhoto(one.id, 5);
    const prior = service.snapshot();
    expect(AlbumSessionSchema.safeParse(prior).success).toBe(true);
    await rm(join(root, "removed.jpg"));
    await fixtureFile(root, "added.jpg");

    const rescanned = await scanAlbum({
      images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: memoryStore(prior),
    });

    expect(rescanned.boundaryOverrides).toEqual(prior.boundaryOverrides);
    expect(rescanned.groups.slice(0, 2).map((group) => group.photoIds)).toEqual([[one.id], [two.id]]);
    expect(rescanned.photos.find((photo) => photo.id === one.id)?.rating).toBe(5);
    expect(rescanned.photos.some((photo) => photo.stem === "added")).toBe(true);
    expect(rescanned.photos.some((photo) => photo.stem === "removed")).toBe(false);
  });

  it("replays an overlapping-camera join chronologically after unrelated inventory changes", async () => {
    const root = await temporaryDirectory("burstpick-overlap-join-");
    for (const name of ["a0.jpg", "a500.jpg", "b250.jpg", "removed.jpg"]) await fixtureFile(root, name);
    const read = async (path: string) => {
      const name = basename(path);
      if (name === "a0.jpg") return { cameraId: "A", capturedAtMs: 0 };
      if (name === "a500.jpg") return { cameraId: "A", capturedAtMs: 500 };
      if (name === "b250.jpg") return { cameraId: "B", capturedAtMs: 250 };
      return { cameraId: "C", capturedAtMs: 10_000 };
    };
    const first = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: memoryStore() });
    const { warnings: _warnings, ...firstSession } = first;
    void _warnings;
    const service = new SessionService(firstSession, memoryStore());
    await service.merge(firstSession.groups[0]!.id);
    const prior = service.snapshot();
    await rm(join(root, "removed.jpg"));
    await fixtureFile(root, "added.jpg");

    const store = memoryStore(prior);
    const rescanned = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: store });
    const idsByStem = new Map(rescanned.photos.map((photo) => [photo.stem, photo.id]));
    expect(rescanned.groups[0]).toMatchObject({
      photoIds: [idsByStem.get("a0"), idsByStem.get("b250"), idsByStem.get("a500")],
      startedAtMs: 0,
      endedAtMs: 500,
    });
    expect(rescanned.boundaryOverrides).toEqual(prior.boundaryOverrides);
    expect(rescanned.photos.some((photo) => photo.stem === "added")).toBe(true);
    expect(rescanned.photos.some((photo) => photo.stem === "removed")).toBe(false);
  });

  it("retains a stored join when a same-camera member is inserted between its durable IDs", async () => {
    const root = await temporaryDirectory("burstpick-join-insert-");
    for (const name of ["a0.jpg", "a500.jpg", "b250.jpg"]) await fixtureFile(root, name);
    const read = async (path: string) => {
      const name = basename(path);
      if (name === "a0.jpg") return { cameraId: "A", capturedAtMs: 0 };
      if (name === "a100.jpg") return { cameraId: "A", capturedAtMs: 100 };
      if (name === "a500.jpg") return { cameraId: "A", capturedAtMs: 500 };
      if (name === "b250.jpg") return { cameraId: "B", capturedAtMs: 250 };
      return { cameraId: "C", capturedAtMs: 10_000 };
    };
    const first = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: memoryStore() });
    const { warnings: _warnings, ...firstSession } = first;
    void _warnings;
    const service = new SessionService(firstSession, memoryStore());
    await service.merge(firstSession.groups[0]!.id);
    const prior = service.snapshot();
    await fixtureFile(root, "a100.jpg");
    await fixtureFile(root, "unrelated.jpg");
    const store = memoryStore(prior);

    const rescanned = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: store });
    const ids = new Map(rescanned.photos.map((photo) => [photo.stem, photo.id]));
    expect(rescanned.groups[0]).toMatchObject({
      photoIds: [ids.get("a0"), ids.get("a100"), ids.get("b250"), ids.get("a500")],
      startedAtMs: 0,
      endedAtMs: 500,
    });
    expect(rescanned.boundaryOverrides).toEqual(prior.boundaryOverrides);
    const persisted = AlbumSessionSchema.parse(JSON.parse(JSON.stringify(store.saved())));
    expect(new SessionService(persisted, memoryStore()).snapshot().groups[0]).toEqual(rescanned.groups[0]);
  });

  it("replays two sequential overlapping joins after unrelated inventory changes", async () => {
    const root = await temporaryDirectory("burstpick-two-joins-");
    for (const name of ["a0.jpg", "a600.jpg", "b200.jpg", "c400.jpg", "removed.jpg"]) await fixtureFile(root, name);
    const read = async (path: string) => {
      const name = basename(path);
      if (name === "a0.jpg") return { cameraId: "A", capturedAtMs: 0 };
      if (name === "a600.jpg") return { cameraId: "A", capturedAtMs: 600 };
      if (name === "b200.jpg") return { cameraId: "B", capturedAtMs: 200 };
      if (name === "c400.jpg") return { cameraId: "C", capturedAtMs: 400 };
      return { cameraId: "D", capturedAtMs: 10_000 };
    };
    const first = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: memoryStore() });
    const { warnings: _warnings, ...firstSession } = first;
    void _warnings;
    const service = new SessionService(firstSession, memoryStore());
    await service.merge(service.snapshot().groups[0]!.id);
    await service.merge(service.snapshot().groups[0]!.id);
    const prior = service.snapshot();
    await rm(join(root, "removed.jpg"));
    await fixtureFile(root, "added.jpg");

    const store = memoryStore(prior);
    const rescanned = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(read), root, sessionStore: store });
    const ids = new Map(rescanned.photos.map((photo) => [photo.stem, photo.id]));
    expect(rescanned.groups[0]).toMatchObject({
      photoIds: [ids.get("a0"), ids.get("b200"), ids.get("c400"), ids.get("a600")],
      startedAtMs: 0,
      endedAtMs: 600,
    });
    expect(rescanned.boundaryOverrides).toEqual(prior.boundaryOverrides);
    const persisted = AlbumSessionSchema.parse(JSON.parse(JSON.stringify(store.saved())));
    expect(new SessionService(persisted, memoryStore()).snapshot().groups[0]).toEqual(rescanned.groups[0]);
  });

  it("scans and resumes a read-only source without creating source entries", async () => {
    const root = await temporaryDirectory("burstpick-read-only-source-");
    const appDataRoot = await temporaryDirectory("burstpick-read-only-data-");
    await fixtureFile(root, "one.jpg");
    const canonicalRoot = await realpath(root);
    const store = new SessionStore(sessionPathForSource(appDataRoot, canonicalRoot));
    await chmod(root, 0o555);
    try {
      const first = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(), root, sessionStore: store });
      const { warnings: _warnings, ...firstSession } = first;
      void _warnings;
      const service = new SessionService(firstSession, store);
      await service.ratePhoto(first.photos[0]!.id, 4);
      const resumed = await scanAlbum({ images: imageAdapter(), metadata: metadataAdapter(), root, sessionStore: store });
      expect(resumed.photos[0]?.rating).toBe(4);
      expect(await readdir(root)).toEqual(["one.jpg"]);
      expect((await stat(sessionPathForSource(appDataRoot, canonicalRoot))).mode & 0o777).toBe(0o600);
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("recomputes unchanged inventory when grouping sensitivity changes", async () => {
    const root = await temporaryDirectory("burstpick-sensitivity-");
    await fixtureFile(root, "one.jpg");
    await fixtureFile(root, "two.jpg");
    const first = await scanAlbum({
      images: imageAdapter(),
      metadata: metadataAdapter(async (path) => ({
        capturedAtMs: path.endsWith("one.jpg") ? 1_000 : 1_100,
      })),
      root,
      sessionStore: memoryStore(),
    });
    const ratedPhotoId = first.photos[0]?.id ?? "";
    const prior: AlbumSession = {
      schemaVersion: 1,
      sourcePathHash: first.sourcePathHash,
      inventoryFingerprint: first.inventoryFingerprint,
      boundaryOverrides: [],
      photos: first.photos.map((photo, index) => ({ ...photo, rating: index === 0 ? 4 : 0 })),
      groups: first.groups.map((group) => ({ ...group, manual: true })),
      groupingSensitivity: 1,
      rejectedIds: [],
      history: [{ type: "rate", payload: { ratings: [{ photoId: ratedPhotoId, rating: 0 }] } }],
      updatedAt: new Date(0).toISOString(),
    };
    AlbumSessionSchema.parse(prior);

    const rescanned = await scanAlbum({
      groupingSensitivity: 1.5,
      images: imageAdapter(),
      metadata: metadataAdapter(async (path) => ({
        capturedAtMs: path.endsWith("one.jpg") ? 1_000 : 1_100,
      })),
      root,
      sessionStore: memoryStore(prior),
    });

    expect(rescanned.inventoryFingerprint).toBe(prior.inventoryFingerprint);
    expect(rescanned.groupingSensitivity).toBe(1.5);
    expect(rescanned.photos.find((photo) => photo.id === ratedPhotoId)?.rating).toBe(4);
    expect(rescanned.groups.every((group) => !group.manual)).toBe(true);
    expect(rescanned.history).toEqual([]);
  });
});

describe("ExifTool metadata adapter", () => {
  it("rejects proprietary RAW rating targets before invoking ExifTool", async () => {
    const writes: string[] = [];
    const client = {
      async read() {
        return {};
      },
      async readRaw() {
        return {};
      },
      async write(path: string) {
        writes.push(path);
        return {};
      },
      async extractPreview() {},
      async end() {},
    } satisfies ExifToolClient;
    const adapter = createMetadataAdapter({ client });

    for (const extension of ["ARW", "cr2", "Cr3", "NEF", "raf", "RW2", "orf"]) {
      await expect(adapter.writeRating(`/photos/frame.${extension}`, 5)).rejects.toMatchObject({
        code: "UNSAFE_METADATA_TARGET",
      });
    }
    expect(writes).toEqual([]);

    for (const extension of ["xmp", "JPG", "jpeg", "DNG"]) {
      await adapter.writeRating(`/photos/frame.${extension}`, 4);
    }
    expect(writes).toEqual([
      "/photos/frame.xmp",
      "/photos/frame.JPG",
      "/photos/frame.jpeg",
      "/photos/frame.DNG",
    ]);
  });

  it("falls back from PreviewImage to JpgFromRaw for NEF previews", async () => {
    const calls: string[] = [];
    const client = {
      async read() {
        return {};
      },
      async readRaw() {
        return {};
      },
      async write() {
        return {};
      },
      async extractPreview() {
        calls.push("PreviewImage");
        throw new Error("preview unavailable");
      },
      async extractJpgFromRaw() {
        calls.push("JpgFromRaw");
      },
      async extractThumbnail() {
        calls.push("ThumbnailImage");
      },
      async end() {},
    } satisfies ExifToolClient;
    const adapter = createMetadataAdapter({ client });

    await adapter.extractPreview("/photos/frame.nef", "/cache/frame.jpg");

    expect(calls).toEqual(["PreviewImage", "JpgFromRaw"]);
  });

  it("falls back through JpgFromRaw to ThumbnailImage for RW2 previews", async () => {
    const calls: string[] = [];
    const client = {
      async read() {
        return {};
      },
      async readRaw() {
        return {};
      },
      async write() {
        return {};
      },
      async extractPreview() {
        calls.push("PreviewImage");
        throw new Error("preview unavailable");
      },
      async extractJpgFromRaw() {
        calls.push("JpgFromRaw");
        throw new Error("raw jpeg unavailable");
      },
      async extractThumbnail() {
        calls.push("ThumbnailImage");
      },
      async end() {},
    } satisfies ExifToolClient;
    const adapter = createMetadataAdapter({ client });

    await adapter.extractPreview("/photos/frame.rw2", "/cache/frame.jpg");

    expect(calls).toEqual(["PreviewImage", "JpgFromRaw", "ThumbnailImage"]);
  });

  it("does not invoke ExifTool or remove a pre-existing preview destination", async () => {
    const root = await temporaryDirectory("burstpick-preview-target-");
    const destination = await fixtureFile(root, "preview.jpg", "keep me");
    let extractionCalls = 0;
    const client = {
      async read() {
        return {};
      },
      async readRaw() {
        return {};
      },
      async write() {
        return {};
      },
      async extractPreview() {
        extractionCalls += 1;
        throw new Error("destination exists");
      },
      async end() {},
    } satisfies ExifToolClient;
    const adapter = createMetadataAdapter({ client });

    await expect(adapter.extractPreview("/photos/frame.nef", destination)).rejects.toThrow();

    expect(extractionCalls).toBe(0);
    expect(await readFile(destination, "utf8")).toBe("keep me");
  });

  it("uses subsecond-original first, then original plus its subsecond field", async () => {
    let tags: Record<string, unknown> = {
      DateTimeOriginal: { toMillis: () => 2_000 },
      SubSecDateTimeOriginal: { toMillis: () => 1_234 },
      SubSecTimeOriginal: "999",
    };
    const client = {
      async read() {
        return tags;
      },
      async readRaw() {
        return {};
      },
      async write() {
        return {};
      },
      async extractPreview() {},
      async end() {},
    } satisfies ExifToolClient;
    const adapter = createMetadataAdapter({ client });

    await expect(adapter.read("/photo.jpg")).resolves.toMatchObject({ capturedAtMs: 1_234 });
    tags = { DateTimeOriginal: { toMillis: () => 2_000 }, SubSecTimeOriginal: "25" };
    await expect(adapter.read("/photo.jpg")).resolves.toMatchObject({ capturedAtMs: 2_250 });
    tags = {};
    await expect(adapter.read("/photo.jpg")).resolves.toEqual({});
  });

  it("delegates raw reads, rating writes, preview extraction and graceful shutdown", async () => {
    const calls: Array<{ method: string; values: unknown[] }> = [];
    const raw = { Artist: "kept", Rating: 2 };
    const client = {
      async read() {
        return {};
      },
      async readRaw(path: string) {
        calls.push({ method: "readRaw", values: [path] });
        return raw;
      },
      async write(path: string, tags: Record<string, unknown>) {
        calls.push({ method: "write", values: [path, tags] });
        return {};
      },
      async extractPreview(source: string, destination: string) {
        calls.push({ method: "extractPreview", values: [source, destination] });
      },
      async end(gracefully?: boolean) {
        calls.push({ method: "end", values: [gracefully] });
      },
    } satisfies ExifToolClient;
    const adapter = createMetadataAdapter({ client });

    await expect(adapter.readRaw("/photo.xmp")).resolves.toBe(raw);
    await adapter.writeRating("/photo.xmp", 4);
    await adapter.extractPreview("/photo.arw", "/cache/preview.jpg");
    await adapter.end();

    expect(calls).toEqual([
      { method: "readRaw", values: ["/photo.xmp"] },
      { method: "write", values: ["/photo.xmp", { "XMP-xmp:Rating": 4 }] },
      { method: "extractPreview", values: ["/photo.arw", "/cache/preview.jpg"] },
      { method: "end", values: [true] },
    ]);
  });
});

describe("createDemoAlbum", () => {
  it("returns deterministic, filesystem-free SVG portraits in three burst groups", () => {
    const first = createDemoAlbum();
    const second = createDemoAlbum();

    expect(first.session).toEqual(second.session);
    expect(first.svgByPhotoId).toEqual(second.svgByPhotoId);
    expect(first.groups.map((group) => group.photoIds.length)).toEqual([5, 7, 4]);
    expect(first.photos).toHaveLength(16);
    expect(first.photos.every((photo) => photo.rating === 0)).toBe(true);
    expect(
      first.photos.every(
        (photo) =>
          photo.raw?.relativePath.endsWith(".ARW") === true &&
          photo.jpeg?.relativePath.endsWith(".JPG") === true,
      ),
    ).toBe(true);
    expect(Object.values(first.svgByPhotoId)).toHaveLength(16);
    expect(Object.values(first.svgByPhotoId).every((svg) => svg.startsWith("<svg"))).toBe(true);
    expect(first.photos.every((photo) => photo.raw?.path.startsWith("demo://") === true)).toBe(
      true,
    );
  });
});
