import { describe, expect, it } from "vitest";
import { PhotoUnitSchema } from "../shared/domain.js";
import type { PhotoUnit, SourceFile } from "../shared/domain.js";
import { classifySourceFile, pairSourceFiles } from "./pairing.js";

function permutations<Item>(items: readonly Item[]): Item[][] {
  if (items.length === 0) return [[]];

  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

// @ts-expect-error PhotoUnit requires at least one image source.
const photoWithoutImage: PhotoUnit = {
  id: "invalid",
  stem: "invalid",
  capturedAtMs: 1,
  captureTimeSource: "file-mtime",
  rating: 0,
};
void photoWithoutImage;

describe("PhotoUnitSchema", () => {
  const basePhoto = {
    id: "invalid",
    stem: "invalid",
    capturedAtMs: 1,
    captureTimeSource: "file-mtime",
    rating: 0,
  } as const;

  it.each([
    ["empty", {}],
    [
      "XMP-only",
      {
        xmp: {
          path: "/shoot/a/invalid.xmp",
          relativePath: "a/invalid.xmp",
          kind: "xmp",
          size: 1,
          modifiedAtMs: 1,
        },
      },
    ],
  ] as const)("rejects an %s photo unit", (_description, sources) => {
    expect(PhotoUnitSchema.safeParse({ ...basePhoto, ...sources }).success).toBe(false);
  });
});

describe("classifySourceFile", () => {
  it.each([
    ["photo.ARW", "raw"],
    ["photo.cr3", "raw"],
    ["photo.Cr2", "raw"],
    ["photo.nef", "raw"],
    ["photo.RAF", "raw"],
    ["photo.rw2", "raw"],
    ["photo.ORF", "raw"],
    ["photo.dng", "raw"],
    ["photo.JPG", "jpeg"],
    ["photo.jpeg", "jpeg"],
    ["photo.XMP", "xmp"],
  ] as const)("classifies %s as %s", (path, expected) => {
    expect(classifySourceFile(path)).toBe(expected);
  });

  it("returns undefined for unsupported files", () => {
    expect(classifySourceFile("photo.png")).toBeUndefined();
  });
});

describe("pairSourceFiles", () => {
  it("combines a same-directory RAW and JPEG into one stable photo", () => {
    const result = pairSourceFiles("/shoot", [
      { path: "/shoot/a/DSC_1.ARW", relativePath: "a/DSC_1.ARW", kind: "raw", size: 10, modifiedAtMs: 1 },
      { path: "/shoot/a/dsc_1.jpg", relativePath: "a/dsc_1.jpg", kind: "jpeg", size: 4, modifiedAtMs: 1 },
    ]);
    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]).toMatchObject({ stem: "DSC_1", rating: 0 });
    expect(result.photos[0]?.raw?.relativePath).toBe("a/DSC_1.ARW");
    expect(result.photos[0]?.jpeg?.relativePath).toBe("a/dsc_1.jpg");
  });

  it("does not pair identical stems from different directories", () => {
    const result = pairSourceFiles("/shoot", [
      { path: "/shoot/a/x.nef", relativePath: "a/x.nef", kind: "raw", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/b/x.jpg", relativePath: "b/x.jpg", kind: "jpeg", size: 1, modifiedAtMs: 1 },
    ]);
    expect(result.photos).toHaveLength(2);
    expect(result.warnings.map((item) => item.code)).toEqual(["UNPAIRED_RAW", "UNPAIRED_JPEG"]);
  });

  it("normalizes directory and stem keys while preserving the preferred RAW display stem", () => {
    const decomposedStem = "Cafe\u0301";
    const result = pairSourceFiles("/shoot", [
      { path: `/shoot/A/${decomposedStem}.CR3`, relativePath: `A/${decomposedStem}.CR3`, kind: "raw", size: 10, modifiedAtMs: 1 },
      { path: "/shoot/a/CAFÉ.jpg", relativePath: "a/CAFÉ.jpg", kind: "jpeg", size: 4, modifiedAtMs: 1 },
      { path: "/shoot/a/café.XMP", relativePath: "a/café.XMP", kind: "xmp", size: 2, modifiedAtMs: 1 },
    ]);

    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]?.stem).toBe(decomposedStem);
    expect(result.photos[0]?.xmp?.relativePath).toBe("a/café.XMP");
  });

  it("selects duplicate candidates by extension preference and reports every duplicate kind", () => {
    const result = pairSourceFiles("/shoot", [
      { path: "/shoot/a/X.jpeg", relativePath: "a/X.jpeg", kind: "jpeg", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/a/x.CR2", relativePath: "a/x.CR2", kind: "raw", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/a/x.JPG", relativePath: "a/x.JPG", kind: "jpeg", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/a/x.ARW", relativePath: "a/x.ARW", kind: "raw", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/a/X.xmp", relativePath: "a/X.xmp", kind: "xmp", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/a/x.XMP", relativePath: "a/x.XMP", kind: "xmp", size: 1, modifiedAtMs: 1 },
    ]);

    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]).toMatchObject({ stem: "x" });
    expect(result.photos[0]?.raw?.relativePath).toBe("a/x.ARW");
    expect(result.photos[0]?.jpeg?.relativePath).toBe("a/x.JPG");
    expect(result.warnings.map((item) => item.code)).toEqual([
      "DUPLICATE_RAW",
      "DUPLICATE_JPEG",
      "DUPLICATE_XMP",
    ]);
  });

  it("selects exact-relative-path duplicates independently of scan order", () => {
    const preferred = {
      path: "/shoot/a/x.ARW",
      relativePath: "a/x.ARW",
      kind: "raw",
      size: 10,
      modifiedAtMs: 1,
    } as const;
    const candidates = [
      { path: "/shoot/z/x.ARW", relativePath: "a/x.ARW", kind: "raw", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/a/x.ARW", relativePath: "a/x.ARW", kind: "raw", size: 20, modifiedAtMs: 1 },
      { path: "/shoot/a/x.ARW", relativePath: "a/x.ARW", kind: "raw", size: 10, modifiedAtMs: 3 },
      preferred,
    ] as const satisfies readonly SourceFile[];

    for (const permutation of permutations(candidates)) {
      const result = pairSourceFiles("/shoot", permutation);
      expect(result.photos[0]?.raw).toEqual(preferred);
    }
  });

  it("uses stable SHA-256 IDs from normalized relative directory and stem", () => {
    const first = pairSourceFiles("/shoot-one", [
      { path: "/shoot-one/A/Cafe\u0301.ARW", relativePath: "A/Cafe\u0301.ARW", kind: "raw", size: 1, modifiedAtMs: 1 },
    ]);
    const second = pairSourceFiles("/shoot-two", [
      { path: "/shoot-two/a/CAFÉ.arw", relativePath: "a/CAFÉ.arw", kind: "raw", size: 2, modifiedAtMs: 2 },
    ]);

    expect(first.photos[0]?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.photos[0]?.id).toBe(second.photos[0]?.id);
  });
});
