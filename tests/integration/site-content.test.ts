import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Pages site", () => {
  const html = readFileSync("site/index.html", "utf8");
  const chineseReadme = readFileSync("README.md", "utf8");
  const englishReadme = readFileSync("README.en.md", "utf8");
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
    expect(html).toContain("复制成新的精选文件夹");
    expect(html).toContain("原始文件不会被移动或删除");
    expect(chineseReadme).toContain("## 选完片之后");
    expect(chineseReadme).toContain("读取元数据");
    expect(englishReadme).toContain("## After culling");
    expect(englishReadme).toContain("Read Metadata");
  });

  it("publishes search metadata and a clickable website preview", () => {
    const websiteUrl = "https://DongZhouGu.github.io/KakaPick/";
    const previewUrl = `${websiteUrl}social-preview.png`;
    expect(html).toContain(`<link rel="canonical" href="${websiteUrl}">`);
    expect(html).toContain('<meta name="keywords"');
    expect(html).toContain(`<meta property="og:image" content="${previewUrl}">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('"@type": "SoftwareApplication"');
    for (const readme of [chineseReadme, englishReadme]) {
      expect(readme).toContain(`<a href="${websiteUrl}">`);
      expect(readme).toContain('src="site/social-preview.png"');
      expect(readme).toContain('width="640"');
    }
  });

  it("uses the Pages deployment workflow", () => {
    expect(workflow).toContain("actions/deploy-pages");
    expect(workflow).toContain("path: site");
    expect(workflow).toContain("enablement: true");
  });
});
