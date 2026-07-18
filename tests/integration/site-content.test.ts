import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Pages site", () => {
  const html = readFileSync("site/index.html", "utf8");
  const chineseReadme = readFileSync("README.zh-CN.md", "utf8");
  const englishReadme = readFileSync("README.md", "utf8");
  const workflow = readFileSync(".github/workflows/pages.yml", "utf8");

  it("contains the public product story and fixed release links", () => {
    const releaseUrl = "https://github.com/DongZhouGu/KakaPick/releases/latest";
    const downloadActions = [...html.matchAll(/<a\b[^>]*class=["'][^"']*button-primary[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi)];

    expect(html).toContain("拍得多，也能选得快");
    expect(html).toContain("https://github.com/DongZhouGu/KakaPick");
    expect(downloadActions).toHaveLength(2);
    expect(downloadActions.map((action) => action[1])).toEqual([releaseUrl, releaseUrl]);
    expect(html).not.toMatch(/href=["']\/releases\//);
  });

  it("does not load third-party scripts or expose ignored campaign paths", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/marketing|videos|\.venv|\/Users\//i);
  });

  it("explains both post-cull handoff paths on the site and in both readmes", () => {
    expect(html).toContain('href="#after-cull"');
    expect(html).toContain('id="after-cull"');
    expect(html).toContain("继续在 Lightroom 调色");
    expect(html).toContain("读取元数据");
    expect(html).toContain("复制成新的精选文件夹");
    expect(html).toContain("原始文件不会被移动或删除");

    expect(chineseReadme).toContain("## 选完片之后");
    expect(chineseReadme).toContain("### 继续在 Lightroom 调色");
    expect(chineseReadme).toContain("读取元数据");
    expect(chineseReadme).toContain("### 复制成新的精选文件夹");
    expect(chineseReadme).toContain("不会移动或删除原始文件");

    expect(englishReadme).toContain("## After culling");
    expect(englishReadme).toContain("### Continue in Lightroom");
    expect(englishReadme).toContain("Read Metadata");
    expect(englishReadme).toContain("### Copy to a new selects folder");
    expect(englishReadme).toContain("does not move or delete the originals");
  });

  it("uses the Pages deployment workflow", () => {
    expect(workflow).toContain("actions/deploy-pages");
    expect(workflow).toContain("path: site");
    expect(workflow).toContain("enablement: true");
  });
});
