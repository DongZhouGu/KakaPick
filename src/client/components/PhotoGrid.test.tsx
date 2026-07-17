// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicPhotoUnit } from "../../shared/api.js";
import type { BurstGroup } from "../../shared/domain.js";
import { PhotoGrid } from "./PhotoGrid.js";

const photos: PublicPhotoUnit[] = [
  {
    id: "p1",
    stem: "DSC_0001",
    jpeg: { kind: "jpeg", relativePath: "demo/DSC_0001.jpg", size: 1, modifiedAtMs: 1 },
    capturedAtMs: 1,
    captureTimeSource: "exif",
    rating: 0,
  },
  {
    id: "p2",
    stem: "DSC_0002",
    raw: { kind: "raw", relativePath: "demo/DSC_0002.arw", size: 1, modifiedAtMs: 1 },
    capturedAtMs: 2,
    captureTimeSource: "file-mtime",
    rating: 0,
  },
];

const group: BurstGroup = {
  id: "g1",
  photoIds: ["p1", "p2"],
  startedAtMs: 1,
  endedAtMs: 2,
  confidence: 1,
  manual: false,
};

afterEach(cleanup);

describe("PhotoGrid", () => {
  it("shows file-time fallback and unpaired badges on photo cards", () => {
    render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} />);
    expect(screen.getByText("文件时间")).toBeVisible();
    expect(screen.getByText("仅 JPEG")).toBeVisible();
  });
  const photoButton = (stem: string) => screen.getByRole("button", { name: new RegExp(`^${stem}，`, "u") });

  it("rates the focused photo with a numeric key and announces it", async () => {
    const user = userEvent.setup();
    const onRate = vi.fn();
    render(<PhotoGrid group={group} photos={photos} onRate={onRate} />);

    await user.click(photoButton("DSC_0001"));
    await user.keyboard("3");

    expect(onRate).toHaveBeenCalledWith("p1", 3);
    expect(screen.getByRole("status")).toHaveTextContent("DSC_0001，3 星");
  });

  it("uses shift plus a numeric key to rate the current multi-selection", async () => {
    const user = userEvent.setup();
    const onRate = vi.fn();
    render(<PhotoGrid group={group} photos={photos} onRate={onRate} />);

    await user.click(photoButton("DSC_0001"));
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.click(photoButton("DSC_0002"));
    await user.keyboard("{Shift>}4{/Shift}");

    expect(onRate).toHaveBeenLastCalledWith(["p1", "p2"], 4);
  });

  it("opens and closes the loupe with Space and Escape", async () => {
    const user = userEvent.setup();
    render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} />);

    await user.click(photoButton("DSC_0001"));
    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: /查看 DSC_0001/u })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(photoButton("DSC_0001")).toHaveFocus());
  });

  it("offers visible pointer rating and multi-select controls", async () => {
    const user = userEvent.setup();
    const onRate = vi.fn();
    render(<PhotoGrid group={group} photos={photos} onRate={onRate} />);

    await user.click(screen.getByRole("button", { name: /选择 DSC_0001/u }));
    await user.click(screen.getByRole("button", { name: "将所选照片评为 5 星" }));

    expect(onRate).toHaveBeenCalledWith(["p1"], 5);
    expect(screen.getByRole("group", { name: "焦点照片评分" })).toBeVisible();
  });

  it("retries a failed thumbnail with a cache-busted URL", async () => {
    const user = userEvent.setup();
    render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} />);
    const image = document.querySelector("img");
    expect(image).toBeDefined();
    fireEvent.error(image as HTMLImageElement);

    await user.click(screen.getByRole("button", { name: "重试 DSC_0001 预览" }));
    expect(document.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/retry=1/u));
  });

  it("notifies the parent when filtering leaves no focus", () => {
    const onFocusedChange = vi.fn();
    const view = render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} onFocusedChange={onFocusedChange} />);
    view.rerender(<PhotoGrid group={group} photos={[]} onRate={vi.fn()} onFocusedChange={onFocusedChange} />);
    expect(onFocusedChange).toHaveBeenLastCalledWith(undefined);
  });

  it("traps focus inside the loupe and restores the photo focus", async () => {
    const user = userEvent.setup();
    render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} />);
    const photo = photoButton("DSC_0001");
    await user.click(photo);
    await user.keyboard(" ");
    const close = screen.getByRole("button", { name: "关闭放大查看" });
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    await user.tab();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    await user.click(close);
    await waitFor(() => expect(photo).toHaveFocus());
  });

  it("keeps external focus and arrow navigation inside the open loupe", async () => {
    const user = userEvent.setup();
    const onFocusedChange = vi.fn();
    render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} onFocusedChange={onFocusedChange} />);
    const firstPhoto = photoButton("DSC_0001");
    const secondPhoto = photoButton("DSC_0002");
    await user.click(firstPhoto);
    await user.keyboard(" ");
    const dialog = screen.getByRole("dialog", { name: /查看 DSC_0001/u });

    secondPhoto.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    onFocusedChange.mockClear();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: /查看 DSC_0001/u })).toContainElement(document.activeElement as HTMLElement);
    expect(firstPhoto).toHaveAttribute("tabindex", "0");
    expect(secondPhoto).toHaveAttribute("tabindex", "-1");
    expect(onFocusedChange).not.toHaveBeenCalled();
  });

  it("dispatches spatial movement and command shortcuts", async () => {
    const user = userEvent.setup();
    const onSplit = vi.fn();
    const onMerge = vi.fn();
    const onUndo = vi.fn();
    render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} onSplit={onSplit} onMerge={onMerge} onUndo={onUndo} />);
    await user.click(photoButton("DSC_0001"));
    await user.keyboard("{ArrowRight}sm{Control>}z{/Control}");
    expect(photoButton("DSC_0002")).toHaveFocus();
    expect(onSplit).toHaveBeenCalledWith("p2");
    expect(onMerge).toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalled();
  });

  it("changes groups and clears a multi-selection with the documented keys", async () => {
    const user = userEvent.setup();
    const onGroup = vi.fn();
    render(<PhotoGrid group={group} photos={photos} onRate={vi.fn()} onGroup={onGroup} />);
    await user.click(photoButton("DSC_0001"));
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "]" });
    expect(photoButton("DSC_0001")).toHaveAttribute("aria-pressed", "true");
    expect(onGroup).toHaveBeenNthCalledWith(1, -1);
    expect(onGroup).toHaveBeenNthCalledWith(2, 1);
    await user.keyboard("{Escape}");
    expect(photoButton("DSC_0001")).toHaveAttribute("aria-pressed", "false");
  });
});
