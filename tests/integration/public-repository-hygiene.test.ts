import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const trackedPaths = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const privatePathPattern = /(^|\/)(?:superpowers|\.agents|\.codex|\.claude)(?:\/|$)|(^|\/)specs\/plans(?:\/|$)/i;
const privateReferencePattern = /superpowers|\.agents|\.codex|\.claude|specs\/plans/i;

describe("public repository hygiene", () => {
  it("does not track private agent or process files", () => {
    const privatePaths = trackedPaths.filter((path) => privatePathPattern.test(path));

    expect(privatePaths).toEqual([]);
  });

  it("does not mention private agent or process names in public documentation", () => {
    const publicDocumentation = trackedPaths.filter(
      (path) => path === "README.md" || (path.startsWith("docs/") && path.endsWith(".md")),
    );
    const references = publicDocumentation.filter((path) =>
      privateReferencePattern.test(readFileSync(path, "utf8")),
    );

    expect(references).toEqual([]);
  });
});
