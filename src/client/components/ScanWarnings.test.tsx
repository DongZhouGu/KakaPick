// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScanWarnings } from "./ScanWarnings.js";

describe("ScanWarnings", () => {
  it("renders safe Chinese summaries for every public scan warning kind", () => {
    render(<ScanWarnings warnings={[
      { code: "DUPLICATE_RAW", photoId: "p1", relativePaths: ["day/a.arw", "day/a.nef"] },
      { code: "DUPLICATE_JPEG", photoId: "p1", relativePaths: ["day/a.jpg"] },
      { code: "DUPLICATE_XMP", photoId: "p1", relativePaths: ["day/a.xmp"] },
      { code: "UNPAIRED_RAW", photoId: "p2", relativePaths: ["day/b.arw"] },
      { code: "UNPAIRED_JPEG", photoId: "p3", relativePaths: ["day/c.jpg"] },
      { code: "METADATA_READ_FAILED", photoId: "p3", relativePaths: ["day/c.jpg"] },
      { code: "IMAGE_HASH_FAILED", photoId: "p3", relativePaths: ["day/c.jpg"] },
      { code: "PREVIEW_EXTRACT_FAILED", photoId: "p2", relativePaths: ["day/b.arw"] },
      { code: "CAPTURE_TIME_FALLBACK", photoId: "p2", relativePaths: ["day/b.arw"] },
    ]} />);
    const region = screen.getByRole("region", { name: "扫描警告" });
    expect(region).toHaveTextContent("9 项");
    expect(region).toHaveTextContent("重复 RAW");
    expect(region).toHaveTextContent("文件修改时间");
    expect(region).not.toHaveTextContent("/Users/");
  });
});
