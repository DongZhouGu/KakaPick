import { useCallback, useEffect, useRef, useState, type SyntheticEvent, type WheelEvent, type MouseEvent } from "react";
import type { PublicPhotoUnit } from "../../shared/api.js";
import type { Rating } from "../../shared/domain.js";
import { thumbnailSrcSet, thumbnailUrl } from "../api.js";
import type { PhotosPerPage } from "../culling-preferences.js";
import { visibleBatch } from "../culling-navigation.js";

interface PhotoStageProps {
  readonly focusedId: string | undefined;
  readonly onFocus: (photoId: string) => void;
  readonly onRate: (photoId: string, rating: Rating) => void | Promise<void>;
  readonly photos: readonly PublicPhotoUnit[];
  readonly photosPerPage: PhotosPerPage;
  readonly rejectedIds?: ReadonlySet<string>;
  readonly autoRejectIds?: ReadonlySet<string>;
}

function fadeIn(event: SyntheticEvent<HTMLImageElement>) {
  (event.target as HTMLImageElement).style.opacity = "1";
}

export function PhotoStage({ focusedId, onFocus, onRate, photos, photosPerPage, rejectedIds, autoRejectIds }: PhotoStageProps) {
  const maxPerPage = photosPerPage === "auto" ? 5 : photosPerPage;
  const visibleIds = new Set(visibleBatch(photos.map((photo) => photo.id), focusedId, maxPerPage));
  const visible = photos.filter((photo) => visibleIds.has(photo.id));
  let density: number;
  if (photosPerPage === "auto") {
    const count = visible.length;
    const dims = visible.map((p) => (p.previewWidth && p.previewHeight ? p.previewWidth / p.previewHeight : 0.75));
    const avg = dims.reduce((a, b) => a + b, 0) / dims.length || 0.75;
    if (avg < 0.75) density = Math.min(count, 5);
    else if (avg < 1.0) density = Math.min(count, 4);
    else if (avg > 1.5) density = Math.min(count, 2);
    else density = Math.min(count, 3);
  } else {
    density = Math.min(photosPerPage, visible.length) || 1;
  }
  const desktopWidth = density === 1 ? 100 : 100 / density;
  const rejected = rejectedIds ?? new Set<string>();

  // Synchronized zoom state
  const [zoom, setZoom] = useState(1);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 0.5, y: 0.5 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0.5, oy: 0.5 });
  useEffect(() => { setZoom(1); setZoomOrigin({ x: 0.5, y: 0.5 }); }, [focusedId, visibleIds.size]);

  const calcOrigin = useCallback((e: MouseEvent<HTMLSpanElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  }, []);

  const handleFrameDown = useCallback((e: MouseEvent<HTMLSpanElement>) => {
    if (zoom <= 1) return;
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, ox: zoomOrigin.x, oy: zoomOrigin.y };
    e.preventDefault();
    e.stopPropagation();
  }, [zoom, zoomOrigin]);

  const handleFrameMove = useCallback((e: MouseEvent<HTMLSpanElement>) => {
    if (!dragging.current || zoom <= 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - dragStart.current.x) / rect.width;
    const dy = (e.clientY - dragStart.current.y) / rect.height;
    setZoomOrigin({ x: Math.max(0, Math.min(1, dragStart.current.ox - dx / zoom)), y: Math.max(0, Math.min(1, dragStart.current.oy - dy / zoom)) });
  }, [zoom]);

  useEffect(() => {
    if (zoom <= 1) return;
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [zoom]);

  const handleFrameClick = useCallback((e: MouseEvent<HTMLSpanElement>) => {
    if (dragging.current) return;
    const o = calcOrigin(e);
    setZoomOrigin(o);
    setZoom((prev) => (prev >= 2 ? 1 : 2));
    e.stopPropagation();
  }, [calcOrigin]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((prev) => Math.max(1, Math.min(5, prev - e.deltaY * 0.005)));
  }, []);

  const handleDoubleClick = useCallback(() => { setZoom(1); setZoomOrigin({ x: 0.5, y: 0.5 }); }, []);

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const thumbSize = Math.min(4096, Math.round(zoom <= 1 ? 640 * dpr : 640 * zoom * dpr * 2));
  const zoomStyle = zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: `${zoomOrigin.x * 100}% ${zoomOrigin.y * 100}%`, cursor: "zoom-out" } : { cursor: "zoom-in" };

  return (
    <section className="photo-stage" data-density={density} aria-label="当前连拍照片" onWheel={handleWheel}>
      {visible.map((photo) => {
        const stateClass = rejected.has(photo.id) ? " is-rejected" : photo.rating >= 1 ? " is-kept" : "";
        return (
        <article className={`stage-photo${photo.id === focusedId ? " is-focused" : ""}${stateClass}`} key={photo.id}>
          <button type="button" className="stage-photo-focus" aria-label={`聚焦 ${photo.stem}`} onClick={() => onFocus(photo.id)}>
            <span className="stage-photo-frame" onMouseDown={handleFrameDown} onMouseMove={handleFrameMove} onClick={handleFrameClick} onDoubleClick={handleDoubleClick}>
              <img src={thumbnailUrl(photo.id, thumbSize)} srcSet={thumbnailSrcSet(photo.id)} sizes={`(max-width: 520px) 100vw, ${desktopWidth}vw`} alt="" onLoad={fadeIn} style={zoomStyle} />
              {autoRejectIds?.has(photo.id) ? <span className="ai-badge ai-reject" aria-label="AI 建议淘汰">{photo.sharpness !== undefined && photo.sharpness < 2.0 ? "模糊" : (photo.overexposedRatio ?? 0) > 0.3 ? "过曝" : "欠曝"}</span> : null}
            </span>
            <span className="stage-photo-name"><strong>{photo.stem}</strong><small>{photo.raw !== undefined && photo.jpeg !== undefined ? "RAW + JPEG" : photo.raw !== undefined ? "仅 RAW" : "仅 JPEG"}</small></span>
          </button>
          <div className="stage-rating" aria-label={`${photo.stem} 评分`}>
            {[1, 2, 3, 4, 5].map((rating) => (
              <button type="button" key={rating} aria-label={`将 ${photo.stem} 评为 ${rating} 星`} aria-pressed={photo.rating === rating} onClick={() => { onFocus(photo.id); void onRate(photo.id, rating as Rating); }}>
                {rating <= photo.rating ? "★" : "☆"}
              </button>
            ))}
          </div>
        </article>
      );})}
    </section>
  );
}
