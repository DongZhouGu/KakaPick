// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAlbum } from "./use-album.js";

const photo = (id: string, rating = 0) => ({
  id, stem: id, jpeg: { kind: "jpeg" as const, relativePath: `${id}.jpg`, size: 1, modifiedAtMs: 1 },
  capturedAtMs: 1, captureTimeSource: "exif" as const, rating,
});
const album = (first = 0, second = 0, isDemo = false) => ({
  schemaVersion: 1 as const, isDemo, sourcePathHash: "x", inventoryFingerprint: "x",
  boundaryOverrides: [],
  photos: [photo("p1", first), photo("p2", second)], groups: [{ id: "g1", photoIds: ["p1", "p2"], startedAtMs: 1, endedAtMs: 1, confidence: 1, manual: false }],
  groupingSensitivity: 1, history: [], rejectedIds: [], updatedAt: "2026-07-11T00:00:00.000Z",
});
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe("useAlbum ratings", () => {
  async function readyController() {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(envelope({ data: { albumId: "demo", status: "ready", warnings: [] } }))
      .mockResolvedValueOnce(envelope({ data: { albumId: "demo", album: album(0, 0, true), warnings: [] } }));
    const hook = renderHook(() => useAlbum());
    await act(() => hook.result.current.open({ demo: true }, "示例相册"));
    return hook;
  }

  it("rolls back every optimistic rating when the first request fails", async () => {
    const hook = await readyController();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(envelope({ error: { code: "INTERNAL_ERROR", message: "保存失败" } }, 500));
    await act(() => hook.result.current.rate(["p1", "p2"], 5));
    await waitFor(() => {
      expect(hook.result.current.album?.photos.map(({ rating }) => rating)).toEqual([0, 0]);
      expect(hook.result.current.error).toContain("未提交的评分已恢复");
    });
  });

  it("uses one atomic batch request and rolls back the whole optimistic selection", async () => {
    const hook = await readyController();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      envelope({ data: { album: album(4, 4), warnings: [] } }),
    );
    await act(() => hook.result.current.rate(["p1", "p2"], 4));
    await waitFor(() => expect(hook.result.current.album?.photos.map(({ rating }) => rating)).toEqual([4, 4]));
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[2]?.[1]?.body))).toEqual({ photoIds: ["p1", "p2"], rating: 4 });
  });

  it("keeps a real picker album named 示例相册 authoritative and non-demo", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(envelope({ data: { albumId: "b".repeat(64), status: "ready", warnings: [] } }))
      .mockResolvedValueOnce(envelope({ data: { albumId: "b".repeat(64), album: album(), warnings: [] } }));
    const hook = renderHook(() => useAlbum());
    await act(() => hook.result.current.open({ selectionId: "a".repeat(32) }, "示例相册"));
    expect(hook.result.current.albumName).toBe("示例相册");
    expect(hook.result.current.album?.isDemo).toBe(false);
  });
});
