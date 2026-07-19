import { z } from "zod";

export const RatingSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export type Rating = z.infer<typeof RatingSchema>;

const SourceFileBaseSchema = z
  .object({
    path: z.string().min(1),
    relativePath: z.string().min(1),
    size: z.number().finite().nonnegative(),
    modifiedAtMs: z.number().finite().nonnegative(),
  })
  .strict();

export const RawSourceFileSchema = SourceFileBaseSchema.extend({ kind: z.literal("raw") });
export const JpegSourceFileSchema = SourceFileBaseSchema.extend({ kind: z.literal("jpeg") });
export const XmpSourceFileSchema = SourceFileBaseSchema.extend({ kind: z.literal("xmp") });

export const SourceFileSchema = z.discriminatedUnion("kind", [
  RawSourceFileSchema,
  JpegSourceFileSchema,
  XmpSourceFileSchema,
]);

export type SourceFile = z.infer<typeof SourceFileSchema>;

const PhotoUnitBaseSchema = z
  .object({
    id: z.string().min(1),
    stem: z.string().min(1),
    xmp: XmpSourceFileSchema.optional(),
    capturedAtMs: z.number().finite().nonnegative(),
    captureTimeSource: z.enum(["exif", "filename", "file-mtime"]),
    cameraId: z.string().min(1).optional(),
    burstId: z.string().min(1).optional(),
    sequenceNumber: z.number().int().nonnegative().optional(),
    perceptualHash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    sharpness: z.number().finite().nonnegative().optional(),
    overexposedRatio: z.number().min(0).max(1).optional(),
    underexposedRatio: z.number().min(0).max(1).optional(),
    previewWidth: z.number().int().positive().optional(),
    previewHeight: z.number().int().positive().optional(),
    rating: RatingSchema,
  })
  .strict();

export const PhotoUnitSchema = z.union([
  PhotoUnitBaseSchema.extend({
    raw: RawSourceFileSchema,
    jpeg: JpegSourceFileSchema.optional(),
  }),
  PhotoUnitBaseSchema.extend({
    raw: RawSourceFileSchema.optional(),
    jpeg: JpegSourceFileSchema,
  }),
]);

export type PhotoUnit = z.infer<typeof PhotoUnitSchema>;

export const BurstGroupSchema = z
  .object({
    id: z.string().min(1),
    photoIds: z.array(z.string().min(1)).min(1),
    startedAtMs: z.number().finite().nonnegative(),
    endedAtMs: z.number().finite().nonnegative(),
    confidence: z.number().finite().min(0).max(1),
    manual: z.boolean(),
  })
  .strict();

export type BurstGroup = z.infer<typeof BurstGroupSchema>;

export const BoundaryOverrideSchema = z
  .object({
    action: z.enum(["split", "join"]),
    leftPhotoId: z.string().min(1),
    rightPhotoId: z.string().min(1),
  })
  .strict()
  .refine((value) => value.leftPhotoId !== value.rightPhotoId, {
    message: "Boundary override must reference two distinct photos",
  });

export type BoundaryOverride = z.infer<typeof BoundaryOverrideSchema>;

const PriorRatingSchema = z
  .object({
    photoId: z.string().min(1),
    rating: RatingSchema,
  })
  .strict();

export const RateSessionCommandSchema = z
  .object({
    type: z.literal("rate"),
    payload: z
      .object({
        ratings: z.array(PriorRatingSchema).min(1),
      })
      .strict(),
  })
  .strict();

export const SplitSessionCommandSchema = z
  .object({
    type: z.literal("split"),
    payload: z
      .object({
        boundaryOverrides: z.array(BoundaryOverrideSchema).optional(),
        group: BurstGroupSchema,
      })
      .strict(),
  })
  .strict();

export const MergeSessionCommandSchema = z
  .object({
    type: z.literal("merge"),
    payload: z
      .object({
        boundaryOverrides: z.array(BoundaryOverrideSchema).optional(),
        groups: z.tuple([BurstGroupSchema, BurstGroupSchema]),
      })
      .strict(),
  })
  .strict();

export const RegroupSessionCommandSchema = z
  .object({
    type: z.literal("regroup"),
    payload: z
      .object({
        boundaryOverrides: z.array(BoundaryOverrideSchema).optional(),
        groups: z.array(BurstGroupSchema),
        groupingSensitivity: z.number().finite().min(0.5).max(2),
      })
      .strict(),
  })
  .strict();

export const SessionCommandSchema = z.discriminatedUnion("type", [
  RateSessionCommandSchema,
  SplitSessionCommandSchema,
  MergeSessionCommandSchema,
  RegroupSessionCommandSchema,
]);

export type SessionCommand = z.infer<typeof SessionCommandSchema>;

