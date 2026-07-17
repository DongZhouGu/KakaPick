import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopyExportReport, ScanProgressEvent } from "../shared/api.js";
import { AlbumSessionSchema, type AlbumSession } from "../shared/domain.js";
import type { ImageAdapter } from "./adapters/image.js";
import type { MetadataAdapter } from "./adapters/metadata.js";
import {
  createFolderPicker,
  FolderPickerError,
  validateManualDirectory,
} from "./adapters/folder-picker.js";
import { createApp, type BurstPickApp, type CopyExportService } from "./app.js";
import { generateProcessToken, startServer } from "./index.js";
import { SessionService } from "./session-service.js";

const TOKEN = "a".repeat(64);
const temporaryPaths: string[] = [];
const apps: BurstPickApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.closeEventStreams();
  await Promise.all(temporaryPaths.splice(0).map(async (path) => rm(path, { force: true, recursive: true })));
});

function albumSession(): AlbumSession {
  return AlbumSessionSchema.parse({
    schemaVersion: 1,
    sourcePathHash: "album-1",
    inventoryFingerprint: "inventory-1",
    photos: [
      {
        id: "p1",
        stem: "DSC_0001",
        jpeg: {
          kind: "jpeg",
          path: "/private/library/DSC_0001.JPG",
          relativePath: "DSC_0001.JPG",
          size: 42,
          modifiedAtMs: 1,
        },
        capturedAtMs: 1,
        captureTimeSource: "exif",
        rating: 0,
      },
      {
        id: "p2",
        stem: "DSC_0002",
        raw: {
          kind: "raw",
          path: "/private/library/DSC_0002.ARW",
          relativePath: "DSC_0002.ARW",
          size: 84,
          modifiedAtMs: 2,
        },
        capturedAtMs: 2,
        captureTimeSource: "exif",
        rating: 0,
      },
    ],
    groups: [
      {
        id: "g1",
        photoIds: ["p1", "p2"],
        startedAtMs: 1,
        endedAtMs: 2,
        confidence: 1,
        manual: false,
      },
    ],
    groupingSensitivity: 1,
    history: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function sessionService(session: AlbumSession = albumSession()): SessionService {
  return new SessionService(
    session,
    { save: vi.fn(async () => undefined) },
    { now: () => new Date("2026-01-01T00:00:01.000Z") },
  );
}

function imageAdapter(): ImageAdapter {
  return {
    assertCacheOutsideSource: vi.fn(async () => undefined),
    thumbnail: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    differenceHash: vi.fn(async () => "0000000000000000"),
    inspect: vi.fn(async () => ({ format: "jpeg", height: 1, width: 1 })),
  };
}

function metadataAdapter(): MetadataAdapter {
  return {
    read: vi.fn(async () => ({})),
    readRaw: vi.fn(async () => ({})),
    writeRating: vi.fn(async () => undefined),
    extractPreview: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
  };
}

function appWithSession(overrides: Partial<Parameters<typeof createApp>[0]> = {}): BurstPickApp {
  const app = createApp({
    token: TOKEN,
    sessionService: sessionService(),
    imageAdapter: imageAdapter(),
    ...overrides,
  });
  apps.push(app);
  return app;
}

function parseText(
  response: request.Response,
  callback: (error: Error | null, body?: string) => void,
): void {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    body += chunk;
  });
  response.on("end", () => callback(null, body));
  response.on("error", (error) => callback(error as Error));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("测试条件未在预期时间内满足。");
}

describe("createApp security and commands", () => {
  it("runs metadata export as a progress job and replays its terminal result", async () => {
    const result = {
      auditId: "c".repeat(32), conflicts: 0, errors: 0,
      items: [{ id: "item", label: "IMG_0001.xmp", status: "written" as const }], skipped: 0, written: 1,
    };
    const metadataExport = {
      latest: vi.fn(async () => ({ available: false })),
      preview: vi.fn(async (_context, _request, operation) => {
        operation?.onProgress?.({ phase: "scanning", completed: 1, total: 1, relativePath: "IMG_0001.xmp" });
        return { confirmationId: "b".repeat(64), conflicts: 0, isDemo: false, items: [], ready: 1, skipped: 0 };
      }),
      commit: vi.fn(async (_context, _request, operation) => {
        operation?.onProgress?.({ phase: "writing", completed: 1, total: 1, relativePath: "IMG_0001.xmp" });
        operation?.onProgress?.({ phase: "verifying", completed: 1, total: 1, relativePath: "IMG_0001.xmp" });
        return result;
      }),
      rollback: vi.fn(),
    };
    const app = appWithSession({ metadataExport });

    const started = await request(app).post("/api/v1/exports/metadata/jobs").set("x-burstpick-token", TOKEN).send({});
    expect(started.status).toBe(202);
    const jobId = started.body.data.jobId as string;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const events = await request(app).get(`/api/v1/exports/metadata/jobs/${jobId}/events`).buffer(true).parse(parseText);

    expect(events.body).toContain("event: progress");
    expect(events.body).toContain('"phase":"verifying"');
    expect(events.body).toContain("event: terminal");
    expect(events.body).toContain(`"auditId":"${"c".repeat(32)}"`);
  });

  it("cancels an active metadata export job", async () => {
    let rejectPreview: ((error: Error) => void) | undefined;
    const preview = vi.fn((_context, _request, operation) => new Promise<never>((_resolve, reject) => {
      rejectPreview = reject;
      operation?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const metadataExport = { latest: vi.fn(), preview, commit: vi.fn(), rollback: vi.fn() };
    const app = appWithSession({ metadataExport });
    const started = await request(app).post("/api/v1/exports/metadata/jobs").set("x-burstpick-token", TOKEN).send({});

    const cancelled = await request(app).post(`/api/v1/exports/metadata/jobs/${started.body.data.jobId}/cancel`).set("x-burstpick-token", TOKEN).send({});

    expect(cancelled.status).toBe(202);
    expect(preview.mock.calls[0]?.[2]?.signal.aborted).toBe(true);
    rejectPreview?.(new DOMException("aborted", "AbortError"));
  });

  it("publishes authoritative demo state and previews copy without a directory selection", async () => {
    const preview = vi.fn(async () => ({ destinationName: "示例相册-精选", isDemo: true, items: [], counts: { copy: 0, skip: 0, conflicts: 0 }, totalBytes: 0, requiredBytes: 0 }));
    const copyExport = { preview, commit: vi.fn(), report: vi.fn() };
    const realApp = appWithSession({ copyExport });
    const realAlbum = await request(realApp).get("/api/v1/albums/album-1");
    expect(realAlbum.body.data.album.isDemo).toBe(false);

    const demoApp = createApp({ token: TOKEN, copyExport });
    apps.push(demoApp);
    const opened = await request(demoApp).post("/api/v1/albums/open").set("x-burstpick-token", TOKEN).send({ demo: true });
    const demoAlbum = await request(demoApp).get(`/api/v1/albums/${opened.body.data.albumId}`);
    expect(demoAlbum.body.data.album.isDemo).toBe(true);
    expect(demoAlbum.body.data.warnings).toEqual([]);
    const photoId = demoAlbum.body.data.album.photos[0].id as string;
    const rated = await request(demoApp).patch(`/api/v1/photos/${photoId}/rating`).set("x-burstpick-token", TOKEN).send({ rating: 3 });
    expect(rated.body.data.album.isDemo).toBe(true);
    const accepted = await request(demoApp).post("/api/v1/exports/copy/preview").set("x-burstpick-token", TOKEN).send({});
    expect(accepted.status).toBe(200);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ isDemo: true }), expect.objectContaining({ destinationRoot: "" }));
  });

  it("creates an adjacent selection directory, starts a copy job, cancels it, and serves a redacted report", async () => {
    const parent = await mkdtemp(join(tmpdir(), "burstpick-copy-parent-"));
    const source = join(parent, "新疆婚礼");
    const destination = join(parent, "新疆婚礼-精选");
    await mkdir(source);
    temporaryPaths.push(parent);
    const commitResolvers: Array<(value: CopyExportReport) => void> = [];
    const commit = vi.fn((...arguments_: Parameters<CopyExportService["commit"]>) => {
      void arguments_;
      return new Promise<CopyExportReport>((resolve) => { commitResolvers.push(resolve); });
    });
    const copyExport = {
      preview: vi.fn(async () => ({
        confirmationId: "b".repeat(64), destinationName: "新疆婚礼-精选", isDemo: false, items: [], counts: { copy: 0, skip: 0, conflicts: 0 }, totalBytes: 0, requiredBytes: 0, freeBytes: 1,
      })),
      commit,
      report: vi.fn(async () => ({ reportId: "d".repeat(32), albumId: "album-1", completedAt: "2026-01-01T00:00:00.000Z", cancelled: true, counts: { copied: 0, skipped: 0, conflicts: 0, failed: 0 }, items: [] })),
    };
    const app = appWithSession({
      copyExport,
      sourceRoot: source,
    });
    const preview = await request(app).post("/api/v1/exports/copy/preview").set("x-burstpick-token", TOKEN).send({ minRating: 1 });
    expect(preview.status).toBe(200);
    expect(copyExport.preview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ destinationRoot: await realpath(destination) }));
    expect(preview.body.data.destinationName).toBe("新疆婚礼-精选");
    expect(JSON.stringify(preview.body)).not.toContain(destination);

    const started = await request(app).post("/api/v1/exports/copy/commit").set("x-burstpick-token", TOKEN).send({ confirmationId: "b".repeat(64) });
    expect(started.status).toBe(202);
    expect(started.body.data.jobId).toMatch(/^[0-9a-f]{32}$/u);
    const cancelled = await request(app).post(`/api/v1/exports/copy/jobs/${started.body.data.jobId}/cancel`).set("x-burstpick-token", TOKEN).send({});
    expect(cancelled.status).toBe(202);
    commitResolvers[0]?.({ reportId: "d".repeat(32), albumId: "album-1", completedAt: "2026-01-01T00:00:00.000Z", cancelled: true, counts: { copied: 0, skipped: 0, conflicts: 0, failed: 0 }, items: [] });
    await waitUntil(() => commit.mock.results[0]?.type === "return");
    const report = await request(app).get(`/api/v1/exports/copy/reports/${"d".repeat(32)}`);
    expect(report.status).toBe(200);
    expect(JSON.stringify(report.body)).not.toContain(destination);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await request(app).post("/api/v1/exports/copy/commit").set("x-burstpick-token", TOKEN).send({ confirmationId: "c".repeat(64) });
    expect(second.status).toBe(202);
    const closing = app.close();
    expect(commit.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    commitResolvers[1]?.({ reportId: "e".repeat(32), albumId: "album-1", completedAt: "2026-01-01T00:00:00.000Z", cancelled: true, counts: { copied: 0, skipped: 0, conflicts: 0, failed: 0 }, items: [] });
    await closing;
  });

  it("rejects a symlink at the automatic selection destination", async () => {
    const parent = await mkdtemp(join(tmpdir(), "burstpick-copy-symlink-"));
    const source = join(parent, "新疆婚礼");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(source), mkdir(outside)]);
    await symlink(outside, join(parent, "新疆婚礼-精选"));
    temporaryPaths.push(parent);
    const copyExport = { preview: vi.fn(), commit: vi.fn(), report: vi.fn() };

    const response = await request(appWithSession({ copyExport, sourceRoot: source }))
      .post("/api/v1/exports/copy/preview").set("x-burstpick-token", TOKEN).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("UNSAFE_COPY_PATH");
    expect(copyExport.preview).not.toHaveBeenCalled();
  });

  it("reuses an existing automatic selection directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "burstpick-copy-existing-"));
    const source = join(parent, "新疆婚礼");
    const destination = join(parent, "新疆婚礼-精选");
    await Promise.all([mkdir(source), mkdir(destination)]);
    temporaryPaths.push(parent);
    const copyExport = {
      preview: vi.fn(async () => ({ isDemo: false, items: [], counts: { copy: 0, skip: 0, conflicts: 0 }, totalBytes: 0, requiredBytes: 0 })),
      commit: vi.fn(), report: vi.fn(),
    };

    const response = await request(appWithSession({ copyExport, sourceRoot: source }))
      .post("/api/v1/exports/copy/preview").set("x-burstpick-token", TOKEN).send({});

    expect(response.status).toBe(200);
    expect(response.body.data.destinationName).toBe("新疆婚礼-精选");
    expect(copyExport.preview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ destinationRoot: await realpath(destination) }));
  });

  it("rejects a regular file at the automatic selection destination", async () => {
    const parent = await mkdtemp(join(tmpdir(), "burstpick-copy-file-"));
    const source = join(parent, "新疆婚礼");
    await mkdir(source);
    await writeFile(join(parent, "新疆婚礼-精选"), "not a directory");
    temporaryPaths.push(parent);
    const copyExport = { preview: vi.fn(), commit: vi.fn(), report: vi.fn() };

    const response = await request(appWithSession({ copyExport, sourceRoot: source }))
      .post("/api/v1/exports/copy/preview").set("x-burstpick-token", TOKEN).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("UNSAFE_COPY_PATH");
    expect(copyExport.preview).not.toHaveBeenCalled();
  });

  it("rejects loose copy-export bodies", async () => {
    const copyExport = { preview: vi.fn(), commit: vi.fn(), report: vi.fn() };
    const response = await request(appWithSession({ copyExport }))
      .post("/api/v1/exports/copy/preview").set("x-burstpick-token", TOKEN).send({ destinationRoot: "/private/leak" });
    expect(response.status).toBe(400);
    expect(copyExport.preview).not.toHaveBeenCalled();
  });
  it("keeps health public for GET and HEAD", async () => {
    const app = appWithSession();

    const getResponse = await request(app).get("/api/v1/health");
    const headResponse = await request(app).head("/api/v1/health");

    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual({ data: { ready: true, version: 1 } });
    expect(headResponse.status).toBe(200);
  });

  it("rejects a mutating request without the process token", async () => {
    const response = await request(appWithSession())
      .patch("/api/v1/photos/p1/rating")
      .send({ rating: 3 });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("INVALID_TOKEN");
  });

  it("accepts an exact token and validates the rating with Zod", async () => {
    const response = await request(appWithSession())
      .patch("/api/v1/photos/p1/rating")
      .set("x-burstpick-token", TOKEN)
      .send({ rating: 5 });

    expect(response.status).toBe(200);
    expect(response.body.data.photo.rating).toBe(5);

    const invalid = await request(appWithSession())
      .patch("/api/v1/photos/p1/rating")
      .set("x-burstpick-token", TOKEN)
      .send({ rating: 9 });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      error: { code: "INVALID_BODY", details: { fields: [{ path: "rating" }] } },
    });
    expect(invalid.body.error.details.fields[0].message).toMatch(/[\u3400-\u9fff]/u);
  });

  it("rates a unique nonempty batch atomically and rejects partial-invalid input", async () => {
    const service = sessionService();
    const app = appWithSession({ sessionService: service });
    const accepted = await request(app).post("/api/v1/photos/ratings")
      .set("x-burstpick-token", TOKEN).send({ photoIds: ["p1", "p2"], rating: 4 });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.album.photos.map((photo: { rating: number }) => photo.rating)).toEqual([4, 4]);
    expect(service.snapshot().history).toHaveLength(1);

    const rejected = await request(app).post("/api/v1/photos/ratings")
      .set("x-burstpick-token", TOKEN).send({ photoIds: ["p1", "missing"], rating: 2 });
    expect(rejected.status).toBe(404);
    expect(service.snapshot().photos.map((photo) => photo.rating)).toEqual([4, 4]);
    const duplicate = await request(app).post("/api/v1/photos/ratings")
      .set("x-burstpick-token", TOKEN).send({ photoIds: ["p1", "p1"], rating: 1 });
    expect(duplicate.status).toBe(400);
    expect(service.snapshot().history).toHaveLength(1);
  });

  it("maps oversized JSON bodies to a stable validation envelope", async () => {
    const response = await request(appWithSession())
      .patch("/api/v1/photos/p1/rating")
      .set("x-burstpick-token", TOKEN)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ rating: 2, padding: "x".repeat(70_000) }));

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: "INVALID_BODY",
      message: "请求内容无效。",
    });
  });

  it("rejects non-loopback Host and Origin headers on mutations", async () => {
    const app = appWithSession();
    const unsafeHost = await request(app)
      .patch("/api/v1/photos/p1/rating")
      .set("Host", "photos.attacker.example")
      .set("x-burstpick-token", TOKEN)
      .send({ rating: 1 });
    const unsafeOrigin = await request(app)
      .patch("/api/v1/photos/p1/rating")
      .set("Origin", "https://photos.attacker.example")
      .set("x-burstpick-token", TOKEN)
      .send({ rating: 1 });

    expect(unsafeHost.status).toBe(403);
    expect(unsafeHost.body.error.code).toBe("UNSAFE_REQUEST_ORIGIN");
    expect(unsafeOrigin.status).toBe(403);
    expect(unsafeOrigin.body.error.code).toBe("UNSAFE_REQUEST_ORIGIN");
  });

  it("rejects non-loopback Host headers on GET and HEAD API requests", async () => {
    const app = appWithSession();
    const getResponse = await request(app)
      .get("/api/v1/health")
      .set("Host", "photos.attacker.example");
    const headResponse = await request(app)
      .head("/api/v1/health")
      .set("Host", "photos.attacker.example");

    expect(getResponse.status).toBe(403);
    expect(getResponse.body.error.code).toBe("UNSAFE_REQUEST_ORIGIN");
    expect(headResponse.status).toBe(403);
  });

  it.each(["127.0.0.1", "127.0.0.1:43110", "localhost", "LOCALHOST:43110", "::1", "[::1]", "[::1]:43110"])(
    "accepts the loopback Host form %s",
    async (host) => {
      const response = await request(appWithSession()).get("/api/v1/health").set("Host", host);
      expect(response.status).toBe(200);
    },
  );

  it("rejects weak injected process tokens before creating an app or listener", async () => {
    expect(() => createApp({ token: "not-random" })).toThrow(/令牌/u);

    await expect(
      startServer({
        token: "not-random",
        port: -1,
        albumLoader: vi.fn(async () => ({
          session: albumSession(),
          persistence: { save: vi.fn(async () => undefined) },
        })),
        imageAdapter: imageAdapter(),
        folderPicker: { pick: vi.fn(async () => "/unused") },
        installSignalHandlers: false,
      }),
    ).rejects.toThrow(/令牌/u);
  });

  it("does not echo the token or exception details in errors", async () => {
    const secret = "b".repeat(64);
    const failingService = sessionService();
    vi.spyOn(failingService, "ratePhoto").mockRejectedValue(
      new Error(`/private/library failure involving ${secret}`),
    );
    const app = appWithSession({
      token: secret,
      sessionService: failingService,
    });

    const response = await request(app)
      .patch("/api/v1/photos/p1/rating")
      .set("x-burstpick-token", secret)
      .send({ rating: 2 });

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "请求处理失败，请重试。",
    });
    expect(response.text).not.toContain(secret);
    expect(response.text).not.toContain("/private/library");
    expect(response.text).not.toContain("stack");
  });

  it("maps missing domain IDs to stable 404 envelopes", async () => {
    const response = await request(appWithSession())
      .patch("/api/v1/photos/missing/rating")
      .set("x-burstpick-token", TOKEN)
      .send({ rating: 2 });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PHOTO_NOT_FOUND");
  });

  it("keeps future export boundaries explicit until their services are injected", async () => {
    const response = await request(appWithSession())
      .post("/api/v1/exports/metadata/commit")
      .set("x-burstpick-token", TOKEN)
      .send({});

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe("FEATURE_NOT_READY");
  });

  it("uses strict metadata export contracts and requires the Lightroom confirmation", async () => {
    const metadataExport = {
      latest: vi.fn(async () => ({ available: true, auditId: "b".repeat(32) })),
      preview: vi.fn(async () => ({
        confirmationId: "a".repeat(64), conflicts: 0, isDemo: false, items: [], ready: 1, skipped: 0,
      })),
      commit: vi.fn(async () => ({
        auditId: "b".repeat(32), conflicts: 0, errors: 0, items: [{ id: "item-1", status: "written" as const }], skipped: 0, written: 1,
      })),
      rollback: vi.fn(async () => ({
        auditId: "b".repeat(32), conflicts: 0, errors: 0, items: [{ id: "rollback-0", status: "rolled-back" as const }], skipped: 0, written: 0,
      })),
    };
    const app = appWithSession({ metadataExport });
    const missingConfirmation = await request(app)
      .post("/api/v1/exports/metadata/commit")
      .set("x-burstpick-token", TOKEN)
      .send({ confirmationId: "a".repeat(64) });
    const extraPreviewField = await request(app)
      .post("/api/v1/exports/metadata/preview")
      .set("x-burstpick-token", TOKEN)
      .send({ path: "/private/should-not-be-accepted" });
    const committed = await request(app)
      .post("/api/v1/exports/metadata/commit")
      .set("x-burstpick-token", TOKEN)
      .send({ confirmationId: "a".repeat(64), lightroomSavedAndClosed: true });
    const latest = await request(app)
      .get("/api/v1/exports/metadata/latest-rollback")
      .set("x-burstpick-token", TOKEN);

    expect(missingConfirmation.status).toBe(400);
    expect(extraPreviewField.status).toBe(400);
    expect(metadataExport.commit).toHaveBeenCalledTimes(1);
    expect(latest.body).toEqual({ data: { available: true, auditId: "b".repeat(32) } });
    expect(committed.body).toEqual({ data: {
      auditId: "b".repeat(32), conflicts: 0, errors: 0, items: [{ id: "item-1", status: "written" }], skipped: 0, written: 1,
    } });
    expect(committed.text).not.toContain("/private/");
  });

  it("maps truthful metadata recovery and audit outcomes without exposing paths", async () => {
    const recovery = { auditRetained: true, concurrentTargetPreserved: true, createdTargetRemoved: false, retainedBackup: false };
    const failure = Object.assign(new Error("/private/secret"), { code: "RECOVERY_REQUIRED", recovery, cleanupWarnings: ["操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。"] });
    const metadataExport = {
      latest: vi.fn(async () => ({ available: false })),
      preview: vi.fn(async () => ({ confirmationId: "a".repeat(64), conflicts: 0, isDemo: false, items: [], ready: 1, skipped: 0 })),
      commit: vi.fn(async () => { throw failure; }),
      rollback: vi.fn(async () => { throw failure; }),
    };
    const response = await request(appWithSession({ metadataExport }))
      .post("/api/v1/exports/metadata/commit")
      .set("x-burstpick-token", TOKEN)
      .send({ confirmationId: "a".repeat(64), lightroomSavedAndClosed: true });

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({
      code: "RECOVERY_REQUIRED",
      recovery,
      warnings: ["操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。"],
    });
    expect(response.body.error.message).toContain("并发创建的文件已保留，且没有原始备份");
    expect(response.text).not.toContain("/private/secret");

    const auditFailure = Object.assign(new Error("/private/audit-secret"), {
      code: "AUDIT_PERSIST_FAILED",
      recovery: { ...recovery, auditRetained: false },
    });
    const auditResponse = await request(appWithSession({ metadataExport: { ...metadataExport, commit: vi.fn(async () => { throw auditFailure; }) } }))
      .post("/api/v1/exports/metadata/commit")
      .set("x-burstpick-token", TOKEN)
      .send({ confirmationId: "a".repeat(64), lightroomSavedAndClosed: true });
    expect(auditResponse.body.error).toMatchObject({ code: "AUDIT_PERSIST_FAILED", recovery: { auditRetained: false } });
    expect(auditResponse.body.error.message).toContain("支持审计记录未能保存");
    expect(auditResponse.text).not.toContain("/private/audit-secret");

    const retainedOnly = Object.assign(new Error("retained"), {
      code: "RECOVERY_REQUIRED",
      recovery: { auditRetained: true, concurrentTargetPreserved: false, createdTargetRemoved: false, retainedBackup: true },
    });
    const retainedResponse = await request(appWithSession({ metadataExport: { ...metadataExport, commit: vi.fn(async () => { throw retainedOnly; }) } }))
      .post("/api/v1/exports/metadata/commit")
      .set("x-burstpick-token", TOKEN)
      .send({ confirmationId: "a".repeat(64), lightroomSavedAndClosed: true });
    expect(retainedResponse.body.error.recovery).toEqual(retainedOnly.recovery);
    expect(retainedResponse.body.error.message).toContain("已保留恢复备份");
    expect(retainedResponse.body.error.message).not.toContain("并发创建");
  });

  it("maps folder-picker process failures to a safe 500 envelope", async () => {
    const response = await request(
      appWithSession({
        folderPicker: {
          pick: vi.fn(async () => Promise.reject(new FolderPickerError("PICKER_FAILED"))),
        },
      }),
    )
      .post("/api/v1/directories/pick")
      .set("x-burstpick-token", TOKEN)
      .send({});

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "PICKER_FAILED",
      message: "无法打开系统文件夹选择器。",
    });
  });
});

