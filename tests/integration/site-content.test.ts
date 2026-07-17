import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Pages site", () => {
  const html = readFileSync("site/index.html", "utf8");
  const workflow = readFileSync(".github/workflows/pages.yml", "utf8");

  it("contains the public product story and fixed release links", () => {
    expect(html).toContain("拍得多，也能选得快");
    expect(html).toContain("https://github.com/DongZhouGu/KakaPick");
    expect(html).toContain("https://github.com/DongZhouGu/KakaPick/releases/latest");
    expect(html).not.toMatch(/href=["']\/releases\//);
  });

  it("does not load third-party scripts or expose ignored campaign paths", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/marketing|videos|\.venv|\/Users\//i);
  });

  it("uses the Pages deployment workflow", () => {
    expect(workflow).toContain("actions/deploy-pages");
    expect(workflow).toContain("path: site");
    expect(workflow).toContain("enablement: true");
  });
});
