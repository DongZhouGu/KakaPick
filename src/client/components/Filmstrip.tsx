import type { PublicPhotoUnit } from "../../shared/api.js";
import { thumbnailUrl } from "../api.js";

interface FilmstripProps {
  readonly focusedId: string | undefined;
  readonly onFocus: (photoId: string) => void;
  readonly photos: readonly PublicPhotoUnit[];
  readonly visibleIds: readonly string[];
  readonly rejectedIds?: ReadonlySet<string>;
}

export function Filmstrip({ focusedId, onFocus, photos, visibleIds, rejectedIds }: FilmstripProps) {
  const visible = new Set(visibleIds);
  const rejected = rejectedIds ?? new Set<string>();
  return <nav className="filmstrip" aria-label="当前连拍胶片带">{photos.map((photo, index) => (
    <button type="button" key={photo.id} aria-label={`${photo.stem}，第 ${index + 1} 张，${photo.rating} 星`} aria-current={photo.id === focusedId ? "true" : undefined} className={`${visible.has(photo.id) ? "is-visible" : ""}${rejected.has(photo.id) ? " is-rejected" : photo.rating >= 1 ? " is-kept" : ""}`} onClick={() => onFocus(photo.id)}>
      <img src={thumbnailUrl(photo.id)} alt="" /><span>{index + 1}</span>
    </button>
  ))}</nav>;
}
