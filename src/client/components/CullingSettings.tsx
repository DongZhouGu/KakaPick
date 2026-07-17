import { useEffect, useState } from "react";
import type { CullingPreferences, PhotosPerPage, ShortcutBindings } from "../culling-preferences.js";
import { DEFAULT_SHORTCUTS } from "../culling-preferences.js";

interface CullingSettingsProps {
  readonly canMerge: boolean;
  readonly canUndo: boolean;
  readonly focused: boolean;
  readonly onClose: () => void;
  readonly onMerge: () => void;
  readonly onPreferences: (preferences: CullingPreferences) => void;
  readonly onSensitivity: (value: number) => void;
  readonly onSplit: () => void;
  readonly onUndo: () => void;
  readonly preferences: CullingPreferences;
  readonly sensitivity: number;
}

export function CullingSettings({ canMerge, canUndo, focused, onClose, onMerge, onPreferences, onSensitivity, onSplit, onUndo, preferences, sensitivity }: CullingSettingsProps) {
  const [draftSensitivity, setDraftSensitivity] = useState(sensitivity);
  const [rebinding, setRebinding] = useState<string | null>(null);
  useEffect(() => {
    if (!rebinding) return;
    const capture = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); const key = e.key === " " ? " " : e.key.length === 1 ? e.key.toLocaleLowerCase("en-US") : e.key; onPreferences({ ...preferences, shortcuts: { ...preferences.shortcuts, [rebinding]: key } }); setRebinding(null); };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [rebinding, onPreferences, preferences]);
  useEffect(() => {
    if (rebinding) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, rebinding]);

  const shortcutLabel = (action: keyof ShortcutBindings) => {
    const key = preferences.shortcuts[action];
    return key === " " ? "Space" : key.toUpperCase();
  };

  const shortcutDesc = (action: keyof ShortcutBindings) => {
    const labels: Record<keyof ShortcutBindings, string> = { reject: "淘汰 / 恢复", rate1: "1 星", rate2: "2 星", rate3: "3 星", rate4: "4 星", rate5: "5 星" };
    return labels[action];
  };

  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="sheet-header"><h2 id="settings-title">设置</h2><button type="button" className="sheet-close" onClick={onClose}>完成</button></header>
      <div className="settings-scroll">

        <section className="settings-section"><h3>浏览</h3><div className="settings-group">
          <div className="settings-row settings-row-stacked"><span>每屏照片数</span><div className="ios-segment" style={{gridTemplateColumns: "repeat(5,1fr)"}} aria-label="每屏照片数">{([1, 2, 3, 4, "auto"] as const).map((v) => <button type="button" key={String(v)} aria-label={v === "auto" ? "自适应" : `${v} 张`} aria-pressed={preferences.photosPerPage === v} onClick={() => onPreferences({ ...preferences, photosPerPage: v as PhotosPerPage })}>{v === "auto" ? "适应" : v}</button>)}</div></div>
          <label className="settings-row"><span><strong>评分后自动前进</strong><small>评分后自动聚焦下一张</small></span><input className="ios-switch" aria-label="评分后自动前进" type="checkbox" checked={preferences.advanceAfterRating} onChange={(e) => onPreferences({ ...preferences, advanceAfterRating: e.target.checked })} /></label>
        </div></section>

        <section className="settings-section"><h3>AI 筛选</h3><div className="settings-group">
          <label className="settings-row"><span><strong>自动标记问题照片</strong><small>标记模糊、过曝、欠曝的照片建议淘汰</small></span><input className="ios-switch" aria-label="启用 AI 筛选" type="checkbox" checked={preferences.showAiHint} onChange={(e) => onPreferences({ ...preferences, showAiHint: e.target.checked })} /></label>
        </div></section>

        <section className="settings-section"><h3>连拍分组</h3><div className="settings-group">
          <label className="settings-row settings-row-stacked"><span className="range-heading"><strong>分组范围</strong><output>{draftSensitivity.toFixed(2)}</output></span><input aria-label="分组范围" type="range" min="0.5" max="2" step="0.05" value={draftSensitivity} onChange={(e) => { const v = Number(e.target.value); setDraftSensitivity(v); onSensitivity(v); }} /><span className="range-labels"><small>严格</small><small>宽松</small></span></label>
          <button type="button" className="settings-action" aria-label="拆分" disabled={!focused} onClick={onSplit}>在当前照片前拆分<span>›</span></button>
          <button type="button" className="settings-action" aria-label="合并" disabled={!canMerge} onClick={onMerge}>与下一组合并<span>›</span></button>
          <button type="button" className="settings-action" aria-label="撤销" disabled={!canUndo} onClick={onUndo}>撤销最近操作<span>↶</span></button>
        </div></section>

        <section className="settings-section"><h3>快捷键</h3><div className="settings-group">
          {(Object.keys(DEFAULT_SHORTCUTS) as (keyof ShortcutBindings)[]).map((action) => (
            <div className="settings-row" key={action}>
              <span>{shortcutDesc(action)}</span>
              <button type="button" className={`shortcut-key${rebinding === action ? " is-rebinding" : ""}`} aria-label={`修改 ${shortcutDesc(action)} 快捷键`} onClick={() => setRebinding(rebinding === action ? null : action)}>
                {rebinding === action ? "按下新键…" : shortcutLabel(action)}
              </button>
            </div>
          ))}
          <div className="settings-row">
            <span>撤销</span><kbd>⌘ Z</kbd>
          </div>
          <div className="settings-row">
            <span>上一组 / 下一组</span><kbd>[ ]</kbd>
          </div>
          <div className="settings-row">
            <span>拆分 / 合并</span><kbd>S · M</kbd>
          </div>
        </div></section>

        <section className="settings-section"><h3>数据</h3><div className="settings-note"><strong>评分自动保存在本机</strong><p>点击右上角"导出评分…"后，可选择写入 Lightroom 星级或直接复制入选照片到指定文件夹。</p></div></section>

      </div>
    </section>
  </div>;
}
