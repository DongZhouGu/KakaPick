import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const trackedPaths = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const privatePathPattern =
  /(^|\/)(?:\.?superpowers|\.agents|\.codex|\.claude)(?:\/|$)|(^|\/)specs\/plans(?:\/|$)|(^|\/)(?:implementation[-_ ]plans?|agent[-_ ]notes?)(?:\.md)?(?:\/|$)/i;
const forbiddenDocumentationPatterns = [
  /\.?superpowers|\.agents|\.codex|\.claude|specs\/plans/i,
  /(?:^|[/\\])(?:implementation[-_ ]plans?|agent[-_ ]notes?)(?=\.md(?:[#?)\s]|$)|[/\\#?)]|$)/i,
  /(?:file:\/\/)?\/(?:Users|home)\/(?!Shared(?:\/|\s|$))[^/<>{}\s)]+(?:\/[^\s)]*)?/i,
  /[a-z]:\\Users\\[^\\<>{}\s]+(?:\\[^\s)]*)?/i,
];

const selectPublicDocumentation = (paths: string[]) => paths.filter((path) => path.endsWith(".md"));
const containsForbiddenDocumentation = (content: string) =>
  forbiddenDocumentationPatterns.some((pattern) => pattern.test(content));

describe("public repository hygiene", () => {
  it.each([
    ["README.md", "README.zh-CN.md", "简体中文"],
    ["README.zh-CN.md", "README.md", "English"],
  ])("keeps %s product-first and linked to its translation", (path, translation, language) => {
    const content = readFileSync(join(repositoryRoot, path), "utf8");

    expect(content).toContain(`](${translation})`);
    expect(content).toContain(language);
    expect(content).toContain("src/client/assets/kakapick-mark.svg");
    expect(content).toContain("https://DongZhouGu.github.io/KakaPick/");
    expect(content).toContain("https://github.com/DongZhouGu/KakaPick/releases/latest");
    expect(content).toMatch(/local-first|本地优先/i);
    expect(content).toMatch(/without uploading|不上传/i);
    expect(content).toMatch(/Lightroom-compatible|Lightroom 兼容/i);
    expect(content).toContain("CONTRIBUTING.md");
    expect(content).toContain("SECURITY.md");
    expect(content).toContain("LICENSE");
  });

  it.each([
    ".superpowers/sdd/task.md",
    "docs/superpowers/plans/task.md",
    ".agents/notes.md",
    ".codex/session.md",
    ".claude/settings.md",
    "feature/specs/plans/task.md",
  ])("classifies %s as a private tracked path", (path) => {
    expect(privatePathPattern.test(path)).toBe(true);
  });

  it("selects every tracked Markdown file as public documentation", () => {
    const fixturePaths = [
      "README.md",
      "README.zh-CN.md",
      "CONTRIBUTING.md",
      "site/content/guide.md",
      "src/index.ts",
    ];

    expect(selectPublicDocumentation(fixturePaths)).toEqual(fixturePaths.slice(0, 4));
  });

  it.each([
    ["private process directory", "See .superpowers/sdd/task.md."],
    ["implementation-plan link", "See [the draft](./implementation-plan.md)."],
    ["agent-note link", "See [handoff](./notes/agent-notes.md)."],
    ["macOS personal path", "Run /Users/alice/src/project/script.sh."],
    ["Linux personal path", "Run /home/alice/src/project/script.sh."],
    ["Windows personal path", String.raw`Run C:\Users\alice\src\project\script.cmd.`],
  ])("rejects %s leakage from public documentation", (_caseName, content) => {
    expect(containsForbiddenDocumentation(content)).toBe(true);
  });

  it.each([
    "The implementation plan explains how maintainers sequence a release.",
    "Use the local development server described in docs/development.md.",
    "See docs/architecture.md and docs/product.md.",
  ])("allows legitimate public documentation: %s", (content) => {
    expect(containsForbiddenDocumentation(content)).toBe(false);
  });

  it("does not track private agent or process files", () => {
    const privatePaths = trackedPaths.filter((path) => privatePathPattern.test(path));

    expect(privatePaths).toEqual([]);
  });

  it("does not mention private agent or process names in public documentation", () => {
    const publicDocumentation = selectPublicDocumentation(trackedPaths);
    const references = publicDocumentation.filter((path) =>
      containsForbiddenDocumentation(readFileSync(join(repositoryRoot, path), "utf8")),
    );

    expect(references).toEqual([]);
  });
});
