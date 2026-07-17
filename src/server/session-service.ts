import {
  AlbumSessionSchema,
  RatingSchema,
  type AlbumSession,
  type BurstGroup,
  type Rating,
  type SessionCommand,
} from "../shared/domain.js";
import { applyBoundaryOverrides, groupBursts, joinBoundaryForGroups, mergeGroupWithNext, splitGroup } from "./grouping.js";

const MAX_HISTORY_LENGTH = 100;

export type SessionErrorCode = "PHOTO_NOT_FOUND" | "GROUP_NOT_FOUND";

const ERROR_MESSAGES: Record<SessionErrorCode, string> = {
  PHOTO_NOT_FOUND: "Photo not found",
  GROUP_NOT_FOUND: "Group not found",
};

export class SessionDomainError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SessionDomainError";
    this.code = code;
  }
}

export interface SessionPersistence {
  save(session: AlbumSession): Promise<void>;
}

export interface SessionServiceOptions {
  readonly now?: () => Date;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function chronologicalGroups(groups: readonly BurstGroup[]): BurstGroup[] {
  return [...groups].sort((left, right) => {
    const startedDifference = left.startedAtMs - right.startedAtMs;
    return startedDifference === 0 ? compareStrings(left.id, right.id) : startedDifference;
  });
}

function sameGroups(left: readonly BurstGroup[], right: readonly BurstGroup[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendHistory(history: readonly SessionCommand[], command: SessionCommand): SessionCommand[] {
  return [...history, command].slice(-MAX_HISTORY_LENGTH);
}

function replaceBoundary(
  session: AlbumSession,
  leftPhotoId: string,
  rightPhotoId: string,
  action: "split" | "join",
) {
  return [
    ...session.boundaryOverrides.filter((item) =>
      item.leftPhotoId !== leftPhotoId || item.rightPhotoId !== rightPhotoId),
    { action, leftPhotoId, rightPhotoId },
  ];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * A split helper has no per-boundary evidence for either child. Exact temporal bounds come from
 * the service's photo lookup; a singleton is fully certain, while a multi-photo child explicitly
 * keeps the parent confidence as a provisional value until regrouping can recompute evidence.
 */
function completeSplitChild(
  child: BurstGroup,
  parentConfidence: number,
  photosById: ReadonlyMap<string, AlbumSession["photos"][number]>,
): BurstGroup {
  const captureTimes = child.photoIds.map((photoId) => {
    const member = photosById.get(photoId);
    if (member === undefined) throw new SessionDomainError("PHOTO_NOT_FOUND");
    return member.capturedAtMs;
  });

  return {
    ...child,
    startedAtMs: Math.min(...captureTimes),
    endedAtMs: Math.max(...captureTimes),
    confidence: child.photoIds.length === 1 ? 1 : parentConfidence,
  };
}

export class SessionService {
  readonly #persistence: SessionPersistence;
  readonly #now: () => Date;
  #session: AlbumSession;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    session: AlbumSession,
    persistence: SessionPersistence,
    options: SessionServiceOptions = {},
  ) {
    this.#session = deepFreeze(AlbumSessionSchema.parse(session));
    this.#persistence = persistence;
    this.#now = options.now ?? (() => new Date());
  }

  snapshot(): AlbumSession {
    return this.#session;
  }

  ratePhoto(photoId: string, rating: Rating): Promise<AlbumSession> {
    return this.ratePhotos([photoId], rating);
  }

  ratePhotos(photoIds: readonly string[], rating: Rating): Promise<AlbumSession> {
    const validatedRating = RatingSchema.parse(rating);
    return this.#enqueue(async () => {
      const uniquePhotoIds = [...new Set(photoIds)];
      const photosById = new Map(this.#session.photos.map((item) => [item.id, item]));

      for (const photoId of uniquePhotoIds) {
        if (!photosById.has(photoId)) throw new SessionDomainError("PHOTO_NOT_FOUND");
      }

      const priorRatings = uniquePhotoIds.flatMap((photoId) => {
        const item = photosById.get(photoId);
        return item === undefined || item.rating === validatedRating
          ? []
          : [{ photoId, rating: item.rating }];
      });
      if (priorRatings.length === 0) return this.#session;

      const changedIds = new Set(priorRatings.map((item) => item.photoId));
      const photos = this.#session.photos.map((item) =>
        changedIds.has(item.id) ? { ...item, rating: validatedRating } : item,
      );
      const inverse: SessionCommand = {
        type: "rate",
        payload: { ratings: priorRatings },
      };
      const rejected = new Set(this.#session.rejectedIds ?? []);
      for (const photoId of uniquePhotoIds) {
        if (validatedRating === 0) rejected.add(photoId);
        else rejected.delete(photoId);
      }

      return this.#commit(
        { photos, rejectedIds: [...rejected] },
        appendHistory(this.#session.history, inverse),
      );
    });
  }

  split(photoId: string): Promise<AlbumSession> {
    return this.#enqueue(async () => {
      if (!this.#session.photos.some((item) => item.id === photoId)) {
        throw new SessionDomainError("PHOTO_NOT_FOUND");
      }

      const parentIndex = this.#session.groups.findIndex((group) =>
        group.photoIds.includes(photoId),
      );
      const parent = this.#session.groups[parentIndex];
      if (parent === undefined) throw new SessionDomainError("GROUP_NOT_FOUND");

      const splitGroups = splitGroup(this.#session.groups, photoId);
      if (splitGroups === this.#session.groups) return this.#session;

      const photosById = new Map(this.#session.photos.map((item) => [item.id, item]));
      const left = splitGroups[parentIndex];
      const right = splitGroups[parentIndex + 1];
      if (left === undefined || right === undefined) {
        throw new SessionDomainError("GROUP_NOT_FOUND");
      }

      const groups = chronologicalGroups([
        ...splitGroups.slice(0, parentIndex),
        completeSplitChild(left, parent.confidence, photosById),
        completeSplitChild(right, parent.confidence, photosById),
        ...splitGroups.slice(parentIndex + 2),
      ]);
      const photoIndex = parent.photoIds.indexOf(photoId);
      const leftPhotoId = parent.photoIds[photoIndex - 1];
      if (leftPhotoId === undefined) return this.#session;
      const boundaryOverrides = replaceBoundary(this.#session, leftPhotoId, photoId, "split");
      const inverse: SessionCommand = {
        type: "split",
        payload: { boundaryOverrides: this.#session.boundaryOverrides, group: parent },
      };

      return this.#commit(
        { boundaryOverrides, groups },
        appendHistory(this.#session.history, inverse),
      );
    });
  }

  merge(groupId: string): Promise<AlbumSession> {
    return this.#enqueue(async () => {
      if (!this.#session.groups.some((group) => group.id === groupId)) {
        throw new SessionDomainError("GROUP_NOT_FOUND");
      }

      const orderedGroups = chronologicalGroups(this.#session.groups);
      const groupIndex = orderedGroups.findIndex((group) => group.id === groupId);
      const left = orderedGroups[groupIndex];
      const right = orderedGroups[groupIndex + 1];
      if (left === undefined) throw new SessionDomainError("GROUP_NOT_FOUND");
      if (right === undefined) return this.#session;

      const groups = mergeGroupWithNext(orderedGroups, groupId, this.#session.photos);
      const joinBoundary = joinBoundaryForGroups(left, right, this.#session.photos);
      const boundaryOverrides = replaceBoundary(
        this.#session,
        joinBoundary.leftPhotoId,
        joinBoundary.rightPhotoId,
        "join",
      );
      const inverse: SessionCommand = {
        type: "merge",
        payload: { boundaryOverrides: this.#session.boundaryOverrides, groups: [left, right] },
      };

      return this.#commit(
        { boundaryOverrides, groups: chronologicalGroups(groups) },
        appendHistory(this.#session.history, inverse),
      );
    });
  }

  regroup(groupingSensitivity: number): Promise<AlbumSession> {
    return this.#enqueue(async () => {
      const automaticGroups = groupBursts(this.#session.photos, { sensitivity: groupingSensitivity });
      const applied = applyBoundaryOverrides(automaticGroups, this.#session.boundaryOverrides, this.#session.photos);
      const groups = applied.groups;
      if (
        groupingSensitivity === this.#session.groupingSensitivity &&
        sameGroups(groups, this.#session.groups)
      ) {
        return this.#session;
      }

      const inverse: SessionCommand = {
        type: "regroup",
        payload: {
          groups: this.#session.groups,
          boundaryOverrides: this.#session.boundaryOverrides,
          groupingSensitivity: this.#session.groupingSensitivity,
        },
      };

      return this.#commit(
        { boundaryOverrides: applied.overrides, groups: chronologicalGroups(groups), groupingSensitivity },
        appendHistory(this.#session.history, inverse),
      );
    });
  }

  undo(): Promise<AlbumSession> {
    return this.#enqueue(async () => {
      const command = this.#session.history.at(-1);
      if (command === undefined) return this.#session;

      const changes = this.#undoChanges(command);
      return this.#commit(changes, this.#session.history.slice(0, -1));
    });
  }

  #enqueue(operation: () => Promise<AlbumSession>): Promise<AlbumSession> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #commit(
    changes: Partial<Pick<AlbumSession, "boundaryOverrides" | "photos" | "groups" | "groupingSensitivity" | "rejectedIds">>,
    history: SessionCommand[],
  ): Promise<AlbumSession> {
    const candidate = deepFreeze(
      AlbumSessionSchema.parse({
        ...this.#session,
        ...changes,
        history,
        updatedAt: this.#now().toISOString(),
      }),
    );

    await this.#persistence.save(candidate);
    this.#session = candidate;
    return this.#session;
  }

  #undoChanges(
    command: SessionCommand,
  ): Partial<Pick<AlbumSession, "boundaryOverrides" | "photos" | "groups" | "groupingSensitivity">> {
    switch (command.type) {
      case "rate": {
        const priorRatings = new Map(
          command.payload.ratings.map((item) => [item.photoId, item.rating]),
        );
        for (const photoId of priorRatings.keys()) {
          if (!this.#session.photos.some((item) => item.id === photoId)) {
            throw new SessionDomainError("PHOTO_NOT_FOUND");
          }
        }
        return {
          photos: this.#session.photos.map((item) => {
            const rating = priorRatings.get(item.id);
            return rating === undefined ? item : { ...item, rating };
          }),
        };
      }

      case "split": {
        const parentIds = new Set(command.payload.group.photoIds);
        const childGroups = this.#session.groups.filter((group) =>
          group.photoIds.every((photoId) => parentIds.has(photoId)),
        );
        const childPhotoIds = childGroups.flatMap((group) => group.photoIds);
        if (
          childGroups.length !== 2 ||
          childPhotoIds.length !== parentIds.size ||
          !childPhotoIds.every((photoId) => parentIds.has(photoId))
        ) {
          throw new SessionDomainError("GROUP_NOT_FOUND");
        }
        const childIds = new Set(childGroups.map((group) => group.id));
        return {
          boundaryOverrides: command.payload.boundaryOverrides ?? [],
          groups: chronologicalGroups([
            ...this.#session.groups.filter((group) => !childIds.has(group.id)),
            command.payload.group,
          ]),
        };
      }

      case "merge": {
        const [left, right] = command.payload.groups;
        const mergedPhotoIds = [...left.photoIds, ...right.photoIds];
        const mergedIds = new Set(mergedPhotoIds);
        const mergedIndex = this.#session.groups.findIndex((group) =>
          group.photoIds.length === mergedPhotoIds.length &&
          group.photoIds.every((photoId) => mergedIds.has(photoId)),
        );
        if (mergedIndex < 0) throw new SessionDomainError("GROUP_NOT_FOUND");
        return {
          boundaryOverrides: command.payload.boundaryOverrides ?? [],
          groups: chronologicalGroups([
            ...this.#session.groups.slice(0, mergedIndex),
            left,
            right,
            ...this.#session.groups.slice(mergedIndex + 1),
          ]),
        };
      }

      case "regroup":
        return {
          boundaryOverrides: command.payload.boundaryOverrides ?? [],
          groups: command.payload.groups,
          groupingSensitivity: command.payload.groupingSensitivity,
        };
    }
  }
}
