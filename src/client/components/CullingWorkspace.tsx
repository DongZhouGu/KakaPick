import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiScanWarning, PublicAlbumSession } from "../../shared/api.js";
import type { Rating } from "../../shared/domain.js";
import { isEditableTarget } from "../use-culling-keys.js";
import { readCullingPreferences, writeCullingPreferences } from "../culling-preferences.js";
import { moveFocus, visibleBatch } from "../culling-navigation.js";
import { thumbnailUrl } from "../api.js";
import { confetti } from "../confetti.js";
import { ExportPanel } from "./ExportPanel.js";
import { BrandMark } from "./BrandMark.js";
import { Filmstrip } from "./Filmstrip.js";
import { PhotoStage } from "./PhotoStage.js";
import { ScanWarnings } from "./ScanWarnings.js";
import { CullingSettings } from "./CullingSettings.js";
import { GroupOverview } from "./GroupOverview.js";

interface CullingWorkspaceProps {
  readonly album: PublicAlbumSession;
  readonly albumName: string;
  readonly error?: string;
  readonly onHome: () => void;
  readonly onMerge: (groupId: string) => void | Promise<void>;
  readonly onRate: (photoIds: readonly string[], rating: Rating) => boolean | void | Promise<boolean | void>;
  readonly onSensitivity: (value: number) => void | Promise<void>;
  readonly onSplit: (photoId: string) => void | Promise<void>;
  readonly onUndo: () => void | Promise<void>;
  readonly warnings?: readonly ApiScanWarning[];
}

