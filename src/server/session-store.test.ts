import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const controlledRead = vi.hoisted(() => ({
  paths: undefined as string[] | undefined,
  pause: undefined as (() => Promise<void>) | undefined,
}));

const controlledUnlink = vi.hoisted(() => ({
  paths: undefined as string[] | undefined,
}));

const controlledRename = vi.hoisted(() => ({
  sessionDestinations: undefined as string[] | undefined,
}));

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  const readFileWithControl = (async (path: string, encoding: BufferEncoding) => {
    const contents = await actual.readFile(path, encoding);
    if (controlledRead.paths?.includes(path) === true) {
      const pause = controlledRead.pause;
      controlledRead.paths = undefined;
      controlledRead.pause = undefined;
      await pause?.();
    }
    return contents;
  }) as typeof actual.readFile;
  const unlinkWithControl = (async (path: string) => {
    if (controlledUnlink.paths?.includes(path) === true) {
      throw Object.assign(new Error("Injected lock unlink failure"), { code: "EIO" });
    }
    await actual.unlink(path);
  }) as typeof actual.unlink;
  const renameWithControl = (async (oldPath: string, newPath: string) => {
    if (oldPath.includes(".tmp-") && controlledRename.sessionDestinations !== undefined) {
      controlledRename.sessionDestinations.push(newPath);
    }
    await actual.rename(oldPath, newPath);
  }) as typeof actual.rename;

  return {
    ...actual,
    readFile: readFileWithControl,
    rename: renameWithControl,
    unlink: unlinkWithControl,
  };
});

import type { AlbumSession, PhotoUnit } from "../shared/domain.js";
import { SessionService } from "./session-service.js";
import { SessionLockCoordinator, SessionStore } from "./session-store.js";

const temporaryDirectories: string[] = [];

function photo(id: string, capturedAtMs: number): PhotoUnit {
  return {
    id,
    stem: id,
    jpeg: {
      kind: "jpeg",
      path: `/shoot/${id}.jpg`,
      relativePath: `${id}.jpg`,
      size: 1,
      modifiedAtMs: capturedAtMs,
    },
    capturedAtMs,
    captureTimeSource: "exif",
    rating: 0,
  };
}

