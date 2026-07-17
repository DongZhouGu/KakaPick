import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AlbumSessionSchema, type AlbumSession } from "../shared/domain.js";

const operationTails = new Map<string, Promise<void>>();
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

export interface SessionLockCoordinatorOptions {
  readonly lockRetryMs?: number;
  readonly lockTimeoutMs?: number;
  readonly onWarning?: (warning: SessionStoreWarning) => void;
}

export interface SessionStoreWarning {
  readonly code: "SESSION_LOCK_RELEASE_FAILED";
  readonly message: string;
}

export class SessionLockError extends Error {
  readonly code = "SESSION_LOCK_TIMEOUT" as const;
  readonly manualRecoveryRequired = true;

  constructor() {
    super("Session is locked by another BurstPick process");
    this.name = "SessionLockError";
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function parseLockOwner(contents: string): LockOwner | undefined {
  try {
    const owner: unknown = JSON.parse(contents);
    if (
      typeof owner === "object" &&
      owner !== null &&
      "pid" in owner &&
      Number.isSafeInteger(owner.pid) &&
      typeof owner.pid === "number" &&
      owner.pid > 0 &&
      "token" in owner &&
      typeof owner.token === "string" &&
      owner.token.length > 0
    ) {
      return { pid: owner.pid, token: owner.token };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function releaseOwnedLock(
  lockPath: string,
  token: string,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<boolean> {
  let owner: LockOwner | undefined;
  try {
    owner = parseLockOwner(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  if (owner?.token !== token) return false;

  let pathStats: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStats = await lstat(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const handleStats = await handle.stat();
  if (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) return false;

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

/**
 * Filesystem locks are deliberately fail-closed. An existing lock is never stolen automatically,
 * even when its recorded PID appears dead, because pathname APIs cannot compare-and-delete an
 * owner token atomically. Recovery requires the user to confirm that no BurstPick process is
 * running before explicitly removing the sibling lock file; a later UI will guide that action.
 */
export class SessionLockCoordinator {
  readonly #onWarning: ((warning: SessionStoreWarning) => void) | undefined;
  readonly #retryMs: number;
  readonly #timeoutMs: number;

  constructor(options: SessionLockCoordinatorOptions = {}) {
    this.#onWarning = options.onWarning;
    this.#retryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.#timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async runExclusive<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = `${targetPath}.lock`;
    const token = randomUUID();
    const owner: LockOwner = { pid: process.pid, token };
    const startedAt = Date.now();

    while (true) {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        if (Date.now() - startedAt >= this.#timeoutMs) throw new SessionLockError();
        await delay(this.#retryMs);
        continue;
      }

      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
      } catch (error) {
        await this.#cleanup(lockPath, token, handle);
        throw error;
      }

      let outcome: { readonly ok: true; readonly value: T } | { readonly error: unknown; readonly ok: false };
      try {
        outcome = { ok: true, value: await operation() };
      } catch (error) {
        outcome = { error, ok: false };
      }
      await this.#cleanup(lockPath, token, handle);
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }
  }

  async #cleanup(
    lockPath: string,
    token: string,
    handle: Awaited<ReturnType<typeof open>>,
  ): Promise<void> {
    let failed = false;
    try {
      failed = !(await releaseOwnedLock(lockPath, token, handle));
    } catch {
      failed = true;
    }
    try {
      await handle.close();
    } catch {
      failed = true;
    }
    if (!failed) return;

    try {
      this.#onWarning?.({
        code: "SESSION_LOCK_RELEASE_FAILED",
        message: "Session lock cleanup failed; manual recovery may be required",
      });
    } catch {
      // Warning handlers are observational and must never change persistence outcomes.
    }
  }
}

export interface SessionStoreOptions extends SessionLockCoordinatorOptions {
  readonly lockCoordinator?: SessionLockCoordinator;
}

function normalizeFilename(filename: string): string {
  const normalized = filename.normalize("NFC");
  return process.platform === "darwin" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

interface SessionPaths {
  readonly ioTargetPath: string;
  readonly lockIdentity: string;
}

async function resolveSessionPaths(path: string): Promise<SessionPaths | undefined> {
  try {
    const canonicalParent = await realpath(dirname(path));
    const requestedFilename = basename(path);
    return {
      ioTargetPath: join(canonicalParent, requestedFilename),
      lockIdentity: join(canonicalParent, normalizeFilename(requestedFilename)),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function quarantine(path: string): Promise<void> {
  const quarantinePath = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

function serializeForPath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(path) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  operationTails.set(path, tail);

  return result.finally(() => {
    if (operationTails.get(path) === tail) operationTails.delete(path);
  });
}

export class SessionStore {
  readonly #lockCoordinator: SessionLockCoordinator;
  readonly #requestedPath: string;

  constructor(path: string, options: SessionStoreOptions = {}) {
    this.#requestedPath = resolve(path);
    this.#lockCoordinator =
      options.lockCoordinator ?? new SessionLockCoordinator(options);
  }

  async load(): Promise<AlbumSession | undefined> {
    const paths = await resolveSessionPaths(this.#requestedPath);
    if (paths === undefined) return undefined;

    return serializeForPath(paths.lockIdentity, () =>
      this.#lockCoordinator.runExclusive(paths.lockIdentity, async () => {
        let contents: string;
        try {
          contents = await readFile(paths.ioTargetPath, "utf8");
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) return undefined;
          throw error;
        }

        try {
          return AlbumSessionSchema.parse(JSON.parse(contents));
        } catch {
          await quarantine(paths.ioTargetPath);
          return undefined;
        }
      }),
    );
  }

  async save(session: AlbumSession): Promise<void> {
    const validated = AlbumSessionSchema.parse(session);
    await mkdir(dirname(this.#requestedPath), { recursive: true, mode: 0o700 });
    const paths = await resolveSessionPaths(this.#requestedPath);
    if (paths === undefined) {
      throw new Error("Session parent directory disappeared before save");
    }

    return serializeForPath(paths.lockIdentity, () =>
      this.#lockCoordinator.runExclusive(paths.lockIdentity, async () => {
        const temporaryPath = `${paths.ioTargetPath}.tmp-${randomUUID()}`;
        let handle: Awaited<ReturnType<typeof open>> | undefined;

        try {
          handle = await open(temporaryPath, "wx", 0o600);
          await handle.writeFile(JSON.stringify(validated), "utf8");
          await handle.sync();
          await handle.close();
          handle = undefined;
          await rename(temporaryPath, paths.ioTargetPath);
        } catch (error) {
          if (handle !== undefined) {
            await handle.close().catch(() => undefined);
          }
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
      }),
    );
  }
}
