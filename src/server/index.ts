import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import type { InlineConfig, ViteDevServer } from "vite";
import { AlbumSessionSchema, type AlbumSession } from "../shared/domain.js";
import {
  assertProcessToken,
  createApp,
  type AlbumLoader,
  type BurstPickApp,
} from "./app.js";
import { createFolderPicker, type FolderPicker } from "./adapters/folder-picker.js";
import { createImageAdapter, type ImageAdapter } from "./adapters/image.js";
import { createMetadataAdapter, type MetadataAdapter } from "./adapters/metadata.js";
import { scanAlbum, type ScanAlbumResult } from "./scanner.js";
import { SessionStore } from "./session-store.js";
import { RecentAlbumsStore } from "./recent-albums-store.js";
import { createMetadataExportService } from "./export/metadata-export.js";
import { createCopyExportService } from "./export/copy-export.js";

const DEFAULT_PORT = 43_110;

interface ServerLogger {
  info(message: string): void;
}

type ViteServerBoundary = Pick<ViteDevServer, "close" | "middlewares">;

export interface StartServerOptions {
  readonly albumLoader?: AlbumLoader;
  readonly appDataRoot?: string;
  readonly cacheRoot?: string;
  readonly clientRoot?: string;
  readonly createViteServer?: (config: InlineConfig) => Promise<ViteServerBoundary>;
  readonly environment?: "development" | "production";
  readonly folderPicker?: FolderPicker;
  readonly imageAdapter?: ImageAdapter;
  readonly installSignalHandlers?: boolean;
  readonly logger?: ServerLogger;
  readonly metadataAdapter?: MetadataAdapter;
  readonly port?: number;
  readonly token?: string;
}

export interface RunningServer {
  readonly app: BurstPickApp;
  readonly server: Server;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
}

function defaultCacheRoot(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "BurstPick")
    : join(homedir(), ".cache", "burstpick");
}

function defaultAppDataRoot(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "BurstPick")
    : join(homedir(), ".local", "share", "burstpick");
}

function sessionFromScan(result: ScanAlbumResult): AlbumSession {
  return AlbumSessionSchema.parse({
    schemaVersion: result.schemaVersion,
    sourcePathHash: result.sourcePathHash,
    inventoryFingerprint: result.inventoryFingerprint,
    boundaryOverrides: result.boundaryOverrides,
    photos: result.photos,
    groups: result.groups,
    groupingSensitivity: result.groupingSensitivity,
    history: result.history,
    rejectedIds: result.rejectedIds ?? [],
    updatedAt: result.updatedAt,
  });
}

export function sessionPathForSource(appDataRoot: string, canonicalSource: string): string {
  const key = createHash("sha256").update(canonicalSource).digest("hex");
  return join(appDataRoot, "sessions", key, "session-v1.json");
}

function defaultAlbumLoader(
  metadata: MetadataAdapter,
  images: ImageAdapter,
  cacheRoot: string,
  appDataRoot: string,
): AlbumLoader {
  return async (root, onProgress, signal) => {
    const store = new SessionStore(sessionPathForSource(appDataRoot, root));
    const result = await scanAlbum(
      {
        root,
        cacheRoot,
        images,
        metadata,
        sessionStore: store,
        signal,
      },
      onProgress,
    );
    return {
      session: sessionFromScan(result),
      persistence: store,
      warnings: result.warnings,
    };
  };
}

