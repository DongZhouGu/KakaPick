import { spawn, type ChildProcess } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const PICKER_OUTPUT_LIMIT = 16_384;
const PICKER_SCRIPT = 'POSIX path of (choose folder with prompt "选择照片文件夹")';

export type FolderPickerErrorCode =
  | "INVALID_DIRECTORY"
  | "PICKER_CANCELLED"
  | "PICKER_UNAVAILABLE"
  | "PICKER_FAILED";

const ERROR_MESSAGES: Readonly<Record<FolderPickerErrorCode, string>> = {
  INVALID_DIRECTORY: "请选择一个可读取的文件夹。",
  PICKER_CANCELLED: "已取消选择文件夹。",
  PICKER_UNAVAILABLE: "当前平台不支持系统文件夹选择器。",
  PICKER_FAILED: "无法打开系统文件夹选择器。",
};

export class FolderPickerError extends Error {
  readonly code: FolderPickerErrorCode;

  constructor(code: FolderPickerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "FolderPickerError";
    this.code = code;
  }
}

export interface FolderPicker {
  close?(): Promise<void>;
  pick(): Promise<string>;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: {
    readonly shell: false;
    readonly stdio: ["ignore", "pipe", "pipe"];
  },
) => ChildProcess;

export interface CreateFolderPickerOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: SpawnProcess;
}

function cancellationMessage(message: string): boolean {
  return /(?:\(-128\)|User canceled|User cancelled)/iu.test(message);
}

export async function validateManualDirectory(path: string): Promise<string> {
  if (path.trim().length === 0) throw new FolderPickerError("INVALID_DIRECTORY");

  try {
    const canonicalPath = await realpath(resolve(path));
    const pathStats = await stat(canonicalPath);
    if (!pathStats.isDirectory()) throw new FolderPickerError("INVALID_DIRECTORY");
    await access(canonicalPath, constants.R_OK);
    return canonicalPath;
  } catch (error) {
    if (error instanceof FolderPickerError) throw error;
    throw new FolderPickerError("INVALID_DIRECTORY");
  }
}

function runPicker(
  spawnProcess: SpawnProcess,
  onStart: (child: ChildProcess) => void,
  cancellationRequested: () => boolean,
): Promise<string> {
  const completion = new Promise<string>((resolvePicker, rejectPicker) => {
    const child = spawnProcess("osascript", ["-e", PICKER_SCRIPT], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function rejectOnce(error: FolderPickerError): void {
      if (settled) return;
      settled = true;
      rejectPicker(error);
    }

    function appendOutput(current: string, chunk: Buffer | string): string {
      const next = current + chunk.toString();
      if (next.length > PICKER_OUTPUT_LIMIT) {
        child.kill();
        rejectOnce(new FolderPickerError("PICKER_FAILED"));
      }
      return next.slice(0, PICKER_OUTPUT_LIMIT + 1);
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", () => rejectOnce(new FolderPickerError("PICKER_FAILED")));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        rejectOnce(
          cancellationRequested() || cancellationMessage(stderr)
            ? new FolderPickerError("PICKER_CANCELLED")
            : new FolderPickerError("PICKER_FAILED"),
        );
        return;
      }
      const path = stdout.trim();
      if (path.length === 0) {
        rejectOnce(new FolderPickerError("PICKER_FAILED"));
        return;
      }
      settled = true;
      resolvePicker(path);
    });
    onStart(child);
  });
  return completion;
}

export function createFolderPicker(options: CreateFolderPickerOptions = {}): FolderPicker {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? (spawn as SpawnProcess);
  const pending = new Map<ChildProcess, Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  let closing = false;

  return {
    close() {
      closePromise ??= (async () => {
        closing = true;
        const completions = [...pending.entries()].map(([child, completion]) => {
          child.kill();
          return completion;
        });
        await Promise.allSettled(completions);
      })();
      return closePromise;
    },
    async pick() {
      if (platform !== "darwin") throw new FolderPickerError("PICKER_UNAVAILABLE");
      if (closing) throw new FolderPickerError("PICKER_CANCELLED");
      let child: ChildProcess | undefined;
      const completion = runPicker(
        spawnProcess,
        (startedChild) => {
          child = startedChild;
        },
        () => closing,
      );
      if (child !== undefined) pending.set(child, completion);
      try {
        return validateManualDirectory(await completion);
      } finally {
        if (child !== undefined) pending.delete(child);
      }
    },
  };
}