type ValidationPath = Array<string | number>;
type AddValidationIssue = (message: string, path: ValidationPath) => void;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareGroupOrder(left: BurstGroup, right: BurstGroup): number {
  const startedDifference = left.startedAtMs - right.startedAtMs;
  return startedDifference === 0 ? compareStrings(left.id, right.id) : startedDifference;
}

function orderedGroups(groups: readonly BurstGroup[]): BurstGroup[] {
  return [...groups].sort(compareGroupOrder);
}

function validateGroupSet(
  groups: readonly BurstGroup[],
  photoIds: ReadonlySet<string>,
  addIssue: AddValidationIssue,
  path: ValidationPath,
): boolean {
  let valid = true;
  const groupIds = new Set<string>();
  const groupMembership = new Map<string, number>();

  groups.forEach((group, groupIndex) => {
    const priorGroup = groups[groupIndex - 1];
    if (priorGroup !== undefined && compareGroupOrder(priorGroup, group) > 0) {
      valid = false;
      addIssue("Groups must be ordered by start time then stable ID", [
        ...path,
        groupIndex,
        "id",
      ]);
    }

    if (groupIds.has(group.id)) {
      valid = false;
      addIssue("Group IDs must be unique", [...path, groupIndex, "id"]);
    }
    groupIds.add(group.id);

    const memberIds = new Set<string>();
    group.photoIds.forEach((photoId, memberIndex) => {
      if (memberIds.has(photoId)) {
        valid = false;
        addIssue("Photo IDs within a group must be unique", [
          ...path,
          groupIndex,
          "photoIds",
          memberIndex,
        ]);
        return;
      }
      memberIds.add(photoId);

      if (!photoIds.has(photoId)) {
        valid = false;
        addIssue("Groups may only reference session photos", [
          ...path,
          groupIndex,
          "photoIds",
          memberIndex,
        ]);
      }

      const priorGroupIndex = groupMembership.get(photoId);
      if (priorGroupIndex !== undefined) {
        valid = false;
        addIssue("A photo may belong to at most one group", [
          ...path,
          groupIndex,
          "photoIds",
          memberIndex,
        ]);
      } else {
        groupMembership.set(photoId, groupIndex);
      }
    });
  });

  return valid;
}

function restoreSplitForValidation(
  groups: readonly BurstGroup[],
  parent: BurstGroup,
): BurstGroup[] | undefined {
  const parentIds = new Set(parent.photoIds);
  const childIndexes = groups.flatMap((group, groupIndex) =>
    group.photoIds.every((photoId) => parentIds.has(photoId)) ? [groupIndex] : [],
  );
  const childPhotoIds = childIndexes.flatMap(
    (groupIndex) => groups[groupIndex]?.photoIds ?? [],
  );
  const uniqueChildPhotoIds = new Set(childPhotoIds);
  if (
    childIndexes.length !== 2 ||
    childPhotoIds.length !== parent.photoIds.length ||
    uniqueChildPhotoIds.size !== parent.photoIds.length ||
    !parent.photoIds.every((photoId) => uniqueChildPhotoIds.has(photoId))
  ) {
    return undefined;
  }

  const replacedIndexes = new Set(childIndexes);
  return orderedGroups([
    ...groups.filter((_group, groupIndex) => !replacedIndexes.has(groupIndex)),
    parent,
  ]);
}

function restoreMergeForValidation(
  groups: readonly BurstGroup[],
  left: BurstGroup,
  right: BurstGroup,
): BurstGroup[] | undefined {
  const mergedPhotoIds = [...left.photoIds, ...right.photoIds];
  const mergedIds = new Set(mergedPhotoIds);
  const mergedIndex = groups.findIndex((group) =>
    group.photoIds.length === mergedPhotoIds.length &&
    group.photoIds.every((photoId) => mergedIds.has(photoId)));
  if (mergedIndex < 0) return undefined;

  return orderedGroups([
    ...groups.slice(0, mergedIndex),
    left,
    right,
    ...groups.slice(mergedIndex + 1),
  ]);
}

