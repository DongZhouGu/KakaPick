// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicPhotoUnit } from "../../shared/api.js";
import { PhotoStage } from "./PhotoStage.js";

const photos: PublicPhotoUnit[] = ["p1", "p2", "p3"].map((id, index) => ({
  id, stem: `DSC_000${index + 1}`,
  jpeg: { kind: "jpeg", relativePath: `${id}.jpg`, size: 1, modifiedAtMs: 1 },
  capturedAtMs: index, captureTimeSource: "exif", rating: index === 0 ? 3 : 0,
}));

afterEach(cleanup);

it("renders only the focused two-photo batch and rates each independently", async () => {
  const user = userEvent.setup();
  const onRate = vi.fn();
  render(<PhotoStage photos={photos} focusedId="p1" photosPerPage={2} onFocus={vi.fn()} onRate={onRate} />);
  expect(screen.getAllByRole("article")).toHaveLength(2);
  const image = document.querySelector(".stage-photo-frame img");
  expect(image).toHaveAttribute("srcset", expect.stringContaining("3200w"));
  expect(image).toHaveAttribute("sizes", expect.stringContaining("50vw"));
  expect(screen.queryByText("DSC_0003")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "将 DSC_0002 评为 4 星" }));
  expect(onRate).toHaveBeenCalledWith("p2", 4);
});

it("moves pointer focus without changing another photo rating", async () => {
  const user = userEvent.setup();
  const onFocus = vi.fn();
  render(<PhotoStage photos={photos} focusedId="p1" photosPerPage={2} onFocus={onFocus} onRate={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /聚焦 DSC_0002/u }));
  expect(onFocus).toHaveBeenCalledWith("p2");
  expect(screen.getByRole("button", { name: "将 DSC_0001 评为 3 星" })).toHaveAttribute("aria-pressed", "true");
});
