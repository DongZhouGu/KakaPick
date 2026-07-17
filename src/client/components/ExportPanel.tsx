import { useEffect, useRef, useState } from "react";
import type { CopyExportPreparationProgress, CopyExportProgress, MetadataExportProgress, MetadataExportResult, PublicAlbumSession } from "../../shared/api.js";
import { confetti } from "../confetti.js";
import {
  cancelCopyExport,
  cancelCopyExportPreviewJob,
  cancelMetadataExportJob,
  commitCopyExport,
  copyReportDownloadUrl,
  latestMetadataRollback,
  startCopyExportPreviewJob,
  subscribeCopyExportPreview,
  rollbackMetadataExport,
  startMetadataExportJob,
  subscribeCopyExport,
  subscribeMetadataExportJob,
} from "../api.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type MinRating = 1 | 2 | 3 | 4 | 5;
type Phase = "idle" | "busy" | "done" | "error";

export function ExportPanel({ album }: { readonly isDemo?: boolean; readonly album?: PublicAlbumSession }) {
  const [message, setMessage] = useState<string>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [activePath, setActivePath] = useState<"copy" | "lr" | null>(null);

  // Copy export state
  const [copyMinRating, setCopyMinRating] = useState<MinRating>(1);
  const [copyProgress, setCopyProgress] = useState<CopyExportProgress>();
  const [copyPreparationProgress, setCopyPreparationProgress] = useState<CopyExportPreparationProgress>();
  const [copyPreviewJobId, setCopyPreviewJobId] = useState<string>();
  const [copyJobId, setCopyJobId] = useState<string>();
  const [copyReportId, setCopyReportId] = useState<string>();
  const [copyFolder, setCopyFolder] = useState<string>();
  const stopCopyEvents = useRef<(() => void) | undefined>(undefined);
  const stopCopyPreviewEvents = useRef<(() => void) | undefined>(undefined);
  const stopMetadataEvents = useRef<(() => void) | undefined>(undefined);

  // LR state
  const [lrResult, setLrResult] = useState<MetadataExportResult>();
  const [metadataJobId, setMetadataJobId] = useState<string>();
  const [metadataProgress, setMetadataProgress] = useState<MetadataExportProgress>();
  const [rollbackAvailable, setRollbackAvailable] = useState(false);
  const [cleanupWarnings, setCleanupWarnings] = useState<string[]>([]);

  useEffect(() => {
    let mounted = true;
    void latestMetadataRollback().then((v) => {
      if (mounted) { setRollbackAvailable(v.available); setCleanupWarnings(v.warnings ?? []); }
    }).catch(() => undefined);
    return () => { mounted = false; stopCopyEvents.current?.(); stopCopyPreviewEvents.current?.(); stopMetadataEvents.current?.(); };
  }, []);

  const matchingCount = album?.photos.filter((p) => p.rating >= copyMinRating).length ?? 0;

  // --- Copy path ---
  const startCopy = async () => {
    setActivePath("copy"); setPhase("busy"); setMessage("正在生成精选文件夹并分析…");
    setCopyPreparationProgress(undefined); setCopyProgress(undefined);
    try {
      const { jobId } = await startCopyExportPreviewJob(copyMinRating);
      setCopyPreviewJobId(jobId);
      stopCopyPreviewEvents.current?.();
      stopCopyPreviewEvents.current = subscribeCopyExportPreview(jobId, {
        onProgress(progress) { setCopyPreparationProgress(progress); setMessage(`正在检查入选照片 · ${progress.completed}/${progress.total}${progress.relativePath === undefined ? "" : ` · ${progress.relativePath}`}`); },
        onTerminal(terminal) {
          setCopyPreviewJobId(undefined);
          if (terminal.status === "cancelled") { setPhase("done"); setMessage("复制已取消。"); return; }
          if (terminal.status === "failed") { setPhase("error"); setMessage(terminal.message); return; }
          const preview = terminal.preview;
          setCopyFolder(preview.destinationName);
          if (preview.counts.copy === 0) { setMessage("没有需要复制的照片。"); setPhase("idle"); return; }
          if (preview.isDemo) { setMessage(`示例预览：${preview.counts.copy} 个文件可复制`); setPhase("idle"); return; }
          if (preview.confirmationId === undefined) { setMessage("无法开始复制。"); setPhase("error"); return; }
          setMessage(`正在复制 ${preview.counts.copy} 个文件到 ${preview.destinationName}…`);
          void commitCopyExport(preview.confirmationId).then(({ jobId: copyId }) => {
            setCopyJobId(copyId); setCopyPreparationProgress(undefined);
            stopCopyEvents.current?.();
            stopCopyEvents.current = subscribeCopyExport(copyId, {
              onProgress(progress) { setCopyProgress(progress); setMessage(`正在复制 · ${progress.completed}/${progress.total}${progress.relativePath === undefined ? "" : ` · ${progress.relativePath}`}`); },
              onTerminal(t) {
                setCopyJobId(undefined);
                if (t.status === "complete") { setCopyReportId(t.reportId); setPhase("done"); setMessage(t.cancelled ? "已取消" : `复制完成：${preview.counts.copy} 个文件`); }
                else { setPhase("error"); setMessage(t.message); }
              },
              onError: (m) => { setPhase("error"); setMessage(m); },
            });
          }).catch((cause) => { setPhase("error"); setMessage(cause instanceof Error ? cause.message : "复制失败"); });
        },
        onError: (m) => { setMessage(m); },
      });
    } catch (cause) { setPhase("error"); setMessage(cause instanceof Error ? cause.message : "复制失败"); }
  };

  // --- LR path ---
  const ratedCount = album?.photos.filter((p) => p.rating > 0).length ?? 0;
  const writeLR = async () => {
    setActivePath("lr"); setPhase("busy");
    setMessage(ratedCount > 0 ? `正在扫描 ${ratedCount} 张已评分照片…` : "正在扫描文件…");
    setMetadataProgress(undefined); setLrResult(undefined); setCleanupWarnings([]);
    try {
      const { jobId } = await startMetadataExportJob();
      setMetadataJobId(jobId);
      stopMetadataEvents.current?.();
      stopMetadataEvents.current = subscribeMetadataExportJob(jobId, {
        onProgress(progress) {
          setMetadataProgress(progress);
          const phaseLabel = progress.phase === "scanning" ? "正在扫描" : progress.phase === "writing" ? "正在写入 XMP" : "正在校验";
          setMessage(`${phaseLabel} · ${progress.completed}/${progress.total}${progress.relativePath === undefined ? "" : ` · ${progress.relativePath}`}`);
        },
        onTerminal(terminal) {
          setMetadataJobId(undefined);
          if (terminal.status === "complete") {
            const result = terminal.result;
            setLrResult(result); setCleanupWarnings(result.warnings ?? []); setRollbackAvailable(true); setPhase("done");
            setMessage(`写入完成：${result.written} 个，跳过 ${result.skipped}`);
          } else if (terminal.status === "cancelled") {
            setPhase("done"); setMessage("导出已取消，已恢复原文件。");
          } else if (terminal.status === "nochange") {
            setPhase("idle"); setMessage(terminal.message);
          } else {
            setPhase("error"); setMessage(terminal.message);
          }
        },
        onError(message) { setMessage(message); },
      });
    } catch (cause) { setPhase("error"); setMessage(cause instanceof Error ? cause.message : "写入失败"); }
  };

  const rollback = async () => {
    setPhase("busy"); setMessage("正在回滚…");
    try {
      const value = await rollbackMetadataExport();
      setLrResult(undefined); setRollbackAvailable(false);
      setCleanupWarnings(value.warnings ?? []);
      setPhase("done"); setMessage("已回滚。");
    } catch (cause) { setPhase("error"); setMessage(cause instanceof Error ? cause.message : "回滚失败"); }
  };

  const reset = () => { setPhase("idle"); setActivePath(null); setMessage(undefined); setCopyProgress(undefined); setCopyPreparationProgress(undefined); setCopyPreviewJobId(undefined); setCopyFolder(undefined); setCopyReportId(undefined); setMetadataProgress(undefined); setMetadataJobId(undefined); setLrResult(undefined); setCleanupWarnings([]); };

  if (phase === "busy") {
    const activeProgress = activePath === "lr" ? metadataProgress : (copyProgress ?? copyPreparationProgress);
    const pct = activeProgress && activeProgress.total > 0 ? Math.round(activeProgress.completed / activeProgress.total * 100) : 0;
    return (
      <div className="export-flow">
        <div className="export-progress">
          <div className="export-spinner" />
          <p className="export-status">{message}</p>
          {activeProgress ? <><progress value={pct} max={100} />{copyProgress && activePath === "copy" ? <span className="export-detail">{copyProgress.completed}/{copyProgress.total} · {formatBytes(copyProgress.bytesCompleted)}/{formatBytes(copyProgress.totalBytes)}</span> : null}</> : null}
          {copyJobId ? <button type="button" className="export-cancel" onClick={() => { void cancelCopyExport(copyJobId); }}>取消</button> : null}
          {copyPreviewJobId ? <button type="button" className="export-cancel" onClick={() => { void cancelCopyExportPreviewJob(copyPreviewJobId); }}>取消</button> : null}
          {metadataJobId ? <button type="button" className="export-cancel" onClick={() => { void cancelMetadataExportJob(metadataJobId); }}>取消</button> : null}
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="export-flow">
        <div ref={() => { setTimeout(() => confetti(), 100); }} />
        <div className="export-done">
          <span className="export-check">✓</span>
          <p className="export-done-title">导出完成</p>
          <p className="export-done-msg">{message}</p>
          {copyReportId ? <a href={copyReportDownloadUrl(copyReportId)} className="export-link">下载 JSON 报告</a> : null}
          {lrResult ? <div className="export-stats">{lrResult.written} 写入 · {lrResult.skipped} 跳过 · {lrResult.conflicts} 冲突 · {lrResult.errors} 错误</div> : null}
          {rollbackAvailable ? <button type="button" className="export-action" onClick={() => void rollback()}>回滚</button> : null}
          {cleanupWarnings.map((w) => <p key={w} className="export-warning">{w}</p>)}
          <button type="button" className="export-reset" onClick={reset}>完成</button>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="export-flow">
        <div className="export-error">
          <span className="export-x">!</span>
          <p>{message}</p>
          <button type="button" className="export-reset" onClick={reset}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="export-flow">
      {activePath === null ? (
        <div className="export-choices">
          <button type="button" className="export-choice" onClick={() => setActivePath("copy")}>
            <span className="export-choice-icon">📁</span>
            <strong>复制入选照片</strong>
            <small>无需 Lightroom，自动复制到相册旁的“相册名-精选”文件夹</small>
            {album ? <span className="export-choice-count">{matchingCount} 张可选</span> : null}
          </button>
          <button type="button" className="export-choice" onClick={() => void writeLR()}>
            <span className="export-choice-icon">⚡</span>
            <strong>写入 Lightroom 评分</strong>
            <small>将星级写入 XMP 附属文件。如照片已在 LR 中，请先关闭 Lightroom</small>
          </button>
        </div>
      ) : null}

      {/* Inline rating threshold for copy path */}
      {activePath === "copy" && phase === "idle" && (
        <div style={{ marginTop: 16 }}>
          <div className="rating-threshold" role="radiogroup" aria-label="最低评分">
            {([1,2,3,4,5] as const).map((r) => (
              <button key={r} role="radio" aria-pressed={copyMinRating === r} onClick={() => setCopyMinRating(r)}>{"★".repeat(r)}</button>
            ))}
          </div>
          <p className="live-count">{matchingCount} 张满足条件</p>
          <button type="button" className="export-action" style={{ marginTop: 10 }} onClick={() => void startCopy()}>
            {copyFolder ? `复制到 ${copyFolder}` : "复制到自动生成的精选文件夹"}
          </button>
        </div>
      )}

      {activePath !== null && message ? <p className="export-status" role="status">{message}</p> : null}
      {activePath !== null ? <button type="button" className="export-back" onClick={reset}>← 返回</button> : null}
    </div>
  );
}
