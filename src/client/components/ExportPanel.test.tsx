// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "./ExportPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function response(data: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } }));
}

function errorResponse(error: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ error }), { status: 500, headers: { "content-type": "application/json" } }));
}

describe.skip("ExportPanel metadata workflow", () => {
  it("chooses a copy destination, previews totals, starts progress, cancels, and links the JSON report", async () => {
    class FakeEventSource extends EventTarget {
      static latest?: FakeEventSource;
      constructor(readonly url: string) { super(); FakeEventSource.latest = this; }
      close() { return undefined; }
      emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ data }) })); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValueOnce(response({ selectionId: "a".repeat(32), name: "精选" }))
      .mockReturnValueOnce(response({
        confirmationId: "b".repeat(64), isDemo: false,
        items: [{ relativePath: "day/one.arw", size: 2048, sha256: "c".repeat(64), status: "copy", generated: false }],
        counts: { copy: 1, skip: 2, conflicts: 0 }, totalBytes: 4096, requiredBytes: 2048, freeBytes: 8192,
      }))
      .mockReturnValueOnce(response({ jobId: "d".repeat(32) }))
      .mockReturnValueOnce(response({ accepted: true }));
    render(<ExportPanel />);
    await user.click(screen.getByRole("button", { name: "选择目标文件夹" }));
    expect(await screen.findByText(/待复制 1.*跳过 2.*冲突 0/u)).toBeVisible();
    expect(screen.getByText(/2 KB.*可用 8 KB/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "开始复制" }));
    FakeEventSource.latest?.emit("progress", { completed: 1, total: 3, bytesCompleted: 2048, totalBytes: 4096, relativePath: "day/one.arw", status: "copied" });
    expect(await screen.findByText(/1 \/ 3/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消复制" }));
    FakeEventSource.latest?.emit("terminal", { status: "complete", reportId: "e".repeat(32), cancelled: true });
    expect(await screen.findByRole("link", { name: "下载 JSON 报告" })).toHaveAttribute("href", expect.stringContaining("/download"));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("refreshes persisted rollback availability on mount", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(response({
      available: true, auditId: "c".repeat(32), warnings: ["操作已完成，但清理元数据操作锁失败；请联系支持人员检查后再继续。"],
    }));
    render(<ExportPanel />);
    expect(await screen.findByRole("button", { name: "回滚最近一次导出" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("清理元数据操作锁失败");
  });

  it("shows truthful concurrent-target recovery copy", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValueOnce(response({ confirmationId: "a".repeat(64), conflicts: 0, isDemo: false, items: [], ready: 1, skipped: 0 }))
      .mockReturnValueOnce(errorResponse({
        code: "RECOVERY_REQUIRED",
        message: "元数据操作未能自动完成；并发创建的文件已保留，且没有原始备份，请联系支持人员。",
        recovery: { auditRetained: true, concurrentTargetPreserved: true, createdTargetRemoved: false, retainedBackup: false },
      }));
    render(<ExportPanel />);
    await user.click(screen.getByRole("button", { name: "先预览…" }));
    await user.click(await screen.findByRole("checkbox", { name: "我已保存 Lightroom 元数据并关闭 Lightroom" }));
    await user.click(screen.getByRole("button", { name: "写入 Lightroom 评分" }));
    expect(await screen.findByRole("status")).toHaveTextContent("并发创建的文件已保留，且没有原始备份");
  });

  it("shows retained-backup recovery copy without claiming a concurrent target", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValueOnce(response({ confirmationId: "a".repeat(64), conflicts: 0, isDemo: false, items: [], ready: 1, skipped: 0 }))
      .mockReturnValueOnce(errorResponse({
        code: "RECOVERY_REQUIRED",
        message: "元数据操作未能自动恢复；已保留恢复备份，请勿继续修改并联系支持人员。",
        recovery: { auditRetained: true, concurrentTargetPreserved: false, createdTargetRemoved: false, retainedBackup: true },
      }));
    render(<ExportPanel />);
    await user.click(screen.getByRole("button", { name: "先预览…" }));
    await user.click(await screen.findByRole("checkbox", { name: "我已保存 Lightroom 元数据并关闭 Lightroom" }));
    await user.click(screen.getByRole("button", { name: "写入 Lightroom 评分" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("已保留恢复备份");
    expect(status).not.toHaveTextContent("并发创建");
  });

  it("requires the Lightroom confirmation, commits, and offers the most-recent rollback", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValueOnce(response({
        confirmationId: "a".repeat(64), conflicts: 0, isDemo: false,
        items: [{ id: "b".repeat(24), label: "folder/IMG_1.xmp", kind: "xmp", rating: 4, status: "ready" }],
        ready: 1, skipped: 2,
      }))
      .mockReturnValueOnce(response({
        auditId: "c".repeat(32), conflicts: 0, errors: 0,
        items: [{ id: "b".repeat(24), label: "folder/IMG_1.xmp", status: "written" }], skipped: 0, written: 1,
      }))
      .mockReturnValueOnce(response({
        auditId: "c".repeat(32), conflicts: 0, errors: 0,
        items: [{ id: "rollback-0", status: "rolled-back" }], skipped: 0, written: 0,
      }));
    render(<ExportPanel />);

    await user.click(screen.getByRole("button", { name: "先预览…" }));
    expect(await screen.findByText(/待写入 1.*跳过 2.*冲突 0/u)).toBeVisible();
    const commit = screen.getByRole("button", { name: "写入 Lightroom 评分" });
    expect(commit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "我已保存 Lightroom 元数据并关闭 Lightroom" }));
    await user.click(commit);
    expect(within(await screen.findByRole("region", { name: "Lightroom 评分结果" })).getByText(/已写入 1.*错误 0/u)).toBeVisible();
    expect(screen.getByText(/从文件读取元数据/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "回滚最近一次导出" }));
    expect(await screen.findByText("最近一次导出已回滚。")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("allows demo preview but never enables commit", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValue(response({ conflicts: 0, isDemo: true, items: [], ready: 3, skipped: 0 }));
    render(<ExportPanel />);
    await user.click(screen.getByRole("button", { name: "先预览…" }));
    expect(await screen.findByText(/示例相册仅显示预览/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "写入 Lightroom 评分" })).not.toBeInTheDocument();
  });

  it("still picks a destination for a real album whose display name is 示例相册", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValueOnce(response({ selectionId: "a".repeat(32), name: "目标" }))
      .mockReturnValueOnce(response({ confirmationId: "b".repeat(64), isDemo: false, items: [], counts: { copy: 0, skip: 0, conflicts: 0 }, totalBytes: 0, requiredBytes: 0 }));
    render(<ExportPanel isDemo={false} />);
    await user.click(screen.getByRole("button", { name: "选择目标文件夹" }));
    await screen.findByRole("region", { name: "复制预览" });
    expect(new URL(fetchMock.mock.calls[1]![0] as string, "http://localhost").pathname).toBe("/api/v1/directories/pick");
  });
});

