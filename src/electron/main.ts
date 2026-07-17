import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, shell, type OpenDialogOptions } from "electron";
import { FolderPickerError, type FolderPicker } from "../server/adapters/folder-picker.js";
import { startServer, type RunningServer } from "../server/index.js";
import { isInternalNavigation, safeExternalUrl } from "./security.js";

app.setPath("userData", join(app.getPath("appData"), "BurstPick"));

let mainWindow: BrowserWindow | undefined;
let runningServer: RunningServer | undefined;
let allowQuit = false;

function logStartupFailure(error: unknown): string {
  const logPath = join(app.getPath("userData"), "kakapick.log");
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `[${new Date().toISOString()}] Startup failure\n${detail}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // The native dialog below remains available when the log cannot be written.
  }
  return logPath;
}

function electronFolderPicker(): FolderPicker {
  return {
    async pick() {
      const options: OpenDialogOptions = {
        buttonLabel: "选择",
        properties: ["openDirectory"],
        title: "选择照片文件夹",
      };
      const result = mainWindow === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(mainWindow, options);
      const path = result.filePaths[0];
      if (result.canceled || path === undefined) throw new FolderPickerError("PICKER_CANCELLED");
      return path;
    },
  };
}

function openExternal(candidate: string): void {
  const target = safeExternalUrl(candidate);
  if (target !== undefined) void shell.openExternal(target.href);
}

function createMainWindow(appUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    backgroundColor: "#0b0c0e",
    height: 920,
    minHeight: 680,
    minWidth: 1000,
    show: false,
    title: "咔咔选 KakaPick",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 1440,
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.on("will-navigate", (event, candidate) => {
    if (isInternalNavigation(appUrl, candidate)) return;
    event.preventDefault();
    openExternal(candidate);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalNavigation(appUrl, url)) openExternal(url);
    return { action: "deny" };
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  void window.loadURL(appUrl);
  return window;
}

async function launch(): Promise<void> {
  runningServer = await startServer({
    clientRoot: join(app.getAppPath(), "dist", "client"),
    environment: "production",
    folderPicker: electronFolderPicker(),
    installSignalHandlers: false,
    logger: { info() {} },
    port: 0,
  });
  mainWindow = createMainWindow(runningServer.url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (allowQuit || runningServer === undefined) return;
    event.preventDefault();
    allowQuit = true;
    void runningServer.close().finally(() => app.quit());
  });
  void app.whenReady().then(launch).catch(async (error: unknown) => {
    const logPath = logStartupFailure(error);
    await runningServer?.close().catch(() => undefined);
    dialog.showErrorBox(
      "咔咔选无法启动",
      `本机服务启动失败。请查看日志：\n${logPath}`,
    );
    allowQuit = true;
    app.quit();
  });
}
