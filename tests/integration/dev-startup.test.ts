import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

describe("documented development startup", () => {
  it("runs exact pnpm dev, prints a tokenized URL, serves the Chinese welcome app, and exits cleanly", async () => {
    const child = spawn("pnpm", ["dev"], {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, BURSTPICK_PORT: "0", CI: "true", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 20_000);
        const inspect = () => {
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}/u);
          if (match !== null) { clearTimeout(timeout); resolve(match[0]); }
        };
        child.stdout.on("data", inspect);
        child.stderr.on("data", inspect);
        child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`pnpm dev exited ${code}: ${output}`)); });
      });
      const html = await fetch(url).then((response) => response.text());
      expect(html).toContain("<html lang=\"zh-CN\">");
      const assetPath = html.match(/src="([^"]*\/src\/client\/main\.tsx)"/u)?.[1];
      expect(assetPath).toBeDefined();
      const asset = await fetch(new URL(assetPath!, url)).then((response) => response.text());
      expect(asset).toContain("/src/client/App.tsx");
      const welcome = await fetch(new URL("/src/client/components/Welcome.tsx", url)).then((response) => response.text());
      expect(welcome).toContain("拍得多，也能选得快。");
    } finally {
      if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    }
    expect(child.exitCode).not.toBeNull();
  }, 30_000);
});
