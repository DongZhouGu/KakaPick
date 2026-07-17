import { describe, expect, it } from "vitest";
import {
  AlbumSessionSchema,
  SessionCommandSchema,
  type AlbumSession,
  type PhotoUnit,
  type Rating,
} from "../shared/domain.js";
import { groupBursts } from "./grouping.js";
import {
  SessionDomainError,
  SessionService,
  type SessionPersistence,
} from "./session-service.js";

const COMMAND_TIME = "2026-07-11T01:02:03.004Z";

function photo(id: string, capturedAtMs: number, rating: Rating = 0): PhotoUnit {
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
    rating,
  };
}

function sessionWith(photos: PhotoUnit[]): AlbumSession {
  return {
    schemaVersion: 1,
    sourcePathHash: "source-hash",
    inventoryFingerprint: "inventory-fingerprint",
    boundaryOverrides: [],
    photos,
    groups: groupBursts(photos, { thresholdMs: 1_000, sensitivity: 1 }).sort(
      (left, right) =>
        left.startedAtMs - right.startedAtMs ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    ),
    groupingSensitivity: 1,
    history: [], rejectedIds: [],
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

class RecordingStore implements SessionPersistence {
  readonly saves: AlbumSession[] = [];
  failure: Error | undefined;

  async save(session: AlbumSession): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.saves.push(structuredClone(session));
  }
}

function createService(
  session: AlbumSession,
  store = new RecordingStore(),
): { service: SessionService; store: RecordingStore } {
  return {
    service: new SessionService(session, store, { now: () => new Date(COMMAND_TIME) }),
    store,
  };
}

describe("rating commands", () => {
  it("persists a rating command and undo restores the prior value", async () => {
    const { service, store } = createService(sessionWith([photo("p1", 0)]));

    await service.ratePhoto("p1", 4);

    expect(service.snapshot().photos[0]?.rating).toBe(4);
    expect(service.snapshot().updatedAt).toBe(COMMAND_TIME);
    expect(service.snapshot().history).toEqual([
      { type: "rate", payload: { ratings: [{ photoId: "p1", rating: 0 }] } },
    ]);
    expect(store.saves).toHaveLength(1);

    await service.undo();

    expect(service.snapshot().photos[0]?.rating).toBe(0);
    expect(service.snapshot().history).toHaveLength(0);
    expect(store.saves).toHaveLength(2);
  });

  it("treats rating a photo to its current value as a complete no-op", async () => {
    const initial = sessionWith([photo("p1", 0, 3)]);
    const { service, store } = createService(initial);
    const before = service.snapshot();

    await service.ratePhoto("p1", 3);

    expect(service.snapshot()).toBe(before);
    expect(service.snapshot().updatedAt).toBe(initial.updatedAt);
    expect(service.snapshot().history).toEqual([]);
    expect(store.saves).toEqual([]);
  });

  it("rates multiple changed photos as one undoable command", async () => {
    const { service } = createService(
      sessionWith([photo("p1", 0, 1), photo("p2", 100, 2), photo("p3", 200, 4)]),
    );

    await service.ratePhotos(["p1", "p2", "p2", "p3"], 4);

    expect(service.snapshot().photos.map((item) => item.rating)).toEqual([4, 4, 4]);
    expect(service.snapshot().history).toEqual([
      {
        type: "rate",
        payload: {
          ratings: [
            { photoId: "p1", rating: 1 },
            { photoId: "p2", rating: 2 },
          ],
        },
      },
    ]);

    await service.undo();

    expect(service.snapshot().photos.map((item) => item.rating)).toEqual([1, 2, 4]);
  });

  it("rejects an unknown photo with a stable domain error and no partial change", async () => {
    const { service, store } = createService(sessionWith([photo("p1", 0)]));
    const before = service.snapshot();

    await expect(service.ratePhotos(["p1", "missing"], 5)).rejects.toEqual(
      new SessionDomainError("PHOTO_NOT_FOUND"),
    );

    expect(service.snapshot()).toBe(before);
    expect(store.saves).toEqual([]);
  });

  it("caps inverse command history at the newest one hundred entries", async () => {
    const { service } = createService(sessionWith([photo("p1", 0)]));

    for (let index = 0; index < 101; index += 1) {
      await service.ratePhoto("p1", ((index % 5) + 1) as Rating);
    }

    const history = service.snapshot().history;
    expect(history).toHaveLength(100);
    expect(history[0]).toEqual({
      type: "rate",
      payload: { ratings: [{ photoId: "p1", rating: 1 }] },
    });
    expect(history.at(-1)).toEqual({
      type: "rate",
      payload: { ratings: [{ photoId: "p1", rating: 5 }] },
    });
  });
});

describe("atomic publication", () => {
  it("owns and freezes every published snapshot", () => {
    const initial = sessionWith([photo("p1", 0)]);
    const { service } = createService(initial);

    initial.photos[0]!.rating = 4;
    expect(service.snapshot().photos[0]?.rating).toBe(0);

    expect(() => {
      service.snapshot().photos[0]!.rating = 5;
    }).toThrow(TypeError);
    expect(service.snapshot().photos[0]?.rating).toBe(0);
  });

  it("serializes overlapping commands so neither persisted update is lost", async () => {
    let announceFirstSave: (() => void) | undefined;
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolve) => {
      announceFirstSave = resolve;
    });
    const firstSaveReleased = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const saves: AlbumSession[] = [];
    const store: SessionPersistence = {
      async save(session) {
        saves.push(structuredClone(session));
        if (saves.length === 1) {
          announceFirstSave?.();
          await firstSaveReleased;
        }
      },
    };
    const service = new SessionService(
      sessionWith([photo("p1", 0), photo("p2", 100)]),
      store,
      { now: () => new Date(COMMAND_TIME) },
    );

    const first = service.ratePhoto("p1", 1);
    await firstSaveStarted;
    const second = service.ratePhoto("p2", 2);
    await Promise.resolve();

    expect(saves).toHaveLength(1);
    releaseFirstSave?.();
    await Promise.all([first, second]);
    expect(service.snapshot().photos.map((item) => item.rating)).toEqual([1, 2]);
    expect(saves).toHaveLength(2);
  });

  it("leaves the published snapshot unchanged when command persistence fails", async () => {
    const store = new RecordingStore();
    store.failure = new Error("disk full");
    const { service } = createService(sessionWith([photo("p1", 0)]), store);
    const before = service.snapshot();

    await expect(service.ratePhoto("p1", 5)).rejects.toThrow("disk full");

    expect(service.snapshot()).toBe(before);
    expect(service.snapshot().photos[0]?.rating).toBe(0);
    expect(service.snapshot().history).toEqual([]);
  });

  it("leaves the command available when persisting its undo fails", async () => {
    const store = new RecordingStore();
    const { service } = createService(sessionWith([photo("p1", 0)]), store);
    await service.ratePhoto("p1", 5);
    const before = service.snapshot();
    store.failure = new Error("disk full");

    await expect(service.undo()).rejects.toThrow("disk full");

    expect(service.snapshot()).toBe(before);
    expect(service.snapshot().photos[0]?.rating).toBe(5);
    expect(service.snapshot().history).toHaveLength(1);
  });
});

