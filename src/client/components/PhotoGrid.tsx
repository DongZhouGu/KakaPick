import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicPhotoUnit } from "../../shared/api.js";
import type { BurstGroup, Rating } from "../../shared/domain.js";
import { thumbnailUrl } from "../api.js";
import { isEditableTarget, useCullingKeys } from "../use-culling-keys.js";
import { Loupe } from "./Loupe.js";

type RateTarget = string | readonly string[];

interface PhotoGridProps {
  readonly group: BurstGroup;
  readonly onFocusedChange?: (photoId: string | undefined) => void;
  readonly onGroup?: (offset: -1 | 1) => void;
  readonly onMerge?: () => void;
  readonly onRate: (photoIds: RateTarget, rating: Rating) => void | Promise<void>;
  readonly onSplit?: (photoId: string) => void;
  readonly onUndo?: () => void;
  readonly photos: readonly PublicPhotoUnit[];
}

function photoLabel(photo: PublicPhotoUnit, selected: boolean): string {
  const pairing = photo.raw !== undefined && photo.jpeg !== undefined ? "RAW 与 JPEG 配对" : photo.raw !== undefined ? "仅 RAW" : "仅 JPEG";
  const rating = photo.rating === 0 ? "未评分" : `${photo.rating} 星`;
  return `${photo.stem}，${rating}，${pairing}${selected ? "，已多选" : ""}`;
}

function nextSpatialIndex(buttons: readonly HTMLButtonElement[], current: number, key: string): number {
  const origin = buttons[current]?.getBoundingClientRect();
  if (origin === undefined) return current;
  const ox = origin.left + origin.width / 2;
  const oy = origin.top + origin.height / 2;
  let best = current;
  let bestScore = Number.POSITIVE_INFINITY;
  buttons.forEach((button, index) => {
    if (index === current) return;
    const rect = button.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - ox;
    const dy = rect.top + rect.height / 2 - oy;
    const valid = key === "ArrowLeft" ? dx < 0 : key === "ArrowRight" ? dx > 0 : key === "ArrowUp" ? dy < 0 : dy > 0;
    if (!valid) return;
    const primary = key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dx) : Math.abs(dy);
    const cross = key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + cross * 2;
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  });
  if (best === current && buttons.length > 1) {
    return key === "ArrowLeft" || key === "ArrowUp" ? Math.max(0, current - 1) : Math.min(buttons.length - 1, current + 1);
  }
  return best;
}

