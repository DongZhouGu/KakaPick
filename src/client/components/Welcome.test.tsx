// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Welcome } from "./Welcome.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

it("shows privacy-safe recent albums and opens one by opaque id", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { albums: [
    { id: "a".repeat(64), name: "婚礼", lastOpenedAt: "2026-07-12T04:00:00.000Z", photoCount: 120, ratedCount: 45 },
    { id: "b".repeat(64), name: "旅行", lastOpenedAt: "2026-07-11T04:00:00.000Z", photoCount: 80, ratedCount: 0 },
  ] } }), { status: 200 }));
  const onOpen = vi.fn().mockResolvedValue(undefined);
  render(<Welcome busy={false} onOpen={onOpen} />);
  await waitFor(() => expect(screen.getByText("最近打开")).toBeVisible());
  await userEvent.setup().click(screen.getByRole("button", { name: /婚礼/u }));
  expect(onOpen).toHaveBeenCalledWith({ recentId: "a".repeat(64) }, "婚礼");
  expect(document.body).not.toHaveTextContent("/Users/");
});

it("keeps normal opening available when recent loading fails", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  render(<Welcome busy={false} onOpen={vi.fn().mockResolvedValue(undefined)} />);
  expect(screen.getByRole("button", { name: "选择照片文件夹" })).toBeEnabled();
  expect(screen.getByLabelText("照片文件夹路径")).toBeEnabled();
});