function validateHistory(
  history: readonly SessionCommand[],
  currentGroups: readonly BurstGroup[],
  photoIds: ReadonlySet<string>,
  addIssue: AddValidationIssue,
): void {
  let replayGroups = [...currentGroups];

  for (let historyIndex = history.length - 1; historyIndex >= 0; historyIndex -= 1) {
    const command = history[historyIndex];
    if (command === undefined) continue;
    const payloadPath: ValidationPath = ["history", historyIndex, "payload"];

    switch (command.type) {
      case "rate": {
        const inversePhotoIds = new Set<string>();
        command.payload.ratings.forEach((priorRating, ratingIndex) => {
          if (inversePhotoIds.has(priorRating.photoId)) {
            addIssue("Inverse ratings must reference each photo at most once", [
              ...payloadPath,
              "ratings",
              ratingIndex,
              "photoId",
            ]);
          }
          inversePhotoIds.add(priorRating.photoId);
          if (!photoIds.has(priorRating.photoId)) {
            addIssue("Inverse ratings may only reference session photos", [
              ...payloadPath,
              "ratings",
              ratingIndex,
              "photoId",
            ]);
          }
        });
        break;
      }

      case "split": {
        if (
          !validateGroupSet(
            [command.payload.group],
            photoIds,
            addIssue,
            [...payloadPath, "group"],
          )
        ) {
          break;
        }
        const restored = restoreSplitForValidation(replayGroups, command.payload.group);
        if (restored === undefined) {
          addIssue("Split inverse is not applicable to the replayed group state", payloadPath);
          break;
        }
        replayGroups = restored;
        validateGroupSet(replayGroups, photoIds, addIssue, payloadPath);
        break;
      }

      case "merge": {
        const [left, right] = command.payload.groups;
        if (
          !validateGroupSet(command.payload.groups, photoIds, addIssue, [
            ...payloadPath,
            "groups",
          ])
        ) {
          break;
        }
        const restored = restoreMergeForValidation(replayGroups, left, right);
        if (restored === undefined) {
          addIssue("Merge inverse is not applicable to the replayed group state", payloadPath);
          break;
        }
        replayGroups = restored;
        validateGroupSet(replayGroups, photoIds, addIssue, payloadPath);
        break;
      }

      case "regroup":
        if (
          validateGroupSet(command.payload.groups, photoIds, addIssue, [
            ...payloadPath,
            "groups",
          ])
        ) {
          replayGroups = [...command.payload.groups];
        }
        break;
    }
  }
}

export const AlbumSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourcePathHash: z.string().min(1),
    inventoryFingerprint: z.string().min(1),
    boundaryOverrides: z.array(BoundaryOverrideSchema).default([]),
    photos: z.array(PhotoUnitSchema),
    groups: z.array(BurstGroupSchema),
    groupingSensitivity: z.number().finite().min(0.5).max(2),
    history: z.array(SessionCommandSchema).max(100),
    rejectedIds: z.array(z.string().min(1)).default([]),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((session, context) => {
    const addIssue: AddValidationIssue = (message, path) => {
      context.addIssue({ code: "custom", message, path });
    };
    const photoIds = new Set<string>();
    session.photos.forEach((photo, photoIndex) => {
      if (photoIds.has(photo.id)) {
        addIssue("Photo IDs must be unique", ["photos", photoIndex, "id"]);
      }
      photoIds.add(photo.id);
    });

    validateGroupSet(session.groups, photoIds, addIssue, ["groups"]);
    const overrideKeys = new Set<string>();
    session.boundaryOverrides.forEach((override, overrideIndex) => {
      const path: ValidationPath = ["boundaryOverrides", overrideIndex];
      const key = `${override.leftPhotoId}\0${override.rightPhotoId}`;
      if (overrideKeys.has(key)) addIssue("Boundary overrides must be unique", path);
      overrideKeys.add(key);
      if (!photoIds.has(override.leftPhotoId) || !photoIds.has(override.rightPhotoId)) {
        addIssue("Boundary overrides may only reference session photos", path);
        return;
      }
      const leftGroupIndex = session.groups.findIndex((group) => group.photoIds.includes(override.leftPhotoId));
      const rightGroupIndex = session.groups.findIndex((group) => group.photoIds.includes(override.rightPhotoId));
      const left = session.groups[leftGroupIndex];
      const right = session.groups[rightGroupIndex];
      const applicable = override.action === "split"
        ? rightGroupIndex === leftGroupIndex + 1 && left?.photoIds.at(-1) === override.leftPhotoId && right?.photoIds[0] === override.rightPhotoId
        : leftGroupIndex >= 0 && leftGroupIndex === rightGroupIndex;
      if (!applicable) {
        addIssue(
          override.action === "split"
            ? "Split override must match the current adjacent photo boundary"
            : "Join override photos must belong to the same current group",
          path,
        );
      }
    });
    validateHistory(session.history, session.groups, photoIds, addIssue);
  });

export type AlbumSession = z.infer<typeof AlbumSessionSchema>;

export const ScanWarningCodeSchema = z.enum([
  "DUPLICATE_RAW",
  "DUPLICATE_JPEG",
  "DUPLICATE_XMP",
  "UNPAIRED_RAW",
  "UNPAIRED_JPEG",
]);

export const ScanWarningSchema = z
  .object({
    code: ScanWarningCodeSchema,
    photoId: z.string().min(1),
    relativePaths: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ScanWarning = z.infer<typeof ScanWarningSchema>;
