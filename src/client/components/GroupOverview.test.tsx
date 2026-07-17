// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicPhotoUnit } from "../../shared/api.js";
import type { BurstGroup } from "../../shared/domain.js";
import { GroupOverview } from "./GroupOverview.js";

const photos: PublicPhotoUnit[] = [0, 3, 0, 4, 0].map((rating, index) => ({
  id: `p${index + 1}`,
  stem: `DSC_${index + 1}`,
  jpeg: { kind: "jpeg", relativePath: `p${index + 1}.jpg`, size: 1, modifiedAtMs: 1 },
  capturedAtMs: index,
  captureTimeSource: "exif",
  rating: rating as 0 | 3 | 4,
}));
const groups: BurstGroup[] = [
  { id: "g1", photoIds: ["p1", "p2", "p3", "p4"], startedAtMs: 1, endedAtMs: 4, confidence: 1, manual: false },
  { id: "g2", photoIds: ["missing", "p5"], startedAtMs: 5, endedAtMs: 5, confidence: 1, manual: false },
];

afterEach(cleanup);

it("renders collage, rating statistics, progress, and current state", () => {
  render(<GroupOverview albumName="周末" currentGroupId="g1" groups={groups} photosById={new Map(photos.map((photo) => [photo.id, photo]))} onBack={vi.fn()} onSelectGroup={vi.fn()} />);
  expect(screen.getByRole("region", { name: "所有组" })).toBeVisible();
  expect(screen.getByText("周末 · 2 组 · 5 张照片")).toBeVisible();
  const first = screen.getByRole("button", { name: /第 1 组/u });
  expect(first).toHaveAttribute("aria-current", "true");
  expect(first).toHaveAttribute("data-cover-count", "4");
  expect(first).toHaveTextContent("4 张 · 已评分 2 · 入选 2");
  expect(first.querySelectorAll("img")).toHaveLength(4);
  expect(first.querySelector("progress")).toHaveAttribute("value", "2");
  expect(first).toHaveTextContent("当前");
});

it("skips missing members and reports selected group index", async () => {
  const user = userEvent.setup();
  const onSelectGroup = vi.fn();
  const onBack = vi.fn();
  render(<GroupOverview albumName="周末" currentGroupId="g1" groups={groups} photosById={new Map(photos.map((photo) => [photo.id, photo]))} onBack={onBack} onSelectGroup={onSelectGroup} />);
  const second = screen.getByRole("button", { name: /第 2 组/u });
  expect(second).toHaveAttribute("data-cover-count", "1");
  expect(second).toHaveTextContent("1 张 · 已评分 0 · 入选 0");
  await user.click(second);
  expect(onSelectGroup).toHaveBeenCalledWith(1);
  await user.click(screen.getByRole("button", { name: "返回选片" }));
  expect(onBack).toHaveBeenCalledOnce();
});
