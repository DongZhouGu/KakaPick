import { mkdtemp, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RecentAlbumsStore } from "./recent-albums-store.js";

it("records, deduplicates, orders, limits, and resolves recent albums securely", async () => {
  const root = await mkdtemp(join(tmpdir(), "burstpick-recents-"));
  const path = join(root, "data", "recent-albums-v1.json");
  const store = new RecentAlbumsStore(path);
  for (let index = 0; index < 10; index += 1) {
    const album = join(root, `album-${index}`);
    await mkdir(album);
    await store.record(album);
  }
  const latest = await store.record(join(root, "album-5"));
  const records = await store.list();
  expect(records).toHaveLength(10);
  expect(records[0]).toMatchObject({ id: latest.id, name: "album-5" });
  expect(await store.resolve(latest.id)).toMatchObject({ canonicalPath: await realpath(join(root, "album-5")) });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "data"))).mode & 0o777).toBe(0o700);
});

it("quarantines corrupt registry data and returns an empty list", async () => {
  const root = await mkdtemp(join(tmpdir(), "burstpick-recents-corrupt-"));
  const path = join(root, "recent-albums-v1.json");
  await writeFile(path, "{");
  const store = new RecentAlbumsStore(path);
  await expect(store.list()).resolves.toEqual([]);
  expect((await readdir(root)).some((name) => name.startsWith("recent-albums-v1.json.corrupt-"))).toBe(true);
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
