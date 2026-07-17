// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CullingSettings } from "./CullingSettings.js";

afterEach(cleanup);

it("exposes grouped browsing and burst controls", async () => {
  const user = userEvent.setup();
  const onPreferences = vi.fn();
  const onSensitivity = vi.fn();
  const onSplit = vi.fn();
  const onMerge = vi.fn();
  render(<CullingSettings
    canMerge
    canUndo
    focused
    preferences={{ photosPerPage: 2, advanceAfterRating: true, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } as const }}
    sensitivity={1}
    onClose={vi.fn()}
    onMerge={onMerge}
    onPreferences={onPreferences}
    onSensitivity={onSensitivity}
    onSplit={onSplit}
    onUndo={vi.fn()}
  />);

  expect(screen.getByRole("dialog", { name: "设置" })).toBeVisible();
  expect(screen.getByText("浏览")).toBeVisible();
  expect(screen.getByText("连拍分组")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "1 张" }));
  expect(onPreferences).toHaveBeenCalledWith({ photosPerPage: 1, advanceAfterRating: true, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } as const });
  await user.click(screen.getByRole("checkbox", { name: "评分后自动前进" }));
  expect(onPreferences).toHaveBeenCalledWith({ photosPerPage: 2, advanceAfterRating: false, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } as const });
  const slider = screen.getByRole("slider", { name: "分组范围" });
  fireEvent.change(slider, { target: { value: "1.2" } });
  fireEvent.keyUp(slider, { key: "ArrowRight" });
  expect(onSensitivity).toHaveBeenCalledWith(1.2);
  await user.click(screen.getByRole("button", { name: "拆分" }));
  await user.click(screen.getByRole("button", { name: "合并" }));
  expect(onSplit).toHaveBeenCalledOnce();
  expect(onMerge).toHaveBeenCalledOnce();
});

it("closes from Escape and the close button", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const props = {
    canMerge: false, canUndo: false, focused: false,
    preferences: { photosPerPage: 2 as const, advanceAfterRating: true, showAiHint: false, shortcuts: { reject: "z", rate1: "1", rate2: "2", rate3: "3", rate4: "4", rate5: "5" } as const },
    sensitivity: 1, onClose, onMerge: vi.fn(), onPreferences: vi.fn(),
    onSensitivity: vi.fn(), onSplit: vi.fn(), onUndo: vi.fn(),
  };
  const { rerender } = render(<CullingSettings {...props} />);
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  onClose.mockClear();
  rerender(<CullingSettings {...props} />);
  await user.click(screen.getByRole("button", { name: "完成" }));
  expect(onClose).toHaveBeenCalledOnce();
});
