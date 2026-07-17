import { useState } from "react";
import type { PublicAlbumSession } from "../shared/api.js";
import { bootstrapToken } from "./api.js";
import { CullingWorkspace } from "./components/CullingWorkspace.js";
import { BrandMark } from "./components/BrandMark.js";
import { Welcome } from "./components/Welcome.js";
import { useAlbum } from "./use-album.js";

interface AppProps {
  readonly initialView?: "welcome" | "workspace";
}

const WORKSPACE_FIXTURE: PublicAlbumSession = {
  schemaVersion: 1,
  isDemo: false,
  sourcePathHash: "fixture",
  inventoryFingerprint: "fixture",
  boundaryOverrides: [],
  photos: [{
    id: "fixture-photo",
    stem: "示例照片",
    jpeg: { kind: "jpeg", relativePath: "fixture.jpg", size: 1, modifiedAtMs: 1 },
    capturedAtMs: 1,
    captureTimeSource: "exif",
    rating: 0,
  }],
  groups: [{ id: "fixture-group", photoIds: ["fixture-photo"], startedAtMs: 1, endedAtMs: 1, confidence: 1, manual: false }],
  groupingSensitivity: 1.05,
  history: [], rejectedIds: [],
  updatedAt: "2026-07-11T00:00:00.000Z",
};

const PHASE_LABELS = {
  inventory: "正在清点照片",
  metadata: "正在读取拍摄信息",
  hashing: "正在分析画面相似度",
  grouping: "正在整理连拍分组",
} as const;

export function App({ initialView = "welcome" }: AppProps) {
  useState(() => bootstrapToken());
  const controller = useAlbum();
  const album = controller.album ?? (initialView === "workspace" ? WORKSPACE_FIXTURE : undefined);
  const showWorkspace = album !== undefined && (controller.phase === "ready" || initialView === "workspace");
  if (!showWorkspace) {
    if (controller.phase === "scanning") {
      const progress = controller.progress;
      const percent = progress === undefined || progress.total === 0 ? 0 : Math.round(progress.completed / progress.total * 100);
      return (
        <main className="state-screen">
          <BrandMark showName={false} className="state-brand" />
          <div className="scan-visual" aria-hidden="true"><span /><span /><span /></div>
          <p className="eyebrow">建立本地相册</p>
          <h1>{progress === undefined ? "正在启动扫描" : PHASE_LABELS[progress.phase]}</h1>
          <progress max={100} value={percent}>{percent}%</progress>
          <p role="status">{progress === undefined ? "等待第一批照片…" : `${progress.completed} / ${progress.total} · ${percent}%`}</p>
          <button type="button" className="cancel-button" onClick={controller.reset}>取消</button>
        </main>
      );
    }
    return <Welcome busy={controller.phase === "opening"} {...(controller.error === undefined ? {} : { error: controller.error })} onOpen={controller.open} />;
  }

  if (album.photos.length === 0) {
    return (
      <main className="state-screen empty-album">
        <BrandMark showName={false} className="state-brand" />
        <p className="eyebrow">相册已打开</p>
        <h1>这里还没有可浏览的照片</h1>
        <p>请选择包含 RAW、JPEG 或两者配对文件的文件夹。</p>
        <button type="button" className="primary-button" onClick={controller.reset}>选择其他文件夹</button>
      </main>
    );
  }

  return <CullingWorkspace
    album={album}
    albumName={controller.albumName ?? "示例相册"}
    {...(controller.error === undefined ? {} : { error: controller.error })}
    onHome={controller.reset}
    onRate={controller.rate}
    onMerge={controller.merge}
    onSplit={controller.split}
    onUndo={controller.undo}
    onSensitivity={controller.setSensitivity}
    warnings={controller.warnings}
  />;
}