describe("group commands", () => {
  it("splits with exact child bounds and explicitly provisional multi-photo confidence", async () => {
    const photos = [photo("p1", 100), photo("p2", 250), photo("p3", 900), photo("p4", 5_000)];
    const initial = sessionWith(photos);
    initial.groups = [
      {
        id: "parent",
        photoIds: ["p1", "p2", "p3"],
        startedAtMs: 0,
        endedAtMs: 4_000,
        confidence: 0.42,
        manual: false,
      },
      {
        id: "later",
        photoIds: ["p4"],
        startedAtMs: 5_000,
        endedAtMs: 5_000,
        confidence: 1,
        manual: false,
      },
    ];
    const { service } = createService(initial);

    await service.split("p2");

    expect(service.snapshot().groups.map((group) => group.photoIds)).toEqual([
      ["p1"],
      ["p2", "p3"],
      ["p4"],
    ]);
    expect(service.snapshot().groups.slice(0, 2)).toMatchObject([
      { startedAtMs: 100, endedAtMs: 100, confidence: 1, manual: true },
      { startedAtMs: 250, endedAtMs: 900, confidence: 0.42, manual: true },
    ]);
    expect(service.snapshot().boundaryOverrides).toEqual([
      { action: "split", leftPhotoId: "p1", rightPhotoId: "p2" },
    ]);
    expect(service.snapshot().history).toEqual([
      { type: "split", payload: { boundaryOverrides: [], group: initial.groups[0] } },
    ]);

    await service.undo();

    expect(service.snapshot().groups).toEqual(initial.groups);
    expect(service.snapshot().boundaryOverrides).toEqual([]);
  });

  it("keeps group order chronological after a split", async () => {
    const photos = [photo("early", 100), photo("left", 1_000), photo("right", 1_500)];
    const initial = sessionWith(photos);
    initial.groups = [
      {
        id: "early-group",
        photoIds: ["early"],
        startedAtMs: 100,
        endedAtMs: 100,
        confidence: 1,
        manual: false,
      },
      {
        id: "parent",
        photoIds: ["left", "right"],
        startedAtMs: 1_000,
        endedAtMs: 1_500,
        confidence: 0.8,
        manual: false,
      },
    ];
    const { service } = createService(initial);

    await service.split("right");

    expect(service.snapshot().groups.map((group) => group.photoIds)).toEqual([
      ["early"],
      ["left"],
      ["right"],
    ]);
  });

  it("treats splitting at the first member as a no-op", async () => {
    const { service, store } = createService(sessionWith([photo("p1", 0), photo("p2", 100)]));
    const before = service.snapshot();

    await service.split("p1");

    expect(service.snapshot()).toBe(before);
    expect(store.saves).toEqual([]);
  });

  it("reports an ungrouped known split photo as GROUP_NOT_FOUND", async () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 100)]);
    initial.groups = initial.groups.map((group) => ({
      ...group,
      photoIds: group.photoIds.filter((id) => id !== "p2"),
    }));
    const { service } = createService(initial);

    await expect(service.split("p2")).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  });

  it("merges a group with its chronological successor and undo restores both", async () => {
    const photos = [photo("p1", 0), photo("p2", 2_000)];
    const initial = sessionWith(photos);
    const firstId = initial.groups[0]?.id;
    expect(firstId).toBeDefined();
    const { service } = createService(initial);

    await service.merge(firstId ?? "missing");

    expect(service.snapshot().groups.map((group) => group.photoIds)).toEqual([["p1", "p2"]]);
    expect(service.snapshot().boundaryOverrides).toEqual([
      { action: "join", leftPhotoId: "p1", rightPhotoId: "p2" },
    ]);
    expect(service.snapshot().history).toEqual([
      { type: "merge", payload: { boundaryOverrides: [], groups: initial.groups } },
    ]);

    await service.undo();

    expect(service.snapshot().groups).toEqual(initial.groups);
    expect(service.snapshot().boundaryOverrides).toEqual([]);
  });

  it("persists and reloads an overlapping-camera merge in chronological member order", async () => {
    const photos = [
      { ...photo("a0", 0), cameraId: "A" },
      { ...photo("b250", 250), cameraId: "B" },
      { ...photo("a500", 500), cameraId: "A" },
    ];
    const initial = sessionWith(photos);
    const { service, store } = createService(initial);

    await service.merge(initial.groups[0]!.id);

    expect(service.snapshot().groups[0]).toMatchObject({
      photoIds: ["a0", "b250", "a500"],
      startedAtMs: 0,
      endedAtMs: 500,
    });
    expect(service.snapshot().boundaryOverrides).toEqual([
      { action: "join", leftPhotoId: "a0", rightPhotoId: "b250" },
    ]);
    const persisted = AlbumSessionSchema.parse(JSON.parse(JSON.stringify(store.saves[0])));
    const resumed = new SessionService(persisted, new RecordingStore());
    expect(resumed.snapshot().groups[0]?.photoIds).toEqual(["a0", "b250", "a500"]);

    await resumed.undo();
    expect(resumed.snapshot().groups).toEqual(initial.groups);
    expect(resumed.snapshot().boundaryOverrides).toEqual([]);
  });

  it("keeps two sequential overlapping joins valid through save/load and one-by-one undo", async () => {
    const photos = [
      { ...photo("a0", 0), cameraId: "A" },
      { ...photo("b200", 200), cameraId: "B" },
      { ...photo("c400", 400), cameraId: "C" },
      { ...photo("a600", 600), cameraId: "A" },
    ];
    const initial = sessionWith(photos);
    const { service, store } = createService(initial);
    await service.merge(initial.groups[0]!.id);
    const afterFirst = service.snapshot();
    await service.merge(afterFirst.groups[0]!.id);

    expect(service.snapshot().groups[0]).toMatchObject({
      photoIds: ["a0", "b200", "c400", "a600"],
      startedAtMs: 0,
      endedAtMs: 600,
    });
    expect(service.snapshot().boundaryOverrides).toEqual([
      { action: "join", leftPhotoId: "a0", rightPhotoId: "b200" },
      { action: "join", leftPhotoId: "b200", rightPhotoId: "c400" },
    ]);
    const persisted = AlbumSessionSchema.parse(JSON.parse(JSON.stringify(store.saves.at(-1))));
    const resumed = new SessionService(persisted, new RecordingStore());

    await resumed.undo();
    expect(resumed.snapshot().groups).toEqual(afterFirst.groups);
    expect(resumed.snapshot().boundaryOverrides).toEqual(afterFirst.boundaryOverrides);
    await resumed.undo();
    expect(resumed.snapshot().groups).toEqual(initial.groups);
    expect(resumed.snapshot().boundaryOverrides).toEqual([]);
  });

  it("rejects an unknown merge group with a stable domain error", async () => {
    const { service } = createService(sessionWith([photo("p1", 0)]));

    await expect(service.merge("missing")).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
  });

  it("treats merging the final chronological group as a no-op", async () => {
    const { service, store } = createService(
      sessionWith([photo("p1", 0), photo("p2", 2_000)]),
    );
    const before = service.snapshot();
    const finalGroupId = before.groups.at(-1)?.id;
    expect(finalGroupId).toBeDefined();

    await service.merge(finalGroupId ?? "missing");

    expect(service.snapshot()).toBe(before);
    expect(store.saves).toEqual([]);
  });

  it("regroups at a new sensitivity and undo restores groups and sensitivity", async () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 1_200)]);
    const { service } = createService(initial);

    await service.regroup(2);

    expect(service.snapshot().groupingSensitivity).toBe(2);
    expect(service.snapshot().groups.map((group) => group.photoIds)).toEqual([["p1", "p2"]]);
    expect(service.snapshot().history).toEqual([
      {
        type: "regroup",
        payload: { boundaryOverrides: [], groups: initial.groups, groupingSensitivity: 1 },
      },
    ]);

    await service.undo();

    expect(service.snapshot().groups).toEqual(initial.groups);
    expect(service.snapshot().groupingSensitivity).toBe(1);
  });

  it("treats an identical automatic regroup as a no-op", async () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 2_000)]);
    const { service, store } = createService(initial);
    const before = service.snapshot();

    await service.regroup(initial.groupingSensitivity);

    expect(service.snapshot()).toBe(before);
    expect(store.saves).toEqual([]);
  });
});

