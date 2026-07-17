import type { PhotosPerPage } from "./culling-preferences.js";

export function visibleBatch(ids: readonly string[], focusedId: string | undefined, photosPerPage: PhotosPerPage): readonly string[] {
  if (ids.length === 0) return [];
  const perPage = photosPerPage === "auto" ? 5 : photosPerPage;
  const focusIndex = Math.max(0, ids.indexOf(focusedId ?? ""));
  const start = Math.floor(focusIndex / perPage) * perPage;
  return ids.slice(start, start + perPage);
}

export function moveFocus(ids: readonly string[], focusedId: string | undefined, delta: -1 | 1): string | undefined {
  if (ids.length === 0) return undefined;
  const current = Math.max(0, ids.indexOf(focusedId ?? ""));
  return ids[current + delta];
}
