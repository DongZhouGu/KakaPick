// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicAlbumSession } from "../../shared/api.js";
import { CullingWorkspace } from "./CullingWorkspace.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, reject, resolve };
}

const album: PublicAlbumSession = {
  schemaVersion: 1, isDemo: true, sourcePathHash: "x", inventoryFingerprint: "x", boundaryOverrides: [], groupingSensitivity: 1,
  photos: ["p1", "p2", "p3"].map((id, index) => ({ id, stem: `DSC_000${index + 1}`, jpeg: { kind: "jpeg", relativePath: `${id}.jpg`, size: 1, modifiedAtMs: 1 }, capturedAtMs: index, captureTimeSource: "exif", rating: 0 })),
  groups: [{ id: "g1", photoIds: ["p1", "p2", "p3"], startedAtMs: 1, endedAtMs: 3, confidence: 1, manual: false }],
  history: [], rejectedIds: [], updatedAt: "2026-07-12T00:00:00Z",
};
const groupedAlbum: PublicAlbumSession = {
  ...album,
  photos: [...album.photos, { id: "p4", stem: "DSC_0004", jpeg: { kind: "jpeg", relativePath: "p4.jpg", size: 1, modifiedAtMs: 1 }, capturedAtMs: 4, captureTimeSource: "exif", rating: 3 }],
  groups: [
    { id: "g1", photoIds: ["p1", "p2"], startedAtMs: 1, endedAtMs: 2, confidence: 1, manual: false },
    { id: "g2", photoIds: ["p4", "p3"], startedAtMs: 3, endedAtMs: 4, confidence: 1, manual: false },
  ],
};

afterEach(() => { cleanup(); localStorage.clear(); });

it("changes density from settings and advances after a successful independent rating", async () => {
  const user = userEvent.setup();
  const onRate = vi.fn().mockResolvedValue(undefined);
  render(<CullingWorkspace album={album} albumName="示例" onHome={vi.fn()} onRate={onRate} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  expect(screen.getByRole("button", { name: "返回咔咔选首页" })).toHaveTextContent("咔咔选");
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("button", { name: "1 张" }));
  await user.click(screen.getByRole("button", { name: "完成" }));
  expect(screen.getAllByRole("article")).toHaveLength(1);
  await user.keyboard("4");
  expect(onRate).toHaveBeenCalledWith(["p1"], 4);
  await waitFor(() => expect(screen.getByRole("button", { name: /聚焦 DSC_0002/u })).toBeInTheDocument());
});

it("can disable automatic advancement and exposes grouping in settings", async () => {
  const user = userEvent.setup();
  render(<CullingWorkspace album={album} albumName="示例" onHome={vi.fn()} onRate={vi.fn().mockResolvedValue(undefined)} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  expect(screen.queryByLabelText("分组范围")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(screen.getByRole("checkbox", { name: "评分后自动前进" }));
  await user.click(screen.getByRole("button", { name: "完成" }));
  await user.keyboard("3");
  expect(screen.getByRole("button", { name: /聚焦 DSC_0001/u })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByLabelText("分组范围")).toBeVisible();
});

it("shows immediate rating persistence progress and success", async () => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  render(<CullingWorkspace album={album} albumName="示例" onHome={vi.fn()} onRate={vi.fn(() => pending.promise)} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "将 DSC_0001 评为 4 星" }));
  expect(screen.getByRole("status")).toHaveTextContent("正在保存");
  pending.resolve();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存"));
});

it("shows a save failure without advancing", async () => {
  const user = userEvent.setup();
  render(<CullingWorkspace album={album} albumName="示例" onHome={vi.fn()} onRate={vi.fn().mockRejectedValue(new Error("nope"))} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "将 DSC_0001 评为 4 星" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存失败"));
  expect(screen.getByRole("button", { name: /聚焦 DSC_0001/u })).toBeInTheDocument();
});

it("opens the rating result with selection statistics", async () => {
  const user = userEvent.setup();
  const ratedAlbum = { ...album, photos: album.photos.map((photo, index) => ({ ...photo, rating: index === 0 ? 4 as const : 0 as const })) };
  render(<CullingWorkspace album={ratedAlbum} albumName="示例" onHome={vi.fn()} onRate={vi.fn()} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "导出评分…" }));
  expect(screen.getByRole("dialog", { name: "评分结果" })).toBeVisible();
  expect(screen.getByText("1 张入选照片")).toBeVisible();
  expect(screen.getByText("共 3 张 · 已评分 1 张")).toBeVisible();
});

it("enters hold-to-inspect after 200ms and uses progressive 2048 then 4096 sources", async () => {
  render(<CullingWorkspace album={album} albumName="示例" onHome={vi.fn()} onRate={vi.fn()} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  fireEvent.keyDown(window, { key: " ", code: "Space" });
  await new Promise((r) => setTimeout(r, 250));
  expect(screen.getByRole("region", { name: /100% 查看/u }).querySelector("img")).toHaveAttribute("src", expect.stringContaining("width=2048&height=2048"));
  fireEvent.keyUp(window, { key: " ", code: "Space" });
});

it("opens all groups and selects the first unrated photo in a chosen group", async () => {
  const user = userEvent.setup();
  render(<CullingWorkspace album={groupedAlbum} albumName="示例" onHome={vi.fn()} onRate={vi.fn()} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "所有组" }));
  expect(screen.getByRole("region", { name: "所有组" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /第 2 组/u }));
  expect(screen.getByText(/示例 · 第 2 \/ 2 组/u)).toBeVisible();
  expect(screen.getByRole("button", { name: /聚焦 DSC_0003/u })).toBeInTheDocument();
});

it("filters the current group to manually rejected photos", async () => {
  const user = userEvent.setup();
  render(<CullingWorkspace album={{ ...album, rejectedIds: ["p2"] }} albumName="示例" onHome={vi.fn()} onRate={vi.fn()} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);

  await user.click(screen.getByRole("radio", { name: "已淘汰" }));

  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(screen.getByRole("button", { name: /聚焦 DSC_0002/u })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /聚焦 DSC_0001/u })).not.toBeInTheDocument();
});

it("restores culling with Escape and suppresses hidden culling shortcuts", async () => {
  const user = userEvent.setup();
  const onRate = vi.fn();
  render(<CullingWorkspace album={groupedAlbum} albumName="示例" onHome={vi.fn()} onRate={onRate} onMerge={vi.fn()} onSplit={vi.fn()} onUndo={vi.fn()} onSensitivity={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "所有组" }));
  await user.keyboard("5{ArrowRight} ");
  expect(onRate).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: /100% 查看/u })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "所有组" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /聚焦 DSC_0001/u })).toBeInTheDocument();
});
