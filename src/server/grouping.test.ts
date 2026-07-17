import { describe, expect, it } from "vitest";
import type { PhotoUnit } from "../shared/domain.js";
import {
  applyBoundaryOverrides,
  computeAdaptiveThreshold,
  groupBursts,
  mergeGroupWithNext,
  splitGroup,
} from "./grouping.js";

interface PhotoOptions {
  burstId?: string;
  cameraId?: string;
  perceptualHash?: string;
  sequenceNumber?: number;
}

function photo(id: string, capturedAtMs: number, options: PhotoOptions = {}): PhotoUnit {
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
    ...(options.cameraId === undefined ? {} : { cameraId: options.cameraId }),
    ...(options.burstId === undefined ? {} : { burstId: options.burstId }),
    ...(options.sequenceNumber === undefined ? {} : { sequenceNumber: options.sequenceNumber }),
    ...(options.perceptualHash === undefined ? {} : { perceptualHash: options.perceptualHash }),
    rating: 0,
  };
}

describe("computeAdaptiveThreshold", () => {
  it("uses the median and median absolute deviation of positive gaps up to five seconds", () => {
    const gaps = [6_000, 1_100, 0, 900, -1, 1_000];
    const original = [...gaps];

    expect(computeAdaptiveThreshold(gaps)).toBe(1_300);
    expect(gaps).toEqual(original);
  });

  it("clamps sparse thresholds to the specified bounds", () => {
    expect(computeAdaptiveThreshold([])).toBe(650);
    expect(computeAdaptiveThreshold([100])).toBe(650);
    expect(computeAdaptiveThreshold([5_000])).toBe(3_500);
  });
});

