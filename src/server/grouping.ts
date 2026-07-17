import { createHash } from "node:crypto";
import type { BoundaryOverride, BurstGroup, PhotoUnit } from "../shared/domain.js";
import { hashSimilarity } from "./perceptual-hash.js";

const MIN_THRESHOLD_MS = 650;
const MAX_THRESHOLD_MS = 3_500;
const MAX_ADAPTIVE_GAP_MS = 5_000;
const MIN_MAD_MS = 80;
const MIN_SENSITIVITY = 0.5;
const MAX_SENSITIVITY = 2;

export interface GroupBurstsOptions {
  readonly thresholdMs?: number;
  readonly sensitivity: number;
}

interface BoundaryDecision {
  confidence: number;
  keep: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePhotos(left: PhotoUnit, right: PhotoUnit): number {
  const timeDifference = left.capturedAtMs - right.capturedAtMs;
  return timeDifference === 0 ? compareStrings(left.id, right.id) : timeDifference;
}

function median(sortedValues: readonly number[]): number {
  if (sortedValues.length === 0) return 0;

  const middle = Math.floor(sortedValues.length / 2);
  const upper = sortedValues[middle] ?? 0;
  if (sortedValues.length % 2 === 1) return upper;

  const lower = sortedValues[middle - 1] ?? upper;
  return (lower + upper) / 2;
}

export function computeAdaptiveThreshold(gapsMs: readonly number[]): number {
  const gaps = gapsMs
    .filter((gap) => Number.isFinite(gap) && gap > 0 && gap <= MAX_ADAPTIVE_GAP_MS)
    .sort((left, right) => left - right);
  const gapMedian = median(gaps);
  const deviations = gaps
    .map((gap) => Math.abs(gap - gapMedian))
    .sort((left, right) => left - right);
  const medianAbsoluteDeviation = median(deviations);

  return clamp(
    gapMedian + 3 * Math.max(medianAbsoluteDeviation, MIN_MAD_MS),
    MIN_THRESHOLD_MS,
    MAX_THRESHOLD_MS,
  );
}

function stableGroupId(photoIds: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(photoIds)).digest("hex");
}

function createGroup(
  photos: readonly PhotoUnit[],
  boundaryConfidences: readonly number[],
): BurstGroup {
  const first = photos[0];
  const last = photos.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("Cannot create an empty burst group");
  }

  const photoIds = photos.map((photo) => photo.id);
  const confidence =
    boundaryConfidences.length === 0
      ? 1
      : boundaryConfidences.reduce((total, value) => total + value, 0) /
        boundaryConfidences.length;

  return {
    id: stableGroupId(photoIds),
    photoIds,
    startedAtMs: first.capturedAtMs,
    endedAtMs: last.capturedAtMs,
    confidence: clamp(confidence, 0, 1),
    manual: false,
  };
}

