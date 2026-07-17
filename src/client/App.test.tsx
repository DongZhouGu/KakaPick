// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("shows a product-specific welcome with picker, manual path, and demo", () => {
    render(<App />);

    expect(screen.getByText("咔咔选")).toBeVisible();
    expect(screen.getByRole("heading", { name: "拍得多，也能选得快。" })).toBeVisible();
    expect(screen.getByText(/连拍自动成组/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "选择照片文件夹" })).toBeVisible();
    expect(screen.getByLabelText("照片文件夹路径")).toBeVisible();
    expect(screen.getByRole("button", { name: "体验示例相册" })).toBeVisible();
  });

  it("shows the immersive workspace with settings and completion controls", async () => {
    const user = userEvent.setup();
    render(<App initialView="workspace" />);
    expect(screen.getByRole("button", { name: "返回咔咔选首页" })).toHaveTextContent("咔咔选");
    expect(screen.getByText(/示例相册 · 第 1 \/ 1 组/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("button", { name: "2 张" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "导出评分…" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("/Users/");
  });

  it("does not capture rating keys while an advanced input is active", async () => {
    const user = userEvent.setup();
    render(<App initialView="workspace" />);
    await user.click(screen.getByRole("button", { name: "设置" }));
    const input = screen.getByLabelText("分组范围");
    await user.click(input);
    await user.keyboard("5");
    expect(input).toHaveValue("1.05");
  });

  it("opens the guided completion layer", async () => {
    const user = userEvent.setup();
    render(<App initialView="workspace" />);
    await user.click(screen.getByRole("button", { name: "导出评分…" }));
    expect(screen.getByRole("dialog", { name: "评分结果" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "0 张入选照片" })).toBeVisible();
  });

  it("stores a valid startup token and removes only that query parameter", () => {
    const token = "a".repeat(64);
    window.history.replaceState({}, "", `/?token=${token}&album=demo#grid`);

    render(<App />);

    expect(sessionStorage.getItem("burstpick-token")).toBe(token);
    expect(window.location.search).toBe("?album=demo");
    expect(window.location.hash).toBe("#grid");
  });

  it("rejects an invalid startup token but still removes it from the visible URL", () => {
    window.history.replaceState({}, "", "/?token=not-a-process-token&album=demo");

    render(<App />);

    expect(sessionStorage.getItem("burstpick-token")).toBeNull();
    expect(window.location.search).toBe("?album=demo");
  });
});