function session(): AlbumSession {
  return {
    schemaVersion: 1,
    sourcePathHash: "source-hash",
    inventoryFingerprint: "inventory-fingerprint",
    boundaryOverrides: [],
    photos: [photo("p1", 100)],
    groups: [
      {
        id: "g1",
        photoIds: ["p1"],
        startedAtMs: 100,
        endedAtMs: 100,
        confidence: 1,
        manual: false,
      },
    ],
    groupingSensitivity: 1,
    history: [], rejectedIds: [],
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

async function sessionPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "burstpick-session-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "session.json");
}

afterEach(async () => {
  controlledRead.paths = undefined;
  controlledRead.pause = undefined;
  controlledUnlink.paths = undefined;
  controlledRename.sessionDestinations = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SessionStore", () => {
  it("returns undefined when the session file is missing", async () => {
    const path = await sessionPath();

    await expect(new SessionStore(path).load()).resolves.toBeUndefined();
  });

  it("atomically saves a validated private session and loads it", async () => {
    const path = await sessionPath();
    const store = new SessionStore(path);
    const expected = session();

    await store.save(expected);

    await expect(store.load()).resolves.toEqual(expected);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(path, ".."))).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );
  });

  it("round-trips a session with non-empty typed history", async () => {
    const path = await sessionPath();
    const expected = session();
    expected.photos = expected.photos.map((item) => ({ ...item, rating: 4 }));
    expected.history = [
      { type: "rate", payload: { ratings: [{ photoId: "p1", rating: 0 }] } },
    ];
    expected.updatedAt = "2026-07-11T01:00:00.000Z";
    const store = new SessionStore(path);

    await store.save(expected);

    await expect(store.load()).resolves.toEqual(expected);
  });

  it("rejects an invalid session before replacing the persisted snapshot", async () => {
    const path = await sessionPath();
    const store = new SessionStore(path);
    const expected = session();
    await store.save(expected);
    const invalid = { ...expected, groupingSensitivity: 3 } as AlbumSession;

    await expect(store.save(invalid)).rejects.toThrow();

    await expect(store.load()).resolves.toEqual(expected);
    expect((await readdir(join(path, ".."))).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );
  });

  it("preserves the prior target and removes the temporary file when replacement fails", async () => {
    const path = await sessionPath();
    const priorMarker = join(path, "prior-marker");
    await mkdir(path);
    await writeFile(priorMarker, "prior", { mode: 0o600 });

    await expect(new SessionStore(path).save(session())).rejects.toThrow();

    await expect(readFile(priorMarker, "utf8")).resolves.toBe("prior");
    expect((await readdir(join(path, ".."))).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );
  });

  it("quarantines invalid JSON before returning undefined", async () => {
    const path = await sessionPath();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await writeFile(path, "{not-json", { mode: 0o600 });

    await expect(new SessionStore(path).load()).resolves.toBeUndefined();

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const quarantineFile = (await readdir(join(path, ".."))).find((name) =>
      name.startsWith("session.json.corrupt-1700000000000-"),
    );
    expect(quarantineFile).toBeDefined();
    await expect(readFile(join(path, "..", quarantineFile ?? "missing"), "utf8")).resolves.toBe(
      "{not-json",
    );
  });

  it("avoids overwriting an existing corruption quarantine name", async () => {
    const path = await sessionPath();
    const firstQuarantine = `${path}.corrupt-1700000000000-existing`;
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await writeFile(path, "{second-invalid", { mode: 0o600 });
    await writeFile(firstQuarantine, "{first-invalid", { mode: 0o600 });

    await expect(new SessionStore(path).load()).resolves.toBeUndefined();

    await expect(readFile(firstQuarantine, "utf8")).resolves.toBe("{first-invalid");
    const quarantineFiles = (await readdir(join(path, ".."))).filter((name) =>
      name.startsWith("session.json.corrupt-1700000000000-"),
    );
    expect(quarantineFiles).toHaveLength(2);
    const secondQuarantine = quarantineFiles.find((name) => !name.endsWith("-existing"));
    expect(secondQuarantine).toBeDefined();
    await expect(
      readFile(join(path, "..", secondQuarantine ?? "missing"), "utf8"),
    ).resolves.toBe("{second-invalid");
  });

  it("lets concurrent readers share one corruption quarantine without surfacing an error", async () => {
    const path = await sessionPath();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await writeFile(path, "{concurrently-invalid", { mode: 0o600 });
    const store = new SessionStore(path);

    await expect(Promise.all(Array.from({ length: 20 }, () => store.load()))).resolves.toEqual(
      Array(20).fill(undefined),
    );

    const quarantineFiles = (await readdir(join(path, ".."))).filter((name) =>
      name.includes(".corrupt-"),
    );
    expect(quarantineFiles).toHaveLength(1);
    const quarantineFile = quarantineFiles[0];
    expect(quarantineFile).toBeDefined();
    await expect(readFile(join(path, "..", quarantineFile ?? "missing"), "utf8")).resolves.toBe(
      "{concurrently-invalid",
    );
  });

  it("does not quarantine a valid save that races a previously read corrupt session", async () => {
    const path = await sessionPath();
    await writeFile(path, "{stale-corrupt-read", { mode: 0o600 });
    let announceRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const corruptReadCompleted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    const corruptReadReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    controlledRead.paths = [canonicalPath];
    controlledRead.pause = async () => {
      announceRead?.();
      await corruptReadReleased;
    };
    const loading = new SessionStore(path).load();
    await corruptReadCompleted;
    const expected = { ...session(), updatedAt: "2026-07-11T02:00:00.000Z" };
    const saving = new SessionStore(join(path, "..", "session.json")).save(expected);
    let saveCompleted = false;
    void saving.then(() => {
      saveCompleted = true;
    });

    await Promise.race([
      saving,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      }),
    ]);
    expect(saveCompleted).toBe(false);
    releaseRead?.();
    await Promise.all([loading, saving]);

    await expect(new SessionStore(path).load()).resolves.toEqual(expected);
  });

  it("serializes stores whose parent directories are real-path and symlink aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "burstpick-session-alias-"));
    temporaryDirectories.push(root);
    const realDirectory = join(root, "real");
    const aliasDirectory = join(root, "alias");
    await mkdir(realDirectory);
    await symlink(realDirectory, aliasDirectory, "dir");
    const realPath = join(realDirectory, "session.json");
    const aliasPath = join(aliasDirectory, "session.json");
    await writeFile(realPath, "{stale-corrupt-read", { mode: 0o600 });
    let announceRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const corruptReadCompleted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    const corruptReadReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const canonicalPath = join(await realpath(realDirectory), "session.json");
    controlledRead.paths = [canonicalPath];
    controlledRead.pause = async () => {
      announceRead?.();
      await corruptReadReleased;
    };
    const loading = new SessionStore(aliasPath).load();
    await corruptReadCompleted;
    const expected = { ...session(), updatedAt: "2026-07-11T03:00:00.000Z" };
    const saving = new SessionStore(realPath).save(expected);
    let saveCompleted = false;
    void saving.then(() => {
      saveCompleted = true;
    });

    await Promise.race([
      saving,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      }),
    ]);
    expect(saveCompleted).toBe(false);
    releaseRead?.();
    await Promise.all([loading, saving]);

    await expect(new SessionStore(realPath).load()).resolves.toEqual(expected);
  });

  it("times out on a live-owner lock without touching the lock or session", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    const lockPath = `${canonicalPath}.lock`;
    const expected = session();
    await new SessionStore(path).save(expected);
    const persistedBeforeLock = await readFile(canonicalPath, "utf8");
    const liveOwner = JSON.stringify({ pid: process.pid, token: "live-owner-token" });
    await writeFile(lockPath, liveOwner, { mode: 0o600 });
    const replacement = { ...expected, updatedAt: "2026-07-11T04:00:00.000Z" };

    await expect(
      new SessionStore(path, { lockRetryMs: 2, lockTimeoutMs: 20 }).save(replacement),
    ).rejects.toMatchObject({ code: "SESSION_LOCK_TIMEOUT" });

    await expect(readFile(lockPath, "utf8")).resolves.toBe(liveOwner);
    await expect(readFile(canonicalPath, "utf8")).resolves.toBe(persistedBeforeLock);
  });

  it("does not reclaim a lock even when its recorded owner is demonstrably dead", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    const lockPath = `${canonicalPath}.lock`;
    const expected = session();
    await new SessionStore(path).save(expected);
    const persistedBeforeLock = await readFile(canonicalPath, "utf8");
    const deadPid = 2_147_483_647;
    expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const deadOwner = JSON.stringify({ pid: deadPid, token: "dead-owner-token" });
    await writeFile(lockPath, deadOwner, { mode: 0o600 });
    const replacement = { ...expected, updatedAt: "2026-07-11T05:00:00.000Z" };

    await expect(
      new SessionStore(path, { lockRetryMs: 2, lockTimeoutMs: 20 }).save(replacement),
    ).rejects.toMatchObject({ code: "SESSION_LOCK_TIMEOUT" });

    await expect(readFile(lockPath, "utf8")).resolves.toBe(deadOwner);
    await expect(readFile(canonicalPath, "utf8")).resolves.toBe(persistedBeforeLock);
  });

  it("keeps a stale lock and session untouched when two owners contend", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    const lockPath = `${canonicalPath}.lock`;
    const expected = session();
    await new SessionStore(path).save(expected);
    const persistedBeforeLock = await readFile(canonicalPath, "utf8");
    const staleOwner = JSON.stringify({ pid: 2_147_483_647, token: "stale-owner-token" });
    await writeFile(lockPath, staleOwner, { mode: 0o600 });
    const first = new SessionLockCoordinator({ lockRetryMs: 2, lockTimeoutMs: 20 });
    const second = new SessionLockCoordinator({ lockRetryMs: 2, lockTimeoutMs: 20 });
    let firstEntered = false;
    let secondEntered = false;

    const results = await Promise.allSettled([
      first.runExclusive(canonicalPath, async () => {
        firstEntered = true;
      }),
      second.runExclusive(canonicalPath, async () => {
        secondEntered = true;
      }),
    ]);

    expect(results).toMatchObject([
      { status: "rejected", reason: { code: "SESSION_LOCK_TIMEOUT" } },
      { status: "rejected", reason: { code: "SESSION_LOCK_TIMEOUT" } },
    ]);
    expect(firstEntered).toBe(false);
    expect(secondEntered).toBe(false);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(staleOwner);
    await expect(readFile(canonicalPath, "utf8")).resolves.toBe(persistedBeforeLock);
  });

  it("serializes independent filesystem lock owners across a stale load and newer save", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    await writeFile(canonicalPath, "{stale-cross-owner-read", { mode: 0o600 });
    const loadOwner = new SessionLockCoordinator({ lockRetryMs: 2, lockTimeoutMs: 500 });
    const saveOwner = new SessionLockCoordinator({ lockRetryMs: 2, lockTimeoutMs: 500 });
    let announceRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const corruptReadCompleted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    const corruptReadReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const loading = loadOwner.runExclusive(canonicalPath, async () => {
      const contents = await readFile(canonicalPath, "utf8");
      announceRead?.();
      await corruptReadReleased;
      if (contents.startsWith("{")) {
        await rename(canonicalPath, `${canonicalPath}.corrupt-load-owner`);
      }
    });
    await corruptReadCompleted;
    const expected = { ...session(), updatedAt: "2026-07-11T06:00:00.000Z" };
    const saving = saveOwner.runExclusive(canonicalPath, async () => {
      const temporaryPath = `${canonicalPath}.tmp-save-owner`;
      await writeFile(temporaryPath, JSON.stringify(expected), { mode: 0o600 });
      await rename(temporaryPath, canonicalPath);
    });
    let saveCompleted = false;
    void saving.then(() => {
      saveCompleted = true;
    });

    await Promise.race([
      saving,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      }),
    ]);
    expect(saveCompleted).toBe(false);
    releaseRead?.();
    await Promise.all([loading, saving]);

    await expect(readFile(canonicalPath, "utf8").then(JSON.parse)).resolves.toEqual(expected);
    await expect(readFile(`${canonicalPath}.corrupt-load-owner`, "utf8")).resolves.toBe(
      "{stale-cross-owner-read",
    );
  });

  it("does not remove a lock whose ownership token changed before release", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    const lockPath = `${canonicalPath}.lock`;
    const replacementOwner = JSON.stringify({ pid: process.pid, token: "replacement-token" });
    const coordinator = new SessionLockCoordinator();

    await coordinator.runExclusive(canonicalPath, async () => {
      await writeFile(lockPath, replacementOwner, { mode: 0o600 });
    });

    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacementOwner);
  });

  it("does not remove a same-token lock whose inode changed before release", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    const lockPath = `${canonicalPath}.lock`;
    const displacedLockPath = `${lockPath}.displaced`;
    const coordinator = new SessionLockCoordinator();
    let replacementOwner = "";

    await coordinator.runExclusive(canonicalPath, async () => {
      replacementOwner = await readFile(lockPath, "utf8");
      await rename(lockPath, displacedLockPath);
      await writeFile(lockPath, replacementOwner, { mode: 0o600 });
    });

    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacementOwner);
    await expect(readFile(displacedLockPath, "utf8")).resolves.toBe(replacementOwner);
  });

  it("publishes a committed service snapshot when only lock release fails", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    controlledUnlink.paths = [`${canonicalPath}.lock`];
    const warnings: Array<{ code: string; message: string }> = [];
    const store = new SessionStore(path, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    const service = new SessionService(session(), store, {
      now: () => new Date("2026-07-11T07:00:00.000Z"),
    });

    await service.ratePhoto("p1", 4);

    expect(service.snapshot().photos[0]?.rating).toBe(4);
    const persisted = JSON.parse(await readFile(canonicalPath, "utf8")) as AlbumSession;
    expect(persisted.photos[0]?.rating).toBe(4);
    expect(warnings).toEqual([
      {
        code: "SESSION_LOCK_RELEASE_FAILED",
        message: "Session lock cleanup failed; manual recovery may be required",
      },
    ]);
  });

  it("preserves the operation error when lock release also fails", async () => {
    const path = await sessionPath();
    const canonicalPath = join(await realpath(join(path, "..")), "session.json");
    controlledUnlink.paths = [`${canonicalPath}.lock`];
    const warnings: Array<{ code: string; message: string }> = [];
    const coordinator = new SessionLockCoordinator({
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    const operationError = new Error("operation failed");

    await expect(
      coordinator.runExclusive(canonicalPath, async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(warnings).toEqual([
      {
        code: "SESSION_LOCK_RELEASE_FAILED",
        message: "Session lock cleanup failed; manual recovery may be required",
      },
    ]);
  });

  it("preserves exact case-sensitive basenames as distinct I/O targets", async () => {
    const lowercasePath = await sessionPath();
    const uppercasePath = join(lowercasePath, "..", "Session.json");
    controlledRename.sessionDestinations = [];
    const uppercaseSession = { ...session(), sourcePathHash: "uppercase-source" };
    const lowercaseSession = { ...session(), sourcePathHash: "lowercase-source" };

    await new SessionStore(uppercasePath).save(uppercaseSession);
    await new SessionStore(lowercasePath).save(lowercaseSession);

    expect(controlledRename.sessionDestinations.map((path) => basename(path))).toEqual([
      "Session.json",
      "session.json",
    ]);
  });

  it("quarantines parseable JSON that violates the session schema", async () => {
    const path = await sessionPath();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_001);
    await writeFile(path, JSON.stringify({ ...session(), schemaVersion: 2 }), { mode: 0o600 });

    await expect(new SessionStore(path).load()).resolves.toBeUndefined();

    const quarantineFile = (await readdir(join(path, ".."))).find((name) =>
      name.startsWith("session.json.corrupt-1700000000001-"),
    );
    expect(quarantineFile).toBeDefined();
    await expect(
      readFile(join(path, "..", quarantineFile ?? "missing"), "utf8"),
    ).resolves.toContain('"schemaVersion":2');
  });
});