describe("undo", () => {
  it("treats an empty history as a no-op", async () => {
    const { service, store } = createService(sessionWith([photo("p1", 0)]));
    const before = service.snapshot();

    await service.undo();

    expect(service.snapshot()).toBe(before);
    expect(store.saves).toEqual([]);
  });
});

describe("session command schema", () => {
  it("accepts durable join co-membership without requiring permanent adjacency", () => {
    const session = sessionWith([photo("a", 0), photo("inserted", 100), photo("b", 200)]);
    session.boundaryOverrides = [{ action: "join", leftPhotoId: "a", rightPhotoId: "b" }];
    expect(AlbumSessionSchema.safeParse(session).success).toBe(true);
  });

  it("rejects a join whose existing IDs are both outside every group", () => {
    const session = sessionWith([photo("a", 0), photo("b", 200)]);
    session.groups = [];
    session.boundaryOverrides = [{ action: "join", leftPhotoId: "a", rightPhotoId: "b" }];
    expect(AlbumSessionSchema.safeParse(session).success).toBe(false);
  });

  it("loads a legacy schema-v1 session with empty boundary overrides", () => {
    const legacy = sessionWith([photo("p1", 0)]);
    const { boundaryOverrides: _removed, ...withoutOverrides } = legacy;
    void _removed;
    expect(AlbumSessionSchema.parse(withoutOverrides).boundaryOverrides).toEqual([]);
  });

  it("accepts every explicit serializable inverse payload and rejects unknown commands", () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 2_000)]);
    const left = initial.groups[0];
    const right = initial.groups[1];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    const commands = [
      { type: "rate", payload: { ratings: [{ photoId: "p1", rating: 0 }] } },
      { type: "split", payload: { group: left } },
      { type: "merge", payload: { groups: [left, right] } },
      { type: "regroup", payload: { groups: [left, right], groupingSensitivity: 1 } },
    ];

    for (const command of commands) {
      expect(SessionCommandSchema.safeParse(command).success).toBe(true);
    }
    expect(SessionCommandSchema.safeParse({ type: "mystery", payload: {} }).success).toBe(false);
    expect(
      AlbumSessionSchema.safeParse({ ...initial, history: [commands[0]] }).success,
    ).toBe(true);
  });

  it("rejects inverse rating payloads with duplicate or unknown photo IDs", () => {
    const initial = sessionWith([photo("p1", 0)]);
    const invalidHistories = [
      [
        {
          type: "rate",
          payload: {
            ratings: [
              { photoId: "p1", rating: 0 },
              { photoId: "p1", rating: 1 },
            ],
          },
        },
      ],
      [{ type: "rate", payload: { ratings: [{ photoId: "missing", rating: 0 }] } }],
    ];

    for (const history of invalidHistories) {
      expect(AlbumSessionSchema.safeParse({ ...initial, history }).success).toBe(false);
    }
  });

  it("rejects invalid group identities, membership, references, and order inside history", () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 2_000)]);
    const left = initial.groups[0]!;
    const right = initial.groups[1]!;
    const invalidHistories = [
      [{ type: "split", payload: { group: { ...left, photoIds: ["p1", "p1"] } } }],
      [{ type: "split", payload: { group: { ...left, photoIds: ["missing"] } } }],
      [{ type: "merge", payload: { groups: [left, left] } }],
      [
        {
          type: "merge",
          payload: { groups: [left, { ...right, photoIds: ["p1"] }] },
        },
      ],
      [
        {
          type: "regroup",
          payload: { groups: [left, { ...right, id: left.id }], groupingSensitivity: 1 },
        },
      ],
      [
        {
          type: "regroup",
          payload: {
            groups: [{ ...left, photoIds: ["p1", "p1"] }, right],
            groupingSensitivity: 1,
          },
        },
      ],
      [
        {
          type: "regroup",
          payload: {
            groups: [{ ...left, photoIds: ["missing"] }, right],
            groupingSensitivity: 1,
          },
        },
      ],
      [
        {
          type: "regroup",
          payload: { groups: [left, { ...right, photoIds: ["p1"] }], groupingSensitivity: 1 },
        },
      ],
      [
        {
          type: "regroup",
          payload: { groups: [right, left], groupingSensitivity: 1 },
        },
      ],
    ];

    for (const history of invalidHistories) {
      expect(AlbumSessionSchema.safeParse({ ...initial, history }).success).toBe(false);
    }
  });

  it("rejects a structurally valid inverse that cannot undo the current group state", () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 2_000)]);
    const history = [{ type: "merge", payload: { groups: initial.groups } }];

    expect(AlbumSessionSchema.safeParse({ ...initial, history }).success).toBe(false);
  });

  it("rejects current groups outside started-time then stable-id order", () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 2_000)]);
    const reverseTime = { ...initial, groups: [...initial.groups].reverse() };
    const sameTimeWrongId = {
      ...initial,
      groups: [
        { ...initial.groups[0]!, id: "z-group", startedAtMs: 0 },
        { ...initial.groups[1]!, id: "a-group", startedAtMs: 0 },
      ],
    };

    expect(AlbumSessionSchema.safeParse(reverseTime).success).toBe(false);
    expect(AlbumSessionSchema.safeParse(sameTimeWrongId).success).toBe(false);
  });

  it("rejects a persisted history longer than the service bound", () => {
    const initial = sessionWith([photo("p1", 0)]);
    const inverse = {
      type: "rate",
      payload: { ratings: [{ photoId: "p1", rating: 0 }] },
    };

    expect(
      AlbumSessionSchema.safeParse({ ...initial, history: Array(101).fill(inverse) }).success,
    ).toBe(false);
  });

  it("rejects duplicate identities, duplicate memberships, and unknown group photo references", () => {
    const initial = sessionWith([photo("p1", 0), photo("p2", 2_000)]);
    const firstGroup = initial.groups[0];
    const secondGroup = initial.groups[1];
    expect(firstGroup).toBeDefined();
    expect(secondGroup).toBeDefined();

    const invalidSessions: AlbumSession[] = [
      { ...initial, photos: [initial.photos[0]!, { ...initial.photos[1]!, id: "p1" }] },
      {
        ...initial,
        groups: [firstGroup!, { ...secondGroup!, id: firstGroup!.id }],
      },
      {
        ...initial,
        groups: [{ ...firstGroup!, photoIds: ["p1", "p1"] }, secondGroup!],
      },
      {
        ...initial,
        groups: [{ ...firstGroup!, photoIds: ["missing"] }, secondGroup!],
      },
      {
        ...initial,
        groups: [firstGroup!, { ...secondGroup!, photoIds: ["p1"] }],
      },
    ];

    for (const invalid of invalidSessions) {
      expect(AlbumSessionSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