export function CullingWorkspace({ album, albumName, error, onHome, onMerge, onRate, onSensitivity, onSplit, onUndo, warnings = [] }: CullingWorkspaceProps) {
  const [groupIndex, setGroupIndex] = useState(0);
  const [preferences, setPreferences] = useState(readCullingPreferences);
  const [focusedId, setFocusedId] = useState<string | undefined>(album.groups[0]?.photoIds[0]);
  const [inspecting, setInspecting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [undoToast, setUndoToast] = useState(false);
  const undoRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const spaceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sensitivity, setSensitivity] = useState(album.groupingSensitivity);
  useEffect(() => { setSensitivity(album.groupingSensitivity); }, [album.groupingSensitivity]);
  const [inspectSrc, setInspectSrc] = useState<string>();
  const [inspectActual, setInspectActual] = useState(false);
  const [inspectZoom, setInspectZoom] = useState(1);
  const [inspectOrigin, setInspectOrigin] = useState({ x: 0.5, y: 0.5 });
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(() => new Set(album.rejectedIds ?? []));
  const [filterMode, setFilterMode] = useState<"all" | "unprocessed" | "picked" | "rejected">("all");
  const currentGroup = album.groups[groupIndex];
  const byId = useMemo(() => new Map(album.photos.map((photo) => [photo.id, photo])), [album.photos]);
  const rated = album.photos.filter((photo) => photo.rating > 0).length;
  const totalGroups = album.groups.length;
  const groupPct = totalGroups > 0 ? Math.round((groupIndex + 1) / totalGroups * 100) : 0;
  const milestoneRef = useRef(groupPct);
  useEffect(() => {
    const prev = milestoneRef.current;
    if (groupPct >= 100 && prev < 100) confetti(100);
    else if (groupPct >= 80 && prev < 80) confetti(50);
    else if (groupPct >= 50 && prev < 50) confetti(30);
    milestoneRef.current = groupPct;
  }, [groupPct]);
  const allPhotos = currentGroup?.photoIds.flatMap((id) => { const photo = byId.get(id); return photo === undefined ? [] : [photo]; }) ?? [];
  const filteredPhotos = filterMode === "unprocessed" ? allPhotos.filter((p) => p.rating === 0 && !rejectedIds.has(p.id))
    : filterMode === "picked" ? allPhotos.filter((p) => p.rating >= 1)
    : filterMode === "rejected" ? allPhotos.filter((p) => rejectedIds.has(p.id))
    : allPhotos;
  const photos = filteredPhotos.length > 0 ? filteredPhotos : allPhotos;
  const ids = photos.map((p) => p.id);
  const emptyFilter = filteredPhotos.length === 0 && filterMode !== "all";
  const effectiveFocusedId = focusedId !== undefined && ids.includes(focusedId) ? focusedId : ids[0];
  const visibleIds = visibleBatch(ids, effectiveFocusedId, preferences.photosPerPage);
  const focused = byId.get(effectiveFocusedId ?? "");
  const autoRejectIds = useMemo(() => {
    if (!preferences.showAiHint) return new Set<string>();
    const result = new Set<string>();
    let hasData = false;
    for (const photo of album.photos) {
      if (photo.sharpness === undefined && photo.overexposedRatio === undefined) continue;
      hasData = true;
      const sharp = photo.sharpness ?? 100;
      const over = photo.overexposedRatio ?? 0;
      const under = photo.underexposedRatio ?? 0;
      if (sharp < 3.0 || over > 0.2 || under > 0.35) result.add(photo.id);
    }
    return hasData ? result : new Set<string>();
  }, [album.photos, preferences.showAiHint]);
  const aiNoData = preferences.showAiHint && autoRejectIds.size === 0 && album.photos.some((p) => p.sharpness !== undefined || p.overexposedRatio !== undefined);
  const aiEmpty = preferences.showAiHint && autoRejectIds.size === 0 && !album.photos.some((p) => p.sharpness !== undefined);
  const savePreferences = (next: typeof preferences) => { setPreferences(next); writeCullingPreferences(next); };
  useEffect(() => { if (ids.length > 0 && (focusedId === undefined || !ids.includes(focusedId))) setFocusedId(ids[0]); }, [ids, focusedId]);
  const move = (delta: -1 | 1) => {
    const next = moveFocus(ids, focusedId, delta);
    if (next !== undefined) { setFocusedId(next); return; }
    const targetGroup = album.groups[groupIndex + delta];
    if (targetGroup === undefined) return;
    setGroupIndex(groupIndex + delta);
    setFocusedId(delta === 1 ? targetGroup.photoIds[0] : targetGroup.photoIds.at(-1));
  };
  const jumpGroup = (delta: -1 | 1) => {
    const targetIndex = groupIndex + delta;
    const targetGroup = album.groups[targetIndex];
    if (targetGroup === undefined) return;
    setGroupIndex(targetIndex);
    setFocusedId(delta === 1 ? targetGroup.photoIds[0] : targetGroup.photoIds.at(-1));
  };
  const selectGroup = (index: number) => {
    const group = album.groups[index];
    if (group === undefined) return;
    const groupPhotos = group.photoIds.flatMap((id) => { const photo = byId.get(id); return photo === undefined ? [] : [photo]; });
    setGroupIndex(index);
    setFocusedId(groupPhotos.find((photo) => photo.rating === 0)?.id ?? groupPhotos[0]?.id);
    setOverviewOpen(false);
  };
  const rate = async (photoId: string, rating: Rating) => {
    setSaveState("saving");
    try {
      const saved = await onRate([photoId], rating);
      if (saved === false) { setSaveState("error"); return; }
      setSaveState("saved");
      if (rating > 0) setRejectedIds((prev) => { const next = new Set(prev); next.delete(photoId); return next; });
      if (preferences.advanceAfterRating) move(1);
    } catch { setSaveState("error"); }
  };
  const toggleReject = async (photoId: string) => {
    if (rejectedIds.has(photoId)) {
      setRejectedIds((prev) => { const next = new Set(prev); next.delete(photoId); return next; });
      setSaveState("saving");
      try { await onRate([photoId], 1); setSaveState("saved"); }
      catch { setSaveState("error"); }
    } else {
      setRejectedIds((prev) => new Set(prev).add(photoId));
      setSaveState("saving");
      try { await onRate([photoId], 0); setSaveState("saved"); }
      catch { setSaveState("error"); }
    }
    move(1);
  };
  const quickKeep = async (photoId: string) => {
    setRejectedIds((prev) => { const next = new Set(prev); next.delete(photoId); return next; });
    setSaveState("saving");
    try { await onRate([photoId], 1); setSaveState("saved"); }
    catch { setSaveState("error"); }
    move(1);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (overviewOpen) { if (event.key === "Escape") { event.preventDefault(); setOverviewOpen(false); } return; }
      if (isEditableTarget(event.target)) return;
      const s = preferences.shortcuts;
      if ((event.key === " " || event.code === "Space") && !event.repeat && focused !== undefined) {
        event.preventDefault();
        clearTimeout(spaceTimer.current);
        spaceTimer.current = setTimeout(() => {
          setInspectActual(false); setInspectZoom(1); setInspectOrigin({ x: 0.5, y: 0.5 }); setInspectSrc(thumbnailUrl(focused.id, 2048)); setInspecting(true);
          const img = new Image(); img.src = thumbnailUrl(focused.id, 4096); img.onload = () => setInspectSrc(thumbnailUrl(focused.id, 4096));
        }, 200);
        return;
      }
      if (event.key === "ArrowRight") { event.preventDefault(); move(1); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); return; }
      if (focusedId !== undefined) {
        const rates: Record<string, Rating> = { [s.rate1]: 1, [s.rate2]: 2, [s.rate3]: 3, [s.rate4]: 4, [s.rate5]: 5 };
        const rating = rates[event.key];
        if (rating !== undefined) { event.preventDefault(); void rate(focusedId, rating); }
      }
      if (focusedId !== undefined) {
        const key = event.key.toLocaleLowerCase("en-US");
        if (key === s.reject && !event.metaKey && !event.ctrlKey) { event.preventDefault(); toggleReject(focusedId); return; }
        if (key === "x" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void quickKeep(focusedId); return; }
      }
      if (event.key.toLocaleLowerCase("en-US") === "z" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); clearTimeout(undoRef.current); setUndoToast(true); undoRef.current = setTimeout(() => setUndoToast(false), 1800); void onUndo(); }
    };
    const release = (event: KeyboardEvent) => {
      if (event.key === " " || event.code === "Space") {
        clearTimeout(spaceTimer.current);
        if (inspecting) { setInspecting(false); return; }
        if (focusedId !== undefined && ids.length > 1) move(1);
      }
    };
    const cancelInspect = () => setInspecting(false);
    const hidden = () => { if (document.hidden) setInspecting(false); };
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", release); window.addEventListener("blur", cancelInspect); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", release); window.removeEventListener("blur", cancelInspect); document.removeEventListener("visibilitychange", hidden); };
  });

  return <div className="immersive-shell">
    <header className="immersive-topbar">
      <button type="button" className="brand-button" aria-label="返回咔咔选首页" onClick={onHome}><BrandMark /></button>
      <div className="group-status">{overviewOpen ? <span>{albumName} · 所有组</span> : <><button type="button" aria-label="上一组" disabled={groupIndex === 0} onClick={() => jumpGroup(-1)}>‹</button><button type="button" className="group-overview-trigger" aria-label="所有组" onClick={() => setOverviewOpen(true)}>{albumName} · 第 {groupIndex + 1} / {album.groups.length} 组 <small>所有组⌄</small></button><button type="button" aria-label="下一组" disabled={groupIndex === album.groups.length - 1} onClick={() => jumpGroup(1)}>›</button></>}</div>
      <span className={`save-status${undoToast ? " is-undo" : ""} is-${saveState}`} role="status">{undoToast ? "已撤销 ↩" : saveState === "saving" ? "正在保存" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败" : `第 ${groupIndex + 1}/${totalGroups} 组 (${groupPct}%) · ${rated} 张已评分`}</span>
      <div className="filter-switch" role="radiogroup" aria-label="筛选照片">
        {(["all", "unprocessed", "picked", "rejected"] as const).map((mode) => (
          <button type="button" key={mode} role="radio" aria-checked={filterMode === mode} aria-pressed={filterMode === mode} onClick={() => setFilterMode(mode)}>
            {mode === "all" ? "全部" : mode === "unprocessed" ? "待处理" : mode === "picked" ? "已选" : "已淘汰"}
          </button>
        ))}
      </div>
      <button type="button" className="settings-button" aria-label="设置" onClick={() => setSettingsOpen(true)}>⚙</button>
      <button type="button" className="finish-button" onClick={() => setCompleting(true)}>导出评分…</button>
    </header>
    {error === undefined ? null : <p role="alert" className="immersive-error">{error}</p>}
    <ScanWarnings warnings={warnings} />
    <main className={`immersive-main${overviewOpen ? " overview-main" : ""}`}>
      {overviewOpen ? <GroupOverview albumName={albumName} currentGroupId={currentGroup?.id} groups={album.groups} photosById={byId} onBack={() => setOverviewOpen(false)} onSelectGroup={selectGroup} /> : emptyFilter ? <div className="empty-grid"><strong>{aiEmpty ? "未检测到 AI 数据" : aiNoData ? "未发现问题照片" : "当前筛选无结果"}</strong><span>{aiEmpty ? "请重新扫描照片文件夹以启用 AI 检测" : "所有照片都已通过 AI 检查"}</span><button type="button" onClick={() => setFilterMode("all")}>显示全部</button></div> : <><PhotoStage photos={photos} focusedId={effectiveFocusedId} photosPerPage={preferences.photosPerPage} rejectedIds={rejectedIds} autoRejectIds={autoRejectIds} onFocus={setFocusedId} onRate={rate} /><Filmstrip photos={photos} focusedId={effectiveFocusedId} visibleIds={visibleIds} rejectedIds={rejectedIds} onFocus={setFocusedId} /><div className="immersive-hints"><span>← → 浏览</span><span>Z 淘汰/恢复</span><span>X 保留</span><span>2-5 高分</span><span>Space 前进/放大</span></div></>}
    </main>
    {inspecting && focused !== undefined ? <section className={`hold-inspect${inspectActual ? " actual-size" : ""}`} role="region" aria-label={`${focused.stem} 100% 查看`}
      onClick={(e) => { if (e.target === e.currentTarget) { const rect = e.currentTarget.getBoundingClientRect(); setInspectOrigin({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }); setInspectZoom((prev) => (prev >= 2 ? 1 : 2)); } }}
      onDoubleClick={() => { setInspectZoom(1); setInspectActual(false); setInspectOrigin({ x: 0.5, y: 0.5 }); }}
      onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setInspectZoom((prev) => Math.max(0.5, Math.min(8, prev - e.deltaY * 0.005))); } }}>
      <img src={inspectSrc ?? thumbnailUrl(focused.id, 2048)} alt=""
        style={inspectZoom !== 1 || inspectActual ? { transform: `scale(${inspectZoom})`, transformOrigin: `${inspectOrigin.x * 100}% ${inspectOrigin.y * 100}%`, cursor: inspectZoom > 1 ? "zoom-out" : "zoom-in" } : { cursor: "zoom-in" }} />
      <span>{inspectActual ? "点击适配屏幕 · 松开空格返回" : inspectZoom > 1 ? `Ctrl+滚轮 ${inspectZoom.toFixed(1)}x · 双击还原` : "点击放大 · Ctrl+滚轮缩放 · 松开空格返回"}</span>
    </section> : null}
    {settingsOpen && currentGroup !== undefined ? <CullingSettings canMerge={groupIndex < album.groups.length - 1} canUndo={album.history.length > 0} focused={focusedId !== undefined} preferences={preferences} sensitivity={sensitivity} onClose={() => setSettingsOpen(false)} onPreferences={savePreferences} onSensitivity={(value) => { setSensitivity(value); void onSensitivity(value); }} onSplit={() => { if (focusedId !== undefined) void onSplit(focusedId); }} onMerge={() => void onMerge(currentGroup.id)} onUndo={() => void onUndo()} /> : null}
    {completing ? <section className="completion-layer" role="dialog" aria-modal="true" aria-label="评分结果"><div ref={() => { setTimeout(() => confetti(40), 200); }} /><div className="completion-card"><button type="button" className="completion-close" aria-label="返回选片" onClick={() => setCompleting(false)}>×</button><p className="eyebrow">评分结果</p><h1>{album.photos.filter((photo) => photo.rating >= 1).length} 张入选照片</h1><p>共 {album.photos.length} 张 · 已评分 {rated} 张</p><ExportPanel isDemo={album.isDemo} album={album} /></div></section> : null}
  </div>;
}