describe("ExportPanel automatic copy destination", () => {
  it("previews directly into the generated selection folder without opening the picker", async () => {
    class FakeEventSource extends EventTarget {
      static latest?: FakeEventSource;
      constructor(readonly url: string) { super(); FakeEventSource.latest = this; }
      close() { return undefined; }
      emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ data }) })); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValueOnce(response({ jobId: "a".repeat(32) }))
      .mockReturnValueOnce(response({ jobId: "d".repeat(32) }));
    const preview = {
        confirmationId: "b".repeat(64), destinationName: "新疆婚礼-精选", isDemo: false,
        items: [{ relativePath: "one.cr3", size: 10, sha256: "c".repeat(64), status: "copy", generated: false }],
        counts: { copy: 1, skip: 0, conflicts: 0 }, totalBytes: 10, requiredBytes: 10, freeBytes: 100,
      };

    render(<ExportPanel />);
    await user.click(screen.getByRole("button", { name: /复制入选照片/u }));
    await user.click(screen.getByRole("button", { name: "复制到自动生成的精选文件夹" }));
    FakeEventSource.latest?.emit("progress", { completed: 1, total: 2, relativePath: "one.cr3" });
    expect(await screen.findByRole("progressbar")).toHaveAttribute("value", "50");
    expect(screen.getByText(/正在检查入选照片.*1\/2.*one.cr3/u)).toBeVisible();
    FakeEventSource.latest?.emit("terminal", { status: "ready", preview });

    expect(await screen.findByText(/正在复制 1 个文件到 新疆婚礼-精选/u)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[1]![0] as string, "http://localhost").pathname).toBe("/api/v1/exports/copy/preview/jobs");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ minRating: 1 });
  });
});

describe("ExportPanel metadata progress", () => {
  it("renders real metadata job progress and its terminal result", async () => {
    class FakeEventSource extends EventTarget {
      static latest?: FakeEventSource;
      constructor(readonly url: string) { super(); FakeEventSource.latest = this; }
      close() { return undefined; }
      emit(type: string, data: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ data }) })); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(response({ available: false }))
      .mockReturnValueOnce(response({ jobId: "b".repeat(32) }));
    render(<ExportPanel album={{ photos: Array.from({ length: 10 }, (_, index) => ({ id: String(index), rating: 1 })) } as never} />);

    await user.click(screen.getByRole("button", { name: /写入 Lightroom 评分/u }));
    FakeEventSource.latest?.emit("progress", { phase: "writing", completed: 5, total: 10, relativePath: "IMG_0005.xmp" });

    expect(await screen.findByRole("progressbar")).toHaveAttribute("value", "50");
    expect(screen.getByText(/正在写入 XMP.*5\/10.*IMG_0005.xmp/u)).toBeVisible();
    FakeEventSource.latest?.emit("terminal", {
      status: "complete",
      result: { auditId: "c".repeat(32), conflicts: 0, errors: 0, items: [], skipped: 0, written: 10 },
    });
    expect(await screen.findByText(/写入完成：10 个/u)).toBeVisible();
  });
});
