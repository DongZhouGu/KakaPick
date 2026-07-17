import { chmod, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export function warningFixturePath(projectName: string): string {
  return join(tmpdir(), `burstpick-e2e-real-warnings-${projectName}`);
}

export async function createWarningFixture(root: string): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { mode: 0o700, recursive: true });
  const jpeg = await sharp({
    create: { background: "#38658a", channels: 3, height: 48, width: 64 },
  }).jpeg().toBuffer();
  await writeFile(join(root, "unpaired.jpg"), jpeg);
  await writeFile(join(root, "duplicate.jpg"), jpeg);
  await writeFile(join(root, "duplicate.ARW"), "not-a-real-raw");
  await writeFile(join(root, "duplicate.NEF"), "also-not-a-real-raw");
  const fixedTime = new Date("2026-01-02T03:04:05.000Z");
  await Promise.all([
    "unpaired.jpg", "duplicate.jpg", "duplicate.ARW", "duplicate.NEF",
  ].map((name) => utimes(join(root, name), fixedTime, fixedTime)));
  await chmod(join(root, "duplicate.ARW"), 0o000);
}