function isKnownId(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function decideBoundary(left: PhotoUnit, right: PhotoUnit, thresholdMs: number): BoundaryDecision {
  const gapMs = right.capturedAtMs - left.capturedAtMs;

  if (
    isKnownId(left.burstId) &&
    left.burstId === right.burstId &&
    gapMs <= 2 * thresholdMs
  ) {
    return { keep: true, confidence: 1 };
  }

  if (
    left.sequenceNumber !== undefined &&
    right.sequenceNumber === left.sequenceNumber + 1 &&
    gapMs <= 2 * thresholdMs
  ) {
    return { keep: true, confidence: 1 };
  }

  if (gapMs <= 0.65 * thresholdMs) {
    return { keep: true, confidence: 1 };
  }

  if (gapMs > 1.6 * thresholdMs) {
    return { keep: false, confidence: 0 };
  }

  if (left.perceptualHash !== undefined && right.perceptualHash !== undefined) {
    const similarity = hashSimilarity(left.perceptualHash, right.perceptualHash);
    if (similarity >= 0.72) return { keep: true, confidence: similarity };
  }

  return { keep: false, confidence: 0 };
}

function validateOptions(options: GroupBurstsOptions): void {
  if (
    !Number.isFinite(options.sensitivity) ||
    options.sensitivity < MIN_SENSITIVITY ||
    options.sensitivity > MAX_SENSITIVITY
  ) {
    throw new RangeError("Grouping sensitivity must be between 0.5 and 2");
  }

  if (
    options.thresholdMs !== undefined &&
    (!Number.isFinite(options.thresholdMs) || options.thresholdMs <= 0)
  ) {
    throw new RangeError("Grouping threshold must be a positive finite number");
  }
}

export function groupBursts(
  photos: readonly PhotoUnit[],
  options: GroupBurstsOptions,
): BurstGroup[] {
  validateOptions(options);
  if (photos.length === 0) return [];

  const orderedPhotos = [...photos].sort(comparePhotos);
  const gaps = orderedPhotos.slice(1).map((photo, index) => {
    const previous = orderedPhotos[index];
    return previous === undefined ? 0 : photo.capturedAtMs - previous.capturedAtMs;
  });
  const baseThresholdMs = options.thresholdMs ?? computeAdaptiveThreshold(gaps);
  const thresholdMs = baseThresholdMs * options.sensitivity;
  const streams = new Map<string, PhotoUnit[]>();
  for (const photo of orderedPhotos) {
    const streamId = isKnownId(photo.cameraId) ? `camera:${photo.cameraId}` : "unknown";
    const stream = streams.get(streamId) ?? [];
    stream.push(photo);
    streams.set(streamId, stream);
  }
  return [...streams.values()]
    .flatMap((stream) => groupStream(stream, thresholdMs))
    .sort((left, right) => {
      const timeDifference = left.startedAtMs - right.startedAtMs;
      return timeDifference === 0 ? compareStrings(left.id, right.id) : timeDifference;
    });
}

function groupStream(orderedPhotos: readonly PhotoUnit[], thresholdMs: number): BurstGroup[] {
  const firstPhoto = orderedPhotos[0];
  if (firstPhoto === undefined) return [];
  const groups: BurstGroup[] = [];
  let currentPhotos: PhotoUnit[] = [firstPhoto];
  let boundaryConfidences: number[] = [];

  for (let index = 1; index < orderedPhotos.length; index += 1) {
    const left = orderedPhotos[index - 1];
    const right = orderedPhotos[index];
    if (left === undefined || right === undefined) continue;

    const decision = decideBoundary(left, right, thresholdMs);
    if (decision.keep) {
      currentPhotos.push(right);
      boundaryConfidences.push(decision.confidence);
      continue;
    }

    groups.push(createGroup(currentPhotos, boundaryConfidences));
    currentPhotos = [right];
    boundaryConfidences = [];
  }

  groups.push(createGroup(currentPhotos, boundaryConfidences));
  return groups;
}

export function applyBoundaryOverrides(
  automaticGroups: readonly BurstGroup[],
  overrides: readonly BoundaryOverride[],
  photos: readonly PhotoUnit[] = [],
): { groups: BurstGroup[]; overrides: BoundaryOverride[] } {
  let groups = automaticGroups.map((group) => ({ ...group, photoIds: [...group.photoIds] }));
  const retained: BoundaryOverride[] = [];

  for (const override of overrides) {
    const leftGroupIndex = groups.findIndex((group) => group.photoIds.includes(override.leftPhotoId));
    const rightGroupIndex = groups.findIndex((group) => group.photoIds.includes(override.rightPhotoId));
    if (leftGroupIndex < 0 || rightGroupIndex < 0) continue;
    const leftGroup = groups[leftGroupIndex];
    const rightGroup = groups[rightGroupIndex];
    if (leftGroup === undefined || rightGroup === undefined) continue;

    if (override.action === "split") {
      const rightIndex = leftGroup.photoIds.indexOf(override.rightPhotoId);
      if (
        leftGroupIndex !== rightGroupIndex ||
        rightIndex <= 0 ||
        leftGroup.photoIds[rightIndex - 1] !== override.leftPhotoId
      ) continue;
      groups = splitGroup(groups, override.rightPhotoId);
      retained.push(override);
      continue;
    }

    if (leftGroupIndex === rightGroupIndex) {
      retained.push(override);
      continue;
    }

    const firstGroupIndex = Math.min(leftGroupIndex, rightGroupIndex);
    const secondGroupIndex = Math.max(leftGroupIndex, rightGroupIndex);
    if (secondGroupIndex !== firstGroupIndex + 1) continue;
    const firstGroup = groups[firstGroupIndex];
    if (firstGroup === undefined) continue;
    groups = mergeGroupWithNext(groups, firstGroup.id, photos);
    retained.push(override);
  }

  const times = new Map(photos.map((photo) => [photo.id, photo.capturedAtMs]));
  groups = groups.map((group) => {
    const captureTimes = group.photoIds.flatMap((photoId) => {
      const capturedAtMs = times.get(photoId);
      return capturedAtMs === undefined ? [] : [capturedAtMs];
    });
    return captureTimes.length === 0 ? group : {
      ...group,
      startedAtMs: Math.min(...captureTimes),
      endedAtMs: Math.max(...captureTimes),
    };
  }).sort((left, right) => {
    const timeDifference = left.startedAtMs - right.startedAtMs;
    return timeDifference === 0 ? compareStrings(left.id, right.id) : timeDifference;
  });
  return { groups, overrides: retained };
}

function splitPart(group: BurstGroup, photoIds: string[]): BurstGroup {
  return {
    ...group,
    id: stableGroupId(photoIds),
    photoIds,
    confidence: photoIds.length === 1 ? 1 : group.confidence,
    manual: true,
  };
}

export function splitGroup(groups: BurstGroup[], photoId: string): BurstGroup[] {
  const groupIndex = groups.findIndex((group) => group.photoIds.includes(photoId));
  if (groupIndex < 0) return groups;

  const group = groups[groupIndex];
  if (group === undefined) return groups;

  const photoIndex = group.photoIds.indexOf(photoId);
  if (photoIndex <= 0) return groups;

  const before = splitPart(group, group.photoIds.slice(0, photoIndex));
  const after = splitPart(group, group.photoIds.slice(photoIndex));
  return [...groups.slice(0, groupIndex), before, after, ...groups.slice(groupIndex + 1)];
}

function mergedConfidence(left: BurstGroup, right: BurstGroup): number {
  const leftBoundaryCount = Math.max(left.photoIds.length - 1, 0);
  const rightBoundaryCount = Math.max(right.photoIds.length - 1, 0);
  const totalBoundaryCount = leftBoundaryCount + rightBoundaryCount + 1;
  const confidenceTotal =
    left.confidence * leftBoundaryCount + right.confidence * rightBoundaryCount + 1;

  return clamp(confidenceTotal / totalBoundaryCount, 0, 1);
}

export function mergeGroupWithNext(
  groups: BurstGroup[],
  groupId: string,
  photos: readonly PhotoUnit[],
): BurstGroup[] {
  const groupIndex = groups.findIndex((group) => group.id === groupId);
  if (groupIndex < 0 || groupIndex >= groups.length - 1) return groups;

  const left = groups[groupIndex];
  const right = groups[groupIndex + 1];
  if (left === undefined || right === undefined) return groups;

  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  const members = [...left.photoIds, ...right.photoIds].map((photoId) => {
    const photo = photosById.get(photoId);
    if (photo === undefined) throw new Error(`Missing photo for merged group: ${photoId}`);
    return photo;
  }).sort(comparePhotos);
  const photoIds = members.map((photo) => photo.id);
  const first = members[0];
  const last = members.at(-1);
  if (first === undefined || last === undefined) throw new Error("Cannot merge empty groups");
  const merged: BurstGroup = {
    id: stableGroupId(photoIds),
    photoIds,
    startedAtMs: first.capturedAtMs,
    endedAtMs: last.capturedAtMs,
    confidence: mergedConfidence(left, right),
    manual: true,
  };

  return [...groups.slice(0, groupIndex), merged, ...groups.slice(groupIndex + 2)];
}

export function joinBoundaryForGroups(
  left: BurstGroup,
  right: BurstGroup,
  photos: readonly PhotoUnit[],
): BoundaryOverride {
  const leftIds = new Set(left.photoIds);
  const rightIds = new Set(right.photoIds);
  const ordered = photos
    .filter((photo) => leftIds.has(photo.id) || rightIds.has(photo.id))
    .sort(comparePhotos);
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1];
    const current = ordered[index];
    if (
      prior !== undefined && current !== undefined &&
      leftIds.has(prior.id) !== leftIds.has(current.id) &&
      (rightIds.has(prior.id) || rightIds.has(current.id))
    ) {
      return { action: "join", leftPhotoId: prior.id, rightPhotoId: current.id };
    }
  }
  throw new Error("Adjacent groups do not have a stable chronological join boundary");
}
