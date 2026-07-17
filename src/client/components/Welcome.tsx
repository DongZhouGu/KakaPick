import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { OpenAlbumRequest, RecentAlbumSummary } from "../../shared/api.js";
import { getRecentAlbums, pickDirectory } from "../api.js";
import { BrandMark } from "./BrandMark.js";

interface WelcomeProps {
  readonly busy: boolean;
  readonly error?: string;
  readonly onOpen: (input: OpenAlbumRequest, displayName?: string) => Promise<void>;
}

function displayNameForPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.at(-1) ?? "本地相册";
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(iso));
}

export function Welcome({ busy, error, onOpen }: WelcomeProps) {
  const [path, setPath] = useState("");
  const [pickerError, setPickerError] = useState<string>();
  const [recentAlbums, setRecentAlbums] = useState<readonly RecentAlbumSummary[]>([]);

  const refreshRecent = useCallback(() => {
    void getRecentAlbums().then(setRecentAlbums).catch(() => setRecentAlbums([]));
  }, []);
  useEffect(() => { refreshRecent(); }, [refreshRecent]);

  const chooseFolder = async () => {
    setPickerError(undefined);
    try {
      const selection = await pickDirectory();
      await onOpen({ selectionId: selection.selectionId }, selection.name);
      refreshRecent();
    } catch (cause) {
      setPickerError(cause instanceof Error ? cause.message : "无法打开文件夹选择器。");
    }
  };

  const openRecent = async (album: RecentAlbumSummary) => {
    await onOpen({ recentId: album.id }, album.name);
    refreshRecent();
  };

  const removeRecent = async (id: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const token = sessionStorage.getItem("burstpick-token");
    if (token !== null) {
      await fetch("/api/v1/albums/recent/remove", { method: "POST", headers: { "content-type": "application/json", "x-burstpick-token": token }, body: JSON.stringify({ id }) });
    }
    refreshRecent();
  };

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    const value = path.trim();
    if (value !== "") void onOpen({ path: value }, displayNameForPath(value));
  };

  const hasRecent = recentAlbums.length > 0;

  return (
    <main className="welcome-shell">
      <section className="welcome-card">
        <BrandMark className="welcome-brand" />
        <h1 id="welcome-title">拍得多，也能选得快。</h1>
        <p className="welcome-copy">连拍自动成组，并排看清差异，快速完成评分、淘汰与导出。</p>

        {hasRecent && (
          <section className="recent-albums" aria-label="最近打开">
            <h2>最近打开</h2>
            <div className="recent-dashboard">
              {recentAlbums.map((album) => (
                <button type="button" key={album.id} className="recent-card" disabled={busy} onClick={() => void openRecent(album)}>
                  <span className="recent-card-name">{album.name}</span>
                  {album.photoCount > 0 ? <span className="recent-card-stats">{album.photoCount} 张 · {album.ratedCount} 已评分</span> : null}
                  <span className="recent-card-time">{relativeTime(album.lastOpenedAt)}</span>
                  <span className="recent-card-delete" aria-label={`移除 ${album.name}`} onClick={(e) => void removeRecent(album.id, e)}>×</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="welcome-actions">
          <button className="primary-button" type="button" disabled={busy} onClick={() => void chooseFolder()}>
            选择照片文件夹
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void onOpen({ demo: true }, "示例相册")}>
            体验示例相册
          </button>
        </div>

        {hasRecent ? (
          <details className="manual-toggle">
            <summary>或手动输入路径…</summary>
            <form className="manual-form" onSubmit={submitPath}>
              <label htmlFor="album-path">照片文件夹路径</label>
              <div>
                <input id="album-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="粘贴照片文件夹路径" />
                <button type="submit" disabled={busy || path.trim() === ""}>打开</button>
              </div>
            </form>
          </details>
        ) : (
          <>
            <div className="manual-divider"><span>或手动输入路径</span></div>
            <form className="manual-form" onSubmit={submitPath}>
              <label htmlFor="album-path">照片文件夹路径</label>
              <div>
                <input id="album-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="粘贴照片文件夹路径" />
                <button type="submit" disabled={busy || path.trim() === ""}>打开</button>
              </div>
            </form>
          </>
        )}

        {busy && <p role="status" className="inline-status">正在准备相册…</p>}
        {(pickerError ?? error) !== undefined && <p role="alert" className="error-banner">{pickerError ?? error}</p>}
        <p className="privacy-note">不上传照片 · 不改 RAW · 仅本机</p>
      </section>
    </main>
  );
}