export function PhotoGrid({
  group,
  onFocusedChange,
  onGroup = () => undefined,
  onMerge = () => undefined,
  onRate,
  onSplit = () => undefined,
  onUndo = () => undefined,
  photos,
}: PhotoGridProps) {
  const ordered = useMemo(() => {
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    return group.photoIds.flatMap((id) => {
      const photo = byId.get(id);
      return photo === undefined ? [] : [photo];
    });
  }, [group.photoIds, photos]);
  const [focusedId, setFocusedId] = useState<string | undefined>(ordered[0]?.id);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const [loupeOpen, setLoupeOpen] = useState(false);
  const [loupeFit, setLoupeFit] = useState(true);
  const [failedImages, setFailedImages] = useState<ReadonlySet<string>>(new Set());
  const [retryCounts, setRetryCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusedId === undefined || !ordered.some((photo) => photo.id === focusedId)) {
      const nextId = ordered[0]?.id;
      setFocusedId(nextId);
      onFocusedChange?.(nextId);
    } else {
      onFocusedChange?.(focusedId);
    }
  }, [focusedId, onFocusedChange, ordered]);

  const focused = ordered.find((photo) => photo.id === focusedId);
  const closeLoupe = () => {
    setLoupeOpen(false);
    queueMicrotask(() => [...(gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-photo-id]") ?? [])]
      .find((button) => button.dataset.photoId === focusedId)?.focus());
  };
  const applyRating = (rating: Rating, applySelection: boolean) => {
    if (focused === undefined) return;
    const targets = applySelection ? [...new Set([...selected, focused.id])] : [focused.id];
    void onRate(applySelection ? targets : focused.id, rating);
    setAnnouncement(`${applySelection && targets.length > 1 ? `${targets.length} 张照片` : focused.stem}，${rating} 星`);
  };

  useCullingKeys({
    enabled: !loupeOpen,
    onEscape: () => setSelected(new Set()),
    onGroup,
    onMerge,
    onRate: applyRating,
    onSpace: () => {
      if (focused !== undefined) setLoupeOpen(true);
    },
    onSplit: () => {
      if (focused !== undefined) onSplit(focused.id);
    },
    onToggleSelect: () => {
      if (focused === undefined) return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(focused.id)) next.delete(focused.id); else next.add(focused.id);
        return next;
      });
    },
    onUndo,
  });

  useEffect(() => {
    if (loupeOpen) return;
    const move = (event: KeyboardEvent) => {
      if (!event.key.startsWith("Arrow") || isEditableTarget(event.target)) return;
      const buttons = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-photo-id]") ?? [])];
      const current = Math.max(0, buttons.findIndex((button) => button.dataset.photoId === focusedId));
      const next = nextSpatialIndex(buttons, current, event.key);
      const button = buttons[next];
      if (button === undefined) return;
      event.preventDefault();
      button.focus();
      const nextId = button.dataset.photoId;
      if (nextId !== undefined) {
        setFocusedId(nextId);
        onFocusedChange?.(nextId);
      }
    };
    window.addEventListener("keydown", move);
    return () => window.removeEventListener("keydown", move);
  }, [focusedId, loupeOpen, onFocusedChange]);

  if (ordered.length === 0) {
    return <div className="empty-grid"><strong>这个分组没有符合筛选条件的照片</strong><span>切换顶部筛选即可继续浏览。</span></div>;
  }

  return (
    <>
      <div className="photo-grid" ref={gridRef} aria-label="当前连拍照片">
        {ordered.map((photo) => {
          const isSelected = selected.has(photo.id);
          const isFocused = focusedId === photo.id;
          return (
            <article className={`photo-card${isFocused ? " is-focused" : ""}${isSelected ? " is-selected" : ""}`} key={photo.id}>
              <button
                className="photo-open"
                type="button"
                data-photo-id={photo.id}
                aria-label={photoLabel(photo, isSelected)}
                aria-pressed={isSelected}
                tabIndex={isFocused ? 0 : -1}
                onClick={(event) => {
                  setFocusedId(photo.id);
                  onFocusedChange?.(photo.id);
                  if (event.shiftKey || event.metaKey || event.ctrlKey) {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id);
                      return next;
                    });
                  }
                }}
                onDoubleClick={() => setLoupeOpen(true)}
              >
                <span className="photo-frame">
                  {failedImages.has(photo.id) ? (
                    <span className="image-fallback">预览不可用<br /><small>仍可评分</small></span>
                  ) : (
                    <img loading="lazy" src={`${thumbnailUrl(photo.id)}${(retryCounts.get(photo.id) ?? 0) > 0 ? `&retry=${String(retryCounts.get(photo.id))}` : ""}`} alt="" onError={() => setFailedImages((current) => new Set(current).add(photo.id))} />
                  )}
                  {isSelected ? <span className="selection-badge">已选</span> : null}
                  {photo.captureTimeSource === "file-mtime" ? <span className="capture-time-badge">文件时间</span> : null}
                  <span className={`rating-badge rating-${photo.rating}`}>{photo.rating === 0 ? "未评分" : `${photo.rating} ★`}</span>
                </span>
                <span className="photo-meta">
                  <strong>{photo.stem}</strong>
                  <small className={photo.raw === undefined || photo.jpeg === undefined ? "unpaired-state" : undefined}>{photo.raw !== undefined && photo.jpeg !== undefined ? "RAW + JPEG" : photo.raw !== undefined ? "仅 RAW" : "仅 JPEG"}</small>
                </span>
              </button>
              <div className="photo-actions">
                <button type="button" aria-label={`${isSelected ? "取消选择" : "选择"} ${photo.stem}`} aria-pressed={isSelected} onClick={() => {
                  setFocusedId(photo.id);
                  onFocusedChange?.(photo.id);
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id);
                    return next;
                  });
                }}>{isSelected ? "取消多选" : "加入多选"}</button>
                {failedImages.has(photo.id) ? <button type="button" aria-label={`重试 ${photo.stem} 预览`} onClick={() => {
                  setFailedImages((current) => {
                    const next = new Set(current); next.delete(photo.id); return next;
                  });
                  setRetryCounts((current) => new Map(current).set(photo.id, (current.get(photo.id) ?? 0) + 1));
                }}>重试预览</button> : null}
              </div>
            </article>
          );
        })}
      </div>
      {focused !== undefined ? <fieldset className="pointer-rating" aria-label="焦点照片评分">
        <legend>{focused.stem} 评分</legend>
        {([0, 1, 2, 3, 4, 5] as const).map((rating) => <button key={rating} type="button" aria-label={`${selected.size > 0 ? "将所选照片" : `将 ${focused.stem}`}评为 ${rating} 星`} aria-pressed={focused.rating === rating} onClick={() => {
          const targets = selected.size > 0 ? [...new Set([...selected, focused.id])] : [focused.id];
          void onRate(targets, rating);
          setAnnouncement(`${targets.length > 1 ? `${targets.length} 张照片` : focused.stem}，${rating} 星`);
        }}>{rating === 0 ? "0 清除" : `${rating} ★`}</button>)}
      </fieldset> : null}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      {loupeOpen && focused !== undefined ? <Loupe photo={focused} fit={loupeFit} onToggleFit={() => setLoupeFit((value) => !value)} onClose={closeLoupe} /> : null}
    </>
  );
}
