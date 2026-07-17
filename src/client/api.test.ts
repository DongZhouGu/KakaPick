// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelCopyExport, cancelMetadataExportJob, getAlbum, openAlbum, previewCopyExport, ratePhoto, startMetadataExportJob, subscribeAlbum, subscribeCopyExport, subscribeMetadataExportJob, thumbnailSrcSet } from "./api.js";

const album = {
  schemaVersion: 1, isDemo: false, sourcePathHash: "x", inventoryFingerprint: "x", boundaryOverrides: [], photos: [], groups: [],
  groupingSensitivity: 1, history: [], rejectedIds: [], updatedAt: "2026-07-11T00:00:00.000Z",
};

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe("client API validation", () => {
  it("starts, validates, and cancels metadata export jobs", async () => {
    sessionStorage.setItem("burstpick-token", "a".repeat(64));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { jobId: "b".repeat(32) } }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { accepted: true } }), { status: 202 }));

    const started = await startMetadataExportJob();
    await cancelMetadataExportJob(started.jobId);

    expect(started.jobId).toBe("b".repeat(32));
    expect(new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost").pathname).toBe("/api/v1/exports/metadata/jobs");
    expect(new URL(fetchMock.mock.calls[1]![0] as string, "http://localhost").pathname).toContain(`/metadata/jobs/${"b".repeat(32)}/cancel`);
  });

  it("validates metadata job progress and terminal events", () => {
    class FakeEventSource extends EventTarget {
      static latest?: FakeEventSource;
      constructor(readonly url: string) { super(); FakeEventSource.latest = this; }
      close = vi.fn();
      emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ data }) })); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onProgress = vi.fn();
    const onTerminal = vi.fn();
    subscribeMetadataExportJob("b".repeat(32), { onProgress, onTerminal, onError: vi.fn() });

    FakeEventSource.latest?.emit("progress", { phase: "writing", completed: 5, total: 10, relativePath: "IMG.xmp" });
    FakeEventSource.latest?.emit("terminal", { status: "cancelled" });

    expect(onProgress).toHaveBeenCalledWith({ phase: "writing", completed: 5, total: 10, relativePath: "IMG.xmp" });
    expect(onTerminal).toHaveBeenCalledWith({ status: "cancelled" });
    expect(FakeEventSource.latest?.close).toHaveBeenCalledOnce();
  });

  it("rejects impossible metadata progress counts", () => {
    class FakeEventSource extends EventTarget { static latest?: FakeEventSource; constructor() { super(); FakeEventSource.latest = this; } close = vi.fn(); }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onError = vi.fn();
    subscribeMetadataExportJob("b".repeat(32), { onProgress: vi.fn(), onTerminal: vi.fn(), onError });
    FakeEventSource.latest?.dispatchEvent(new MessageEvent("progress", { data: JSON.stringify({ data: { phase: "writing", completed: 11, total: 10 } }) }));
    expect(onError).toHaveBeenCalledWith("导出进度数据无效。");
  });
  it("previews copy export without a destination selection token", async () => {
    sessionStorage.setItem("burstpick-token", "a".repeat(64));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: {
      confirmationId: "b".repeat(64), destinationName: "新疆婚礼-精选", isDemo: false, items: [],
      counts: { copy: 0, skip: 0, conflicts: 0 }, totalBytes: 0, requiredBytes: 0,
    } }), { status: 200, headers: { "content-type": "application/json" } }));

    await previewCopyExport(2);

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ minRating: 2 });
  });
  it("builds encoded responsive thumbnail candidates", () => {
    expect(thumbnailSrcSet("a/b")).toContain("/a%2Fb/thumbnail?width=3200&height=3200 3200w");
    expect(thumbnailSrcSet("a/b").split(", ")).toHaveLength(4);
  });
  it("adds the token to mutations and validates their exact envelopes", async () => {
    sessionStorage.setItem("burstpick-token", "a".repeat(64));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { albumId: "demo", status: "ready", warnings: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { album, photo: { bad: true } } }), { status: 200 }));
    await openAlbum({ demo: true });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-burstpick-token")).toBe("a".repeat(64));
    await expect(ratePhoto("p1", 4)).rejects.toThrow("服务返回了无法识别的响应");
  });

  it("fails safely in Chinese for malformed success and error envelopes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { albumId: "demo", album, warnings: [], extra: true } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "BOGUS", message: "oops" } }), { status: 400 }));
    await expect(getAlbum("demo")).rejects.toThrow("服务返回了无法识别的响应");
    await expect(openAlbum({ demo: true })).rejects.toThrow("服务返回了无法识别的响应");
  });

  it("never adds the mutation token to read requests", async () => {
    sessionStorage.setItem("burstpick-token", "b".repeat(64));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { albumId: "demo", album, warnings: [] } }), { status: 200 }),
    );
    await getAlbum("demo");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("x-burstpick-token")).toBe(false);
  });

  it("closes EventSource for named and generic terminal errors", () => {
    class FakeEventSource extends EventTarget {
      static CLOSED = 2;
      static instances: FakeEventSource[] = [];
      readyState = 0;
      constructor() {
        super();
        FakeEventSource.instances.push(this);
      }
      close = vi.fn(() => { this.readyState = 2; });
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onError = vi.fn();
    subscribeAlbum("demo", { onComplete: vi.fn(), onProgress: vi.fn(), onError });
    const named = FakeEventSource.instances[0];
    named?.dispatchEvent(new MessageEvent("error", { data: JSON.stringify({ data: { code: "SCAN_FAILED", message: "坏照片" } }) }));
    expect(named?.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenLastCalledWith("坏照片");

    subscribeAlbum("demo-2", { onComplete: vi.fn(), onProgress: vi.fn(), onError });
    const generic = FakeEventSource.instances[1];
    generic?.dispatchEvent(new Event("error"));
    expect(generic?.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenLastCalledWith("扫描连接失败，请重新打开相册。");
  });

  it("validates completion envelopes before advancing and closes every terminal stream", () => {
    class FakeEventSource extends EventTarget {
      static instances: FakeEventSource[] = [];
      constructor() { super(); FakeEventSource.instances.push(this); }
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const events = { onComplete: vi.fn(), onProgress: vi.fn(), onError: vi.fn() };
    subscribeAlbum("bad-progress", events);
    FakeEventSource.instances[0]?.dispatchEvent(new MessageEvent("progress", { data: "{}" }));
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledWith("扫描进度数据无效，请重新打开相册。");

    subscribeAlbum("done", events);
    FakeEventSource.instances[1]?.dispatchEvent(new MessageEvent("complete", {
      data: JSON.stringify({ data: { albumId: "done", status: "ready", warnings: [] } }),
    }));
    expect(FakeEventSource.instances[1]?.close).toHaveBeenCalledOnce();
    expect(events.onComplete).toHaveBeenCalledOnce();

    subscribeAlbum("malformed-complete", events);
    FakeEventSource.instances[2]?.dispatchEvent(new MessageEvent("complete", {
      data: JSON.stringify({ data: { albumId: "malformed-complete", status: "ready", warnings: [], extra: true } }),
    }));
    expect(FakeEventSource.instances[2]?.close).toHaveBeenCalledOnce();
    expect(events.onComplete).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledTimes(2);
    expect(events.onError).toHaveBeenLastCalledWith("扫描完成数据无效，请重新打开相册。");

    subscribeAlbum("empty-complete", events);
    FakeEventSource.instances[3]?.dispatchEvent(new Event("complete"));
    expect(FakeEventSource.instances[3]?.close).toHaveBeenCalledOnce();
    expect(events.onComplete).toHaveBeenCalledOnce();
    expect(events.onError).toHaveBeenCalledTimes(3);
    expect(events.onError).toHaveBeenLastCalledWith("扫描完成数据无效，请重新打开相册。");

    const cleanup = subscribeAlbum("cancelled", events);
    cleanup();
    expect(FakeEventSource.instances[4]?.close).toHaveBeenCalledOnce();
  });

  it("validates copy progress and terminal SSE and authenticates cancellation", async () => {
    class FakeEventSource extends EventTarget {
      static instances: FakeEventSource[] = [];
      constructor() { super(); FakeEventSource.instances.push(this); }
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const events = { onProgress: vi.fn(), onTerminal: vi.fn(), onError: vi.fn() };
    subscribeCopyExport("d".repeat(32), events);
    FakeEventSource.instances[0]?.dispatchEvent(new MessageEvent("progress", { data: JSON.stringify({ data: { completed: 1, total: 2, bytesCompleted: 3, totalBytes: 4, relativePath: "day/one.jpg", status: "copied" } }) }));
    expect(events.onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 1, relativePath: "day/one.jpg" }));
    FakeEventSource.instances[0]?.dispatchEvent(new Event("error"));
    expect(events.onError).toHaveBeenCalledWith("复制进度连接暂时中断，正在重连。");
    expect(FakeEventSource.instances[0]?.close).not.toHaveBeenCalled();
    FakeEventSource.instances[0]?.dispatchEvent(new MessageEvent("terminal", { data: JSON.stringify({ data: { status: "complete", reportId: "e".repeat(32), cancelled: false } }) }));
    expect(events.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ reportId: "e".repeat(32) }));
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();

    sessionStorage.setItem("burstpick-token", "a".repeat(64));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { accepted: true } }), { status: 202 }));
    await cancelCopyExport("d".repeat(32));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-burstpick-token")).toBe("a".repeat(64));
  });
});