function serverPort(options: StartServerOptions): number {
  const configured =
    options.port ??
    (process.env.BURSTPICK_PORT === undefined
      ? DEFAULT_PORT
      : Number.parseInt(process.env.BURSTPICK_PORT, 10));
  if (!Number.isSafeInteger(configured) || configured < 0 || configured > 65_535) {
    throw new RangeError("服务端口必须是 0 到 65535 之间的整数。");
  }
  return configured;
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

async function listenOnLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function clientRootFromModule(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../client");
}

export function generateProcessToken(): string {
  return randomBytes(32).toString("hex");
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const token = options.token ?? generateProcessToken();
  const appDataRoot = options.appDataRoot ?? defaultAppDataRoot();
  assertProcessToken(token);
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  const images = options.imageAdapter ?? createImageAdapter({ cacheRoot });
  const needsDefaultLoader = options.albumLoader === undefined;
  const metadata =
    options.metadataAdapter ?? (needsDefaultLoader ? createMetadataAdapter() : undefined);
  if (needsDefaultLoader && metadata === undefined) {
    throw new Error("默认相册加载器缺少元数据适配器。");
  }
  const loader =
    options.albumLoader ?? defaultAlbumLoader(metadata as MetadataAdapter, images, cacheRoot, appDataRoot);
  const picker = options.folderPicker ?? createFolderPicker();
  // Clean stale metadata export locks from previous crashes
  const locksDir = join(appDataRoot, "metadata-export-locks");
  try { const { readdir: rd, rm } = await import("node:fs/promises"); for (const f of await rd(locksDir)) { if (f.endsWith(".lock")) await rm(join(locksDir, f), { force: true }); } } catch { /* ok if dir doesn't exist */ }

  const recentAlbums = new RecentAlbumsStore(join(appDataRoot, "recent-albums-v1.json"));
  const app = createApp({
    token,
    albumLoader: loader,
    folderPicker: picker,
    imageAdapter: images,
    recentAlbums,
    appDataRoot,
    copyExport: createCopyExportService({ appDataRoot }),
    ...(metadata === undefined ? {} : {
      metadataExport: createMetadataExportService({
        appDataRoot,
        images,
        metadata,
      }),
    }),
  });
  const environment =
    options.environment ?? (process.env.NODE_ENV === "development" ? "development" : "production");
  let vite: ViteServerBoundary | undefined;
  let server: Server | undefined;

  try {
    if (environment === "development") {
      const createVite =
        options.createViteServer ??
        (await import("vite")).createServer;
      vite = await createVite({
        appType: "spa",
        logLevel: "silent",
        root: options.clientRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../"),
        server: { middlewareMode: true },
      });
      app.use(vite.middlewares);
    } else {
      const clientRoot = options.clientRoot ?? clientRootFromModule();
      app.use(express.static(clientRoot, { index: "index.html" }));
      app.get(/^(?!\/api\/v1(?:\/|$)).*/u, (_request, response) => {
        response.sendFile(join(clientRoot, "index.html"), (error) => {
          if (error !== undefined && !response.headersSent) response.status(404).end();
        });
      });
    }

    const safeStaticError: ErrorRequestHandler = (_error, _request, response, next) => {
      void next;
      if (!response.headersSent) response.status(500).type("text/plain").send("请求处理失败。");
    };
    app.use(safeStaticError);

    server = createServer(app);
    await listenOnLoopback(server, serverPort(options));
  } catch (error) {
    await app.close();
    if (server?.listening === true) await closeHttpServer(server).catch(() => undefined);
    await vite?.close().catch(() => undefined);
    await metadata?.end().catch(() => undefined);
    throw error;
  }

  const runningServer = server;
  const address = runningServer.address();
  if (address === null || typeof address === "string") {
    await app.close();
    await closeHttpServer(runningServer).catch(() => undefined);
    await vite?.close().catch(() => undefined);
    await metadata?.end().catch(() => undefined);
    throw new Error("本机服务未能取得 TCP 地址。");
  }
  const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`;
  (options.logger ?? console).info(url);

  let shutdownPromise: Promise<void> | undefined;
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  if (installSignalHandlers) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  function close(): Promise<void> {
    shutdownPromise ??= (async () => {
      if (installSignalHandlers) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
      const errors: unknown[] = [];
      await app.close().catch((error: unknown) => errors.push(error));
      await closeHttpServer(runningServer).catch((error: unknown) => errors.push(error));
      await vite?.close().catch((error: unknown) => errors.push(error));
      await metadata?.end().catch((error: unknown) => errors.push(error));
      if (errors.length > 0) throw new AggregateError(errors, "服务关闭失败。");
    })();
    return shutdownPromise;
  }

  return { app, server: runningServer, token, url, close };
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  void startServer().catch(() => {
    console.error("咔咔选启动失败。");
    process.exitCode = 1;
  });
}
