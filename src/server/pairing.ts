import { createHash } from "node:crypto";
import type { PhotoUnit, ScanWarning, SourceFile } from "../shared/domain.js";

const RAW_EXTENSION_PREFERENCE = ["arw", "cr3", "cr2", "nef", "raf", "rw2", "orf", "dng"] as const;
const JPEG_EXTENSION_PREFERENCE = ["jpg", "jpeg"] as const;
const XMP_EXTENSIONS = new Set(["xmp"]);

const RAW_EXTENSION_RANK = new Map<string, number>(
  RAW_EXTENSION_PREFERENCE.map((extension, index) => [extension, index]),
);
const JPEG_EXTENSION_RANK = new Map<string, number>(
  JPEG_EXTENSION_PREFERENCE.map((extension, index) => [extension, index]),
);

type SourceFileOfKind<Kind extends SourceFile["kind"]> = Extract<SourceFile, { kind: Kind }>;

interface ParsedRelativePath {
  directory: string;
  extension: string;
  stem: string;
}

interface CandidateGroup {
  normalizedDirectory: string;
  normalizedStem: string;
  raw: SourceFileOfKind<"raw">[];
  jpeg: SourceFileOfKind<"jpeg">[];
  xmp: SourceFileOfKind<"xmp">[];
}

function fold(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNumbers(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseRelativePath(relativePath: string): ParsedRelativePath {
  const portablePath = relativePath.replaceAll("\\", "/");
  const separatorIndex = portablePath.lastIndexOf("/");
  const directory = separatorIndex < 0 ? "" : portablePath.slice(0, separatorIndex);
  const fileName = separatorIndex < 0 ? portablePath : portablePath.slice(separatorIndex + 1);
  const extensionIndex = fileName.lastIndexOf(".");

  if (extensionIndex <= 0) {
    return { directory, extension: "", stem: fileName };
  }

  return {
    directory,
    extension: fold(fileName.slice(extensionIndex + 1)),
    stem: fileName.slice(0, extensionIndex),
  };
}

export function classifySourceFile(path: string): SourceFile["kind"] | undefined {
  const { extension } = parseRelativePath(path);

  if (RAW_EXTENSION_RANK.has(extension)) return "raw";
  if (JPEG_EXTENSION_RANK.has(extension)) return "jpeg";
  if (XMP_EXTENSIONS.has(extension)) return "xmp";
  return undefined;
}

function candidateRank(file: SourceFile): number {
  const { extension } = parseRelativePath(file.relativePath);
  if (file.kind === "raw") return RAW_EXTENSION_RANK.get(extension) ?? Number.MAX_SAFE_INTEGER;
  if (file.kind === "jpeg") return JPEG_EXTENSION_RANK.get(extension) ?? Number.MAX_SAFE_INTEGER;
  return 0;
}

function compareCandidates(left: SourceFile, right: SourceFile): number {
  const rankDifference = candidateRank(left) - candidateRank(right);
  if (rankDifference !== 0) return rankDifference;

  const foldedPathDifference = compareStrings(fold(left.relativePath), fold(right.relativePath));
  if (foldedPathDifference !== 0) return foldedPathDifference;

  const relativePathDifference = compareStrings(left.relativePath, right.relativePath);
  if (relativePathDifference !== 0) return relativePathDifference;

  const foldedSourcePathDifference = compareStrings(fold(left.path), fold(right.path));
  if (foldedSourcePathDifference !== 0) return foldedSourcePathDifference;

  const sourcePathDifference = compareStrings(left.path, right.path);
  if (sourcePathDifference !== 0) return sourcePathDifference;

  const sizeDifference = compareNumbers(left.size, right.size);
  if (sizeDifference !== 0) return sizeDifference;
  return compareNumbers(left.modifiedAtMs, right.modifiedAtMs);
}

function stablePhotoId(normalizedDirectory: string, normalizedStem: string): string {
  return createHash("sha256")
    .update(normalizedDirectory)
    .update("\0")
    .update(normalizedStem)
    .digest("hex");
}

function duplicateWarning(
  kind: SourceFile["kind"],
  photoId: string,
  candidates: SourceFile[],
): ScanWarning | undefined {
  if (candidates.length < 2) return undefined;

  const codeByKind = {
    raw: "DUPLICATE_RAW",
    jpeg: "DUPLICATE_JPEG",
    xmp: "DUPLICATE_XMP",
  } as const;

  return {
    code: codeByKind[kind],
    photoId,
    relativePaths: candidates.map((candidate) => candidate.relativePath),
  };
}

export function pairSourceFiles(
  _root: string,
  files: readonly SourceFile[],
): { photos: PhotoUnit[]; warnings: ScanWarning[] } {
  const groups = new Map<string, CandidateGroup>();

  for (const file of files) {
    const { directory, stem } = parseRelativePath(file.relativePath);
    const normalizedDirectory = fold(directory);
    const normalizedStem = fold(stem);
    const key = `${normalizedDirectory}\0${normalizedStem}`;
    const group = groups.get(key) ?? {
      normalizedDirectory,
      normalizedStem,
      raw: [],
      jpeg: [],
      xmp: [],
    };

    if (file.kind === "raw") {
      group.raw.push(file);
    } else if (file.kind === "jpeg") {
      group.jpeg.push(file);
    } else {
      group.xmp.push(file);
    }
    groups.set(key, group);
  }

  const photos: PhotoUnit[] = [];
  const warnings: ScanWarning[] = [];
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => compareStrings(left, right));

  for (const [, group] of orderedGroups) {
    group.raw.sort(compareCandidates);
    group.jpeg.sort(compareCandidates);
    group.xmp.sort(compareCandidates);

    const raw = group.raw[0];
    const jpeg = group.jpeg[0];
    const xmp = group.xmp[0];
    const primary = raw ?? jpeg;
    if (primary === undefined) continue;

    const id = stablePhotoId(group.normalizedDirectory, group.normalizedStem);
    const photoBase = {
      id,
      stem: parseRelativePath(primary.relativePath).stem,
      ...(xmp === undefined ? {} : { xmp }),
      capturedAtMs: primary.modifiedAtMs,
      captureTimeSource: "file-mtime",
      rating: 0,
    } as const;
    let photo: PhotoUnit;
    if (raw !== undefined) {
      photo = { ...photoBase, raw, ...(jpeg === undefined ? {} : { jpeg }) };
    } else if (jpeg !== undefined) {
      photo = { ...photoBase, jpeg };
    } else {
      continue;
    }

    photos.push(photo);

    for (const [kind, candidates] of [
      ["raw", group.raw],
      ["jpeg", group.jpeg],
      ["xmp", group.xmp],
    ] as const) {
      const warning = duplicateWarning(kind, id, candidates);
      if (warning !== undefined) warnings.push(warning);
    }

    if (raw !== undefined && jpeg === undefined) {
      warnings.push({ code: "UNPAIRED_RAW", photoId: id, relativePaths: [raw.relativePath] });
    } else if (jpeg !== undefined && raw === undefined) {
      warnings.push({ code: "UNPAIRED_JPEG", photoId: id, relativePaths: [jpeg.relativePath] });
    }
  }

  return { photos, warnings };
}
