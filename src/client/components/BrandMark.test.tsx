// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark.js";

afterEach(cleanup);

describe("BrandMark", () => {
  it("renders an accessible Chinese lockup and hides decorative geometry", () => {
    const { container } = render(<BrandMark />);

    expect(screen.getByText("咔咔选")).toBeVisible();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("supports icon-only and English lockups", () => {
    const { rerender } = render(<BrandMark showName={false} />);
    expect(screen.queryByText("咔咔选")).not.toBeInTheDocument();

    rerender(<BrandMark language="en" />);
    expect(screen.getByText("KakaPick")).toBeVisible();
  });
});