describe("createApp album confinement", () => {
  it("aborts and awaits the active scan without installing late state", async () => {
    let finishLoader: (() => void) | undefined;
    const loaderGate = new Promise<void>((resolve) => {
      finishLoader = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const createSession = vi.fn((session: AlbumSession) => sessionService(session));
    const loader = vi.fn(
      async (
        _root: string,
        _onProgress: (progress: ScanProgressEvent) => void,
        signal: AbortSignal,
      ) => {
        observedSignal = signal;
        await loaderGate;
        return {
          session: albumSession(),
          persistence: { save: vi.fn(async () => undefined) },
          warnings: [],
        };
      },
    );
    const app = createApp({
      token: TOKEN,
      albumLoader: loader,
      createSessionService: createSession,
      validateDirectory: vi.fn(async () => "/canonical/photos"),
      imageAdapter: imageAdapter(),
    });
    apps.push(app);
    await request(app)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ path: "/photos" });
    await waitUntil(() => loader.mock.calls.length === 1);

    const closeValue: unknown = Reflect.get(app, "close");
    if (typeof closeValue !== "function") {
      finishLoader?.();
      expect(closeValue).toBeTypeOf("function");
      return;
    }
    const firstClose = closeValue.call(app) as Promise<void>;
    const secondClose = closeValue.call(app) as Promise<void>;
    let closeSettled = false;
    void firstClose.then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(secondClose).toBe(firstClose);
    expect(observedSignal?.aborted).toBe(true);
    expect(closeSettled).toBe(false);
    finishLoader?.();
    await firstClose;
    expect(createSession).not.toHaveBeenCalled();
  });

  it("does not launch a scan when directory validation finishes after close", async () => {
    let finishValidation: (() => void) | undefined;
    const validationGate = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    const validateDirectory = vi.fn(async () => {
      await validationGate;
      return "/canonical/photos";
    });
    const loader = vi.fn(async () => ({
      session: albumSession(),
      persistence: { save: vi.fn(async () => undefined) },
      warnings: [],
    }));
    const app = createApp({
      token: TOKEN,
      albumLoader: loader,
      validateDirectory,
      imageAdapter: imageAdapter(),
    });
    apps.push(app);
    const opening = request(app)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ path: "/photos" })
      .then((response) => response);
    await waitUntil(() => validateDirectory.mock.calls.length === 1);

    await app.close();
    finishValidation?.();
    const response = await opening;

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(loader).not.toHaveBeenCalled();
  });

  it("strips absolute source paths from album responses", async () => {
    const response = await request(appWithSession()).get("/api/v1/albums/album-1");

    expect(response.status).toBe(200);
    expect(response.body.data.album.photos[0].jpeg).toEqual({
      kind: "jpeg",
      relativePath: "DSC_0001.JPG",
      size: 42,
      modifiedAtMs: 1,
    });
    expect(response.text).not.toContain("/private/library");
  });

  it.each([
    "/private/relative-secret.jpg",
    "C:\\private\\relative-secret.jpg",
    "\\\\server\\share\\relative-secret.jpg",
    "../relative-secret.jpg",
    "safe/../relative-secret.jpg",
    "safe\\..\\relative-secret.jpg",
    "safe//relative-secret.jpg",
    "safe/\0relative-secret.jpg",
  ])("fails generically when an injected session exposes unsafe relative path %j", async (relativePath) => {
    const malformed = albumSession();
    const firstPhoto = malformed.photos[0];
    if (firstPhoto?.jpeg === undefined) throw new Error("Test fixture requires a JPEG source");
    const unsafeSession = {
      ...malformed,
      photos: [
        { ...firstPhoto, jpeg: { ...firstPhoto.jpeg, relativePath } },
        ...malformed.photos.slice(1),
      ],
    } as AlbumSession;
    const service = sessionService();
    vi.spyOn(service, "snapshot").mockReturnValue(unsafeSession);

    const response = await request(appWithSession({ sessionService: service })).get(
      "/api/v1/albums/album-1",
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "请求处理失败，请重试。",
    });
    expect(response.text).not.toContain("relative-secret");
  });

  it("rejects unsafe warning relative paths without serializing them", async () => {
    const app = createApp({
      token: TOKEN,
      albumLoader: vi.fn(async () => ({
        session: albumSession(),
        persistence: { save: vi.fn(async () => undefined) },
        warnings: [{ code: "UNPAIRED_JPEG" as const, photoId: "p1", relativePaths: ["../warning-secret"] }],
      })),
      validateDirectory: vi.fn(async () => "/canonical/photos"),
      imageAdapter: imageAdapter(),
    });
    apps.push(app);
    const opened = await request(app)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ path: "/photos" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const response = await request(app).get(
      `/api/v1/albums/${opened.body.data.albumId as string}`,
    );
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("SCAN_FAILED");
    expect(response.text).not.toContain("warning-secret");
  });

  it("resolves thumbnail IDs only through the active session", async () => {
    const images = imageAdapter();
    const app = appWithSession({ imageAdapter: images });
    const response = await request(app).get(
      "/api/v1/photos/p1/thumbnail?width=320&height=240",
    );
    const missing = await request(app).get(
      "/api/v1/photos/%2Fetc%2Fpasswd/thumbnail",
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(images.thumbnail).toHaveBeenCalledWith(
      {
        path: "/private/library/DSC_0001.JPG",
        size: 42,
        modifiedAtMs: 1,
      },
      { width: 320, height: 240 },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("PHOTO_NOT_FOUND");
    expect(images.thumbnail).toHaveBeenCalledTimes(1);
  });

  it("starts one asynchronous scan and replays buffered progress over SSE", async () => {
    let finishScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      finishScan = resolve;
    });
    const loader = vi.fn(async (_root, onProgress) => {
      onProgress({ phase: "inventory", completed: 2, total: 2 });
      await scanGate;
      onProgress({ phase: "grouping", completed: 1, total: 1 });
      return {
        session: albumSession(),
        persistence: { save: vi.fn(async () => undefined) },
        warnings: [],
      };
    });
    const app = createApp({
      token: TOKEN,
      albumLoader: loader,
      validateDirectory: vi.fn(async () => "/canonical/photos"),
      imageAdapter: imageAdapter(),
      heartbeatMs: 5,
    });
    apps.push(app);

    const opened = await request(app)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ path: "~/Pictures" });
    expect(opened.status).toBe(202);
    expect(opened.body.data.status).toBe("scanning");
    expect(opened.text).not.toContain("/canonical/photos");
    const albumId = opened.body.data.albumId as string;

    const secondOpen = await request(app)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ demo: true });
    expect(secondOpen.status).toBe(409);
    expect(secondOpen.body.error.code).toBe("SCAN_IN_PROGRESS");

    const eventsPromise = request(app)
      .get(`/api/v1/albums/${albumId}/events`)
      .buffer(true)
      .parse(parseText)
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 18));
    finishScan?.();
    const events = await eventsPromise;

    expect(events.status).toBe(200);
    expect(events.body).toContain("event: snapshot");
    expect(events.body).toContain('"status":"scanning"');
    expect(events.body).toContain("event: progress");
    expect(events.body).toContain('"phase":"inventory"');
    expect(events.body).toContain('"phase":"grouping"');
    expect(events.body).toContain(": heartbeat");
    expect(events.body).toContain("event: complete");
    expect(loader).toHaveBeenCalledWith(
      "/canonical/photos",
      expect.any(Function),
      expect.any(AbortSignal),
    );

    const snapshot = await request(app).get(`/api/v1/albums/${albumId}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data.album.photos).toHaveLength(2);
  });

  it("keeps picked paths server-side behind an opaque selection ID", async () => {
    const loader = vi.fn(async () => ({
      session: albumSession(),
      persistence: { save: vi.fn(async () => undefined) },
      warnings: [],
    }));
    const app = createApp({
      token: TOKEN,
      folderPicker: { pick: vi.fn(async () => "/private/selected/album") },
      validateDirectory: vi.fn(async (path) => path),
      albumLoader: loader,
      imageAdapter: imageAdapter(),
    });
    apps.push(app);

    const picked = await request(app)
      .post("/api/v1/directories/pick")
      .set("x-burstpick-token", TOKEN)
      .send({});
    expect(picked.status).toBe(200);
    expect(picked.body.data.selectionId).toMatch(/^[0-9a-f]{32}$/);
    expect(picked.body.data.name).toBe("album");
    expect(picked.text).not.toContain("/private/selected");

    const opened = await request(app)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ selectionId: picked.body.data.selectionId });
    expect(opened.status).toBe(202);
    expect(loader).toHaveBeenCalledWith(
      "/private/selected/album",
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it("preserves stable conflict status when an asynchronous scan hits a session lock", async () => {
    const locked = Object.assign(new Error("private lock details"), {
      code: "SESSION_LOCK_TIMEOUT",
    });
    const app = createApp({
      token: TOKEN,
      albumLoader: vi.fn(async () => Promise.reject(locked)),
      validateDirectory: vi.fn(async () => "/canonical/photos"),
      imageAdapter: imageAdapter(),
    });
    apps.push(app);

    const opened = await request(app)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ path: "/photos" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshot = await request(app).get(
      `/api/v1/albums/${opened.body.data.albumId as string}`,
    );

    expect(snapshot.status).toBe(409);
    expect(snapshot.body.error).toEqual({
      code: "SESSION_LOCK_TIMEOUT",
      message: "相册正被另一个进程使用。请稍后重试。",
    });
  });
});

describe("createApp recent albums", () => {
  it("returns only id, name, and lastOpenedAt from the registry without paths", async () => {
    const record = vi.fn(async (path: string) => ({
      id: "f".repeat(64), name: "test-album", canonicalPath: path, lastOpenedAt: "2026-07-12T08:00:00.000Z", photoCount: 0, ratedCount: 0,
    }));
    const list = vi.fn(async () => [
      { id: "a".repeat(64), name: "album-1", canonicalPath: "/secret/album-1", lastOpenedAt: "2026-07-12T08:00:00.000Z", photoCount: 16, ratedCount: 5 },
      { id: "b".repeat(64), name: "album-2", canonicalPath: "/secret/album-2", lastOpenedAt: "2026-07-11T08:00:00.000Z", photoCount: 42, ratedCount: 0 },
    ]);
    const app = createApp({ token: TOKEN, recentAlbums: { list, record, remove: vi.fn(), resolve: vi.fn(), updateStats: vi.fn() }, imageAdapter: imageAdapter() });
    apps.push(app);

    const response = await request(app).get("/api/v1/albums/recent");

    expect(response.status).toBe(200);
    expect(response.body.data.albums).toHaveLength(2);
    expect(response.body.data.albums[0]).toEqual({ id: "b".repeat(64), name: "album-2", lastOpenedAt: "2026-07-11T08:00:00.000Z", photoCount: 42, ratedCount: 0 });
    expect(JSON.stringify(response.body)).not.toContain("/secret");
    expect(JSON.stringify(response.body)).not.toContain("canonicalPath");
  });

  it("opens an album through a valid recentId and records the path", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-recent-open-"));
    temporaryPaths.push(root);
    const record = vi.fn(async (path: string) => ({
      id: "f".repeat(64), name: "recorded", canonicalPath: path, lastOpenedAt: new Date().toISOString(), photoCount: 0, ratedCount: 0,
    }));
    const recentAlbums = {
      list: vi.fn(async () => []),
      record,
      remove: vi.fn(async () => undefined),
      updateStats: vi.fn(async () => undefined),
      resolve: vi.fn(async (id: string) => {
        if (id === "f".repeat(64)) return { id, name: "recent-album", canonicalPath: root, lastOpenedAt: "2026-07-12T08:00:00.000Z", photoCount: 0, ratedCount: 0 };
        return undefined;
      }),
    };
    const app = createApp({
      token: TOKEN,
      recentAlbums,
      albumLoader: vi.fn(async () => ({ session: albumSession(), persistence: { save: vi.fn(async () => undefined) }, warnings: [] })),
      validateDirectory: vi.fn(async (path: string) => path),
      imageAdapter: imageAdapter(),
    });
    apps.push(app);

    const response = await request(app).post("/api/v1/albums/open").set("x-burstpick-token", TOKEN).send({ recentId: "f".repeat(64) });

    expect(response.status).toBe(202);
    expect(recentAlbums.resolve).toHaveBeenCalledWith("f".repeat(64));
    expect(record).toHaveBeenCalled();
  });

  it("fails with a safe error for an unknown or invalid recentId", async () => {
    const recentAlbums = {
      list: vi.fn(async () => []),
      record: vi.fn(),
      remove: vi.fn(async () => undefined),
      resolve: vi.fn(async () => undefined),
      updateStats: vi.fn(async () => undefined),
    };
    const app = createApp({
      token: TOKEN,
      recentAlbums,
      albumLoader: vi.fn(async () => ({ session: albumSession(), persistence: { save: vi.fn(async () => undefined) }, warnings: [] })),
      imageAdapter: imageAdapter(),
    });
    apps.push(app);

    const missing = await request(app).post("/api/v1/albums/open").set("x-burstpick-token", TOKEN).send({ recentId: "1".repeat(64) });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("DIRECTORY_SELECTION_NOT_FOUND");
    expect(JSON.stringify(missing.body)).not.toContain("/");

    const invalid = await request(app).post("/api/v1/albums/open").set("x-burstpick-token", TOKEN).send({ recentId: "bad" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_BODY");
  });

  it("returns an empty list when no recent albums are registered", async () => {
    const app = createApp({ token: TOKEN, imageAdapter: imageAdapter() });
    apps.push(app);

    const response = await request(app).get("/api/v1/albums/recent");

    expect(response.status).toBe(200);
    expect(response.body.data.albums).toEqual([]);
  });
});

describe("folder picker", () => {
  it("canonicalizes manual paths and requires directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-picker-"));
    temporaryPaths.push(root);
    const directory = join(root, "album");
    const alias = join(root, "alias");
    await import("node:fs/promises").then(async ({ mkdir }) => mkdir(directory));
    await symlink(directory, alias);

    await expect(validateManualDirectory(alias)).resolves.toBe(await realpath(directory));
    const file = join(root, "not-a-directory");
    await writeFile(file, "x");
    await expect(validateManualDirectory(file)).rejects.toMatchObject({
      code: "INVALID_DIRECTORY",
    });
  });

  it("uses osascript argv without a shell and distinguishes cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-osascript-"));
    temporaryPaths.push(root);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(),
    });
    const spawnProcess = vi.fn(() => child as never);
    const picker = createFolderPicker({ platform: "darwin", spawnProcess });

    const picked = picker.pick();
    stdout.end(`${root}\n`);
    stderr.end();
    child.emit("close", 0, null);

    await expect(picked).resolves.toBe(await realpath(root));
    expect(spawnProcess).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.stringContaining("choose folder")],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );

    const cancelledStdout = new PassThrough();
    const cancelledStderr = new PassThrough();
    const cancelledChild = Object.assign(new EventEmitter(), {
      stdout: cancelledStdout,
      stderr: cancelledStderr,
      kill: vi.fn(),
    });
    const cancelledPicker = createFolderPicker({
      platform: "darwin",
      spawnProcess: vi.fn(() => cancelledChild as never),
    });
    const cancelled = cancelledPicker.pick();
    cancelledStdout.end();
    cancelledStderr.end("execution error: User canceled. (-128)\n");
    cancelledChild.emit("close", 1, null);

    await expect(cancelled).rejects.toMatchObject({ code: "PICKER_CANCELLED" });
  });
});

describe("startServer", () => {
  it("generates independent 32-byte hexadecimal process tokens", () => {
    const first = generateProcessToken();
    const second = generateProcessToken();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it("binds exactly to IPv4 loopback, prints one URL, and shuts metadata down once", async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), "burstpick-client-"));
    temporaryPaths.push(clientRoot);
    await writeFile(join(clientRoot, "index.html"), "<!doctype html><title>BurstPick</title>");
    const metadata = metadataAdapter();
    const images = imageAdapter();
    const logger = { info: vi.fn() };

    const running = await startServer({
      port: 0,
      environment: "production",
      token: TOKEN,
      clientRoot,
      logger,
      metadataAdapter: metadata,
      imageAdapter: images,
      folderPicker: { pick: vi.fn(async () => clientRoot) },
      albumLoader: vi.fn(async () => ({
        session: albumSession(),
        persistence: { save: vi.fn(async () => undefined) },
        warnings: [],
      })),
      installSignalHandlers: false,
    });

    const address = running.server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(running.url).toBe(`http://127.0.0.1:${address.port}/?token=${TOKEN}`);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(running.url);

    const health = await request(running.server).get("/api/v1/health");
    const client = await request(running.server).get("/");
    expect(health.status).toBe(200);
    expect({ status: client.status, text: client.text }).toEqual({
      status: 200,
      text: expect.stringContaining("<title>BurstPick</title>"),
    });
    expect(client.text).toContain("<title>BurstPick</title>");

    await running.close();
    await running.close();
    expect(metadata.end).toHaveBeenCalledTimes(1);
  });

  it("awaits active scan cancellation before ending the metadata adapter", async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), "burstpick-cancel-client-"));
    temporaryPaths.push(clientRoot);
    await writeFile(join(clientRoot, "index.html"), "<!doctype html><title>BurstPick</title>");
    const order: string[] = [];
    const metadata = metadataAdapter();
    vi.mocked(metadata.end).mockImplementation(async () => {
      order.push("metadata-end");
    });
    let finishLoader: (() => void) | undefined;
    const loaderGate = new Promise<void>((resolve) => {
      finishLoader = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const loader = vi.fn(
      async (
        _root: string,
        _onProgress: (progress: ScanProgressEvent) => void,
        signal: AbortSignal,
      ) => {
        observedSignal = signal;
        await loaderGate;
        order.push("loader-settled");
        return {
          session: albumSession(),
          persistence: { save: vi.fn(async () => undefined) },
          warnings: [],
        };
      },
    );
    const running = await startServer({
      port: 0,
      environment: "production",
      token: TOKEN,
      clientRoot,
      logger: { info: vi.fn() },
      metadataAdapter: metadata,
      imageAdapter: imageAdapter(),
      folderPicker: { pick: vi.fn(async () => clientRoot) },
      albumLoader: loader,
      installSignalHandlers: false,
    });
    await request(running.server)
      .post("/api/v1/albums/open")
      .set("x-burstpick-token", TOKEN)
      .send({ path: clientRoot });
    await waitUntil(() => loader.mock.calls.length === 1);

    const close = running.close();
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeUnwind = closeSettled;
    finishLoader?.();
    await close;

    expect(observedSignal?.aborted).toBe(true);
    expect(settledBeforeUnwind).toBe(false);
    expect(order).toEqual(["loader-settled", "metadata-end"]);
    expect(metadata.end).toHaveBeenCalledTimes(1);
  });

  it("kills a pending osascript picker before awaiting HTTP shutdown", async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), "burstpick-picker-client-"));
    temporaryPaths.push(clientRoot);
    await writeFile(join(clientRoot, "index.html"), "<!doctype html><title>BurstPick</title>");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const spawnProcess = vi.fn(() => child as never);
    const picker = createFolderPicker({ platform: "darwin", spawnProcess });
    const metadata = metadataAdapter();
    const running = await startServer({
      port: 0,
      environment: "production",
      token: TOKEN,
      clientRoot,
      logger: { info: vi.fn() },
      metadataAdapter: metadata,
      imageAdapter: imageAdapter(),
      folderPicker: picker,
      albumLoader: vi.fn(async () => ({
        session: albumSession(),
        persistence: { save: vi.fn(async () => undefined) },
        warnings: [],
      })),
      installSignalHandlers: false,
    });

    const pickerResponse = request(running.server)
      .post("/api/v1/directories/pick")
      .set("x-burstpick-token", TOKEN)
      .send({})
      .then((response) => response);
    await waitUntil(() => spawnProcess.mock.calls.length === 1);
    const firstClose = running.close();
    const secondClose = running.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const killedBeforeManualClose = child.kill.mock.calls.length === 1;
    stderr.end("execution error: User canceled. (-128)\n");
    stdout.end();
    child.emit("close", 1, null);
    const response = await pickerResponse;
    await firstClose;

    expect(secondClose).toBe(firstClose);
    expect(killedBeforeManualClose).toBe(true);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PICKER_CANCELLED");
    expect(metadata.end).toHaveBeenCalledTimes(1);
  });

  it("mounts injected Vite middleware in development and closes it", async () => {
    const metadata = metadataAdapter();
    const closeVite = vi.fn(async () => undefined);
    const middleware: RequestHandler = (request, response, next) => {
      if (request.path === "/vite-error") {
        next(new Error("/private/vite-stack"));
        return;
      }
      if (request.path === "/vite-probe") {
        response.type("text/plain").send("vite middleware");
        return;
      }
      next();
    };
    const createViteServer = vi.fn(async () => ({
      close: closeVite,
      middlewares: middleware,
    }) as never);

    const running = await startServer({
      port: 0,
      environment: "development",
      token: TOKEN,
      logger: { info: vi.fn() },
      metadataAdapter: metadata,
      imageAdapter: imageAdapter(),
      folderPicker: { pick: vi.fn(async () => "/unused") },
      albumLoader: vi.fn(async () => ({
        session: albumSession(),
        persistence: { save: vi.fn(async () => undefined) },
        warnings: [],
      })),
      createViteServer,
      installSignalHandlers: false,
    });

    const response = await request(running.server).get("/vite-probe");
    const fallback = await request(running.server).get("/vite-error");
    expect(response.status).toBe(200);
    expect(response.text).toBe("vite middleware");
    expect(fallback.status).toBe(500);
    expect(fallback.text).toBe("请求处理失败。");
    expect(fallback.text).not.toContain("/private");
    expect(createViteServer).toHaveBeenCalledWith(
      expect.objectContaining({ server: { middlewareMode: true } }),
    );

    await running.close();
    expect(closeVite).toHaveBeenCalledTimes(1);
    expect(metadata.end).toHaveBeenCalledTimes(1);
  });
});
