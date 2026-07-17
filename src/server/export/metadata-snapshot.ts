import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FileSnapshot {
  readonly exists: boolean;
  readonly hash?: string;
  readonly mode?: number;
  readonly modifiedAtMs?: number;
  readonly path: string;
  readonly size?: number;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await canonicalPath(parent), basename(absolute));
  }
}

export function isSameOrInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

export async function assertWritableParent(path: string): Promise<void> {
  await access(dirname(path), constants.W_OK);
}

export async function snapshotFile(path: string): Promise<FileSnapshot> {
  const lexical = resolve(path);
  try {
    const details = await lstat(lexical);
    if (details.isSymbolicLink()) throw new MetadataSnapshotError("UNSAFE_METADATA_PATH");
    if (!details.isFile()) throw new Error("Metadata target is not a regular file");
    const contents = await readFile(lexical);
    return {
      exists: true,
      hash: createHash("sha256").update(contents).digest("hex"),
      mode: details.mode & 0o777,
      modifiedAtMs: details.mtimeMs,
      path: lexical,
      size: details.size,
    };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return { exists: false, path: lexical };
  }
}

export async function assertLexicalRegularFile(path: string, allowMissing: boolean): Promise<void> {
  try {
    const details = await lstat(resolve(path));
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new MetadataSnapshotError("UNSAFE_METADATA_PATH");
    }
  } catch (error) {
    if (allowMissing && errorCode(error) === "ENOENT") return;
    throw error;
  }
}

export function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.path === right.path &&
    left.exists === right.exists &&
    (!left.exists || (
      left.size === right.size &&
      left.modifiedAtMs === right.modifiedAtMs &&
      left.hash === right.hash
    ));
}

export async function assertSnapshot(expected: FileSnapshot): Promise<void> {
  const current = await snapshotFile(expected.path);
  if (!sameSnapshot(expected, current)) {
    throw new MetadataSnapshotError("SOURCE_CHANGED");
  }
}

export class MetadataSnapshotError extends Error {
  readonly code: "SOURCE_CHANGED" | "UNSAFE_METADATA_PATH";

  constructor(code: "SOURCE_CHANGED" | "UNSAFE_METADATA_PATH") {
    super(code === "SOURCE_CHANGED" ? "Metadata source changed after preview" : "Metadata target is outside the source root");
    this.name = "MetadataSnapshotError";
    this.code = code;
  }
}

export async function assertContained(root: string, path: string): Promise<{ root: string; path: string }> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([canonicalPath(root), canonicalPath(path)]);
  if (!isSameOrInside(canonicalRoot, canonicalCandidate)) {
    throw new MetadataSnapshotError("UNSAFE_METADATA_PATH");
  }
  return { root: canonicalRoot, path: canonicalCandidate };
}
