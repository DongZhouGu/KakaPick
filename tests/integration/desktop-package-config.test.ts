import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  build?: { files?: string[] };
}

describe("desktop package configuration", () => {
  it("does not remove runtime source directories from dependencies", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;

    expect(manifest.build?.files).not.toContain("!node_modules/**/src/**/*");
  });
});