describe("groupBursts", () => {
  it("groups interleaved known cameras in independent time streams", () => {
    const input = [
      photo("a1", 0, { cameraId: "A" }),
      photo("b1", 100, { cameraId: "B" }),
      photo("a2", 200, { cameraId: "A" }),
    ];

    const groups = groupBursts(input, { thresholdMs: 1_000, sensitivity: 1 });

    expect(groups.map((group) => group.photoIds)).toEqual([["a1", "a2"], ["b1"]]);
    expect(input.map((item) => item.id)).toEqual(["a1", "b1", "a2"]);
    expect(groups[0]?.confidence).toBe(1);
  });

  it("keeps unknown-camera photos in their own independent stream", () => {
    const groups = groupBursts([
      photo("a1", 0, { cameraId: "A" }),
      photo("u1", 50),
      photo("a2", 100, { cameraId: "A" }),
      photo("u2", 150),
    ], { thresholdMs: 1_000, sensitivity: 1 });

    expect(groups.map((group) => group.photoIds)).toEqual([["a1", "a2"], ["u1", "u2"]]);
  });
  it("uses similarity only inside the ambiguous time band", () => {
    const photos = [
      photo("a", 0, { perceptualHash: "0".repeat(16) }),
      photo("b", 1_200, { perceptualHash: "0".repeat(15) + "f" }),
      photo("c", 2_400, { perceptualHash: "f".repeat(16) }),
    ];

    const groups = groupBursts(photos, { thresholdMs: 1_000, sensitivity: 1 });

    expect(groups.map((group) => group.photoIds)).toEqual([["a", "b"], ["c"]]);
  });

  it("does not let similarity override decisive time boundaries", () => {
    const hash = "0".repeat(16);
    const groups = groupBursts(
      [photo("a", 0, { perceptualHash: hash }), photo("b", 1_601, { perceptualHash: hash })],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.photoIds)).toEqual([["a"], ["b"]]);
  });

  it("keeps very close photos together without perceptual hashes", () => {
    const groups = groupBursts([photo("a", 0), photo("b", 650)], {
      thresholdMs: 1_000,
      sensitivity: 1,
    });

    expect(groups.map((group) => group.photoIds)).toEqual([["a", "b"]]);
  });

  it("keeps a shared burst id together up to twice the threshold", () => {
    const groups = groupBursts(
      [photo("a", 0, { burstId: "burst-7" }), photo("b", 2_000, { burstId: "burst-7" })],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups).toHaveLength(1);
  });

  it("does not let a shared burst id bridge more than twice the threshold", () => {
    const groups = groupBursts(
      [photo("a", 0, { burstId: "burst-7" }), photo("b", 2_001, { burstId: "burst-7" })],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.photoIds)).toEqual([["a"], ["b"]]);
  });

  it("does not treat empty burst ids as shared metadata", () => {
    const groups = groupBursts(
      [photo("a", 0, { burstId: "" }), photo("b", 1_900, { burstId: "" })],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.photoIds)).toEqual([["a"], ["b"]]);
  });

  it("keeps consecutive sequence numbers together up to twice the threshold", () => {
    const groups = groupBursts(
      [photo("a", 0, { sequenceNumber: 7 }), photo("b", 2_000, { sequenceNumber: 8 })],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.photoIds)).toEqual([["a", "b"]]);
  });

  it("splits known different cameras before applying other keep rules", () => {
    const groups = groupBursts(
      [
        photo("a", 0, { burstId: "shared", cameraId: "camera-a" }),
        photo("b", 1, { burstId: "shared", cameraId: "camera-b" }),
      ],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.photoIds)).toEqual([["a"], ["b"]]);
  });

  it("keeps known and unknown camera streams separate", () => {
    const groups = groupBursts(
      [photo("a", 0, { cameraId: "camera-a" }), photo("b", 1)],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.photoIds)).toEqual([["a"], ["b"]]);
  });

  it("treats an empty camera id as unknown", () => {
    const groups = groupBursts(
      [photo("a", 0, { cameraId: "" }), photo("b", 1, { cameraId: "camera-b" })],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.photoIds)).toEqual([["a"], ["b"]]);
  });

  it("sorts by capture time then stable id without mutating the input", () => {
    const photos = [photo("c", 1_000), photo("a", 1_000), photo("b", 1_000)];
    const originalOrder = photos.map((item) => item.id);

    const first = groupBursts(photos, { thresholdMs: 1_000, sensitivity: 1 });
    const second = groupBursts([...photos].reverse(), { thresholdMs: 1_000, sensitivity: 1 });

    expect(first).toHaveLength(1);
    expect(first[0]?.photoIds).toEqual(["a", "b", "c"]);
    expect(first[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(first[0]?.id).toBe(second[0]?.id);
    expect(photos.map((item) => item.id)).toEqual(originalOrder);
  });

  it("applies sensitivity to the base threshold", () => {
    const photos = [photo("a", 0), photo("b", 1_200)];

    expect(
      groupBursts(photos, { thresholdMs: 1_000, sensitivity: 2 }).map((group) => group.photoIds),
    ).toEqual([["a", "b"]]);
    expect(
      groupBursts(photos, { thresholdMs: 1_000, sensitivity: 0.5 }).map((group) => group.photoIds),
    ).toEqual([["a"], ["b"]]);
  });

  it("uses an adaptive base threshold when one is not supplied", () => {
    const groups = groupBursts([photo("a", 0), photo("b", 650)], { sensitivity: 1 });

    expect(groups.map((group) => group.photoIds)).toEqual([["a"], ["b"]]);
  });

  it("averages kept-boundary confidence and gives singletons full confidence", () => {
    const groups = groupBursts(
      [
        photo("a", 0, { perceptualHash: "0".repeat(16) }),
        photo("b", 1_200, { perceptualHash: "0".repeat(15) + "f" }),
        photo("c", 2_400, { perceptualHash: "0".repeat(12) + "ffff" }),
        photo("d", 4_001),
      ],
      { thresholdMs: 1_000, sensitivity: 1 },
    );

    expect(groups.map((group) => group.confidence)).toEqual([0.875, 1]);
    for (const group of groups) {
      expect(group.confidence).toBeGreaterThanOrEqual(0);
      expect(group.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("manual group boundaries", () => {
  function automaticPhotos() {
    return [
        photo("a", 0),
        photo("b", 100),
        photo("c", 200),
        photo("d", 2_000),
        photo("e", 4_000),
      ];
  }

  function automaticGroups() {
    return groupBursts(automaticPhotos(), { thresholdMs: 1_000, sensitivity: 1 });
  }

  it("treats splitting before the first photo as a no-op", () => {
    const groups = automaticGroups();

    expect(splitGroup(groups, "a")).toBe(groups);
    expect(groups.map((group) => group.manual)).toEqual([false, false, false]);
  });

  it("splits before a middle photo while preserving order and stable member-derived ids", () => {
    const groups = automaticGroups();
    const original = structuredClone(groups);
    const split = splitGroup(groups, "b");
    const singletonA = groupBursts([photo("a", 0)], { thresholdMs: 1_000, sensitivity: 1 });
    const pairBC = groupBursts([photo("b", 100), photo("c", 200)], {
      thresholdMs: 1_000,
      sensitivity: 1,
    });

    expect(split.map((group) => group.photoIds)).toEqual([
      ["a"],
      ["b", "c"],
      ["d"],
      ["e"],
    ]);
    expect(split.map((group) => group.manual)).toEqual([true, true, false, false]);
    expect(split[0]?.id).toBe(singletonA[0]?.id);
    expect(split[1]?.id).toBe(pairBC[0]?.id);
    expect(split[2]).toBe(groups[1]);
    expect(split[3]).toBe(groups[2]);
    expect(groups).toEqual(original);
  });

  it("treats merging the final group as a no-op", () => {
    const groups = automaticGroups();
    const finalGroup = groups.at(-1);

    expect(finalGroup).toBeDefined();
    expect(mergeGroupWithNext(groups, finalGroup?.id ?? "missing", automaticPhotos())).toBe(groups);
    expect(groups.map((group) => group.manual)).toEqual([false, false, false]);
  });

  it("merges with the next group in order and hashes the combined member ids", () => {
    const groups = automaticGroups();
    const firstGroup = groups[0];
    const secondGroup = groups[1];

    expect(firstGroup).toBeDefined();
    expect(secondGroup).toBeDefined();
    const merged = mergeGroupWithNext(groups, firstGroup?.id ?? "missing", automaticPhotos());
    const expectedId = groupBursts(
      [photo("a", 0), photo("b", 100), photo("c", 200), photo("d", 300)],
      { thresholdMs: 1_000, sensitivity: 1 },
    )[0]?.id;

    expect(merged.map((group) => group.photoIds)).toEqual([
      ["a", "b", "c", "d"],
      ["e"],
    ]);
    expect(merged[0]).toMatchObject({
      id: expectedId,
      startedAtMs: firstGroup?.startedAtMs,
      endedAtMs: secondGroup?.endedAtMs,
      manual: true,
    });
    expect(merged[1]).toBe(groups[2]);
    expect(merged.map((group) => group.manual)).toEqual([true, false]);
    expect(groups.map((group) => group.manual)).toEqual([false, false, false]);
  });

  it("chronologically merges overlapping camera streams with exact bounds", () => {
    const photos = [
      photo("a0", 0, { cameraId: "A" }),
      photo("b250", 250, { cameraId: "B" }),
      photo("a500", 500, { cameraId: "A" }),
    ];
    const groups = groupBursts(photos, { thresholdMs: 1_000, sensitivity: 1 });

    const merged = mergeGroupWithNext(groups, groups[0]!.id, photos);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      photoIds: ["a0", "b250", "a500"],
      startedAtMs: 0,
      endedAtMs: 500,
      manual: true,
    });
  });

  it("re-applies only stable adjacent split and join boundaries", () => {
    const photos = [photo("a", 0), photo("b", 100), photo("c", 200), photo("d", 2_000)];
    const automatic = groupBursts(
      photos,
      { thresholdMs: 1_000, sensitivity: 1 },
    );
    const applied = applyBoundaryOverrides(automatic, [
      { action: "split", leftPhotoId: "a", rightPhotoId: "b" },
      { action: "join", leftPhotoId: "c", rightPhotoId: "d" },
      { action: "split", leftPhotoId: "missing", rightPhotoId: "d" },
    ], photos);

    expect(applied.groups.map((group) => group.photoIds)).toEqual([["a"], ["b", "c", "d"]]);
    expect(applied.overrides).toHaveLength(2);
    expect(applied.groups.every((group) => group.manual)).toBe(true);
  });

  it("retains a satisfied join when its durable member IDs are nonadjacent in one group", () => {
    const photos = [photo("a", 0), photo("inserted", 100), photo("b", 200)];
    const automatic = groupBursts(photos, { thresholdMs: 1_000, sensitivity: 1 });
    const override = { action: "join" as const, leftPhotoId: "a", rightPhotoId: "b" };

    const applied = applyBoundaryOverrides(automatic, [override], photos);

    expect(applied.groups.map((group) => group.photoIds)).toEqual([["a", "inserted", "b"]]);
    expect(applied.overrides).toEqual([override]);
  });

  it("discards a join when its member groups are no longer safely adjacent", () => {
    const photos = [photo("a", 0), photo("middle", 2_000), photo("b", 4_000)];
    const automatic = groupBursts(photos, { thresholdMs: 1_000, sensitivity: 1 });
    const applied = applyBoundaryOverrides(automatic, [
      { action: "join", leftPhotoId: "a", rightPhotoId: "b" },
    ], photos);

    expect(applied.groups).toEqual(automatic);
    expect(applied.overrides).toEqual([]);
  });
});
