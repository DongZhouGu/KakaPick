# BurstPick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first browser application that groups RAW+JPEG bursts, supports fast keyboard culling, and safely exports Lightroom ratings or selected source pairs.

**Architecture:** A single TypeScript repository separates dependency-free shared contracts, a loopback-only Express/Vite local service, and a React client. Filesystem, ExifTool, image processing, and platform dialogs sit behind injectable server adapters so tests use temporary directories and fakes and a later desktop shell can replace only platform boundaries.

**Tech Stack:** Node.js 20.3+, TypeScript, React, Vite, Express, Zod, Sharp, exiftool-vendored, Vitest, Testing Library, Playwright, ESLint, pnpm.

## Global Constraints

- Bind only to `127.0.0.1` and require an unguessable per-process token for mutating requests.
- Never upload images, write the Lightroom catalog, alter proprietary RAW bytes, delete source photos, or listen on a non-loopback interface.
- Treat same-directory, same-normalized-stem RAW+JPEG files as one photo unit.
- Change only `xmp:Rating`; preserve all other metadata and make pair writes transactional.
- Support ARW, CR2, CR3, NEF, RAF, RW2, ORF, DNG, JPG, and JPEG.
- Use atomic persistence and deterministic IDs, grouping, copy collision behavior, and error codes.
- The interface and README copy are Chinese; code identifiers are English.
- Completion requires tests, type checking, lint, production build, and a browser smoke test.

---

## File map

- `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `playwright.config.ts`: toolchain and commands.
- `src/shared/domain.ts`: stable domain types and Zod schemas.
- `src/shared/api.ts`: versioned request/response contracts.
- `src/server/pairing.ts`: source classification and RAW+JPEG pairing.
- `src/server/grouping.ts`: adaptive burst clustering and manual boundary helpers.
- `src/server/perceptual-hash.ts`: 64-bit dHash and similarity.
- `src/server/session-store.ts`: atomic JSON persistence.
- `src/server/session-service.ts`: rating, grouping, and undo commands.
- `src/server/adapters/metadata.ts`: metadata interface plus ExifTool implementation.
- `src/server/adapters/image.ts`: Sharp thumbnail/hash implementation.
- `src/server/adapters/folder-picker.ts`: macOS picker and manual path validation.
- `src/server/scanner.ts`: recursive inventory, metadata enrichment, progress, and restore.
- `src/server/export/metadata-export.ts`: dry run, transactional rating write, verification, rollback.
- `src/server/export/copy-export.ts`: collision-safe selected-pair copying.
- `src/server/demo.ts`: deterministic demo album and image route.
- `src/server/app.ts`, `src/server/index.ts`: secure HTTP application and startup.
- `src/client/*`: React application, API client, album hook, components, keyboard commands, and styling.
- `tests/e2e/demo.spec.ts`: browser workflow.
- `tests/fixtures/*`: metadata and pairing fixtures.
- `README.md`: Chinese setup, operation, Lightroom workflows, and limitations.

### Task 1: Toolchain, domain contracts, and RAW+JPEG pairing

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `src/shared/domain.ts`
- Create: `src/server/pairing.ts`
- Test: `src/server/pairing.test.ts`

**Interfaces:**
- Produces: `Rating`, `SourceFile`, `PhotoUnit`, `BurstGroup`, `AlbumSession`, `classifySourceFile(path)`, and `pairSourceFiles(root, files)`.
- `pairSourceFiles` returns `{ photos: PhotoUnit[]; warnings: ScanWarning[] }` with stable IDs and no filesystem side effects.

- [ ] **Step 1: Initialize the package and install pinned dependencies**

Run:

```bash
pnpm init
pnpm add express exiftool-vendored sharp zod react react-dom
pnpm add -D typescript tsx vite @vitejs/plugin-react vitest @vitest/coverage-v8 jsdom eslint @eslint/js typescript-eslint @types/node @types/express @types/react @types/react-dom @testing-library/react @testing-library/user-event @testing-library/jest-dom supertest @types/supertest playwright @playwright/test
```

Set scripts to `dev`, `build`, `start`, `test`, `test:coverage`, `typecheck`, `lint`, and `test:e2e`, set `type` to `module`, and set `engines.node` to `>=20.3`.

- [ ] **Step 2: Write the failing pairing tests**

```ts
import { describe, expect, it } from "vitest";
import { pairSourceFiles } from "./pairing.js";

describe("pairSourceFiles", () => {
  it("combines a same-directory RAW and JPEG into one stable photo", () => {
    const result = pairSourceFiles("/shoot", [
      { path: "/shoot/a/DSC_1.ARW", relativePath: "a/DSC_1.ARW", kind: "raw", size: 10, modifiedAtMs: 1 },
      { path: "/shoot/a/dsc_1.jpg", relativePath: "a/dsc_1.jpg", kind: "jpeg", size: 4, modifiedAtMs: 1 },
    ]);
    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]).toMatchObject({ stem: "DSC_1", rating: 0 });
    expect(result.photos[0].raw?.relativePath).toBe("a/DSC_1.ARW");
    expect(result.photos[0].jpeg?.relativePath).toBe("a/dsc_1.jpg");
  });

  it("does not pair identical stems from different directories", () => {
    const result = pairSourceFiles("/shoot", [
      { path: "/shoot/a/x.nef", relativePath: "a/x.nef", kind: "raw", size: 1, modifiedAtMs: 1 },
      { path: "/shoot/b/x.jpg", relativePath: "b/x.jpg", kind: "jpeg", size: 1, modifiedAtMs: 1 },
    ]);
    expect(result.photos).toHaveLength(2);
    expect(result.warnings.map((item) => item.code)).toEqual(["UNPAIRED_RAW", "UNPAIRED_JPEG"]);
  });
});
```

- [ ] **Step 3: Run the test and verify the missing-module failure**

Run: `pnpm vitest run src/server/pairing.test.ts`

Expected: FAIL because `./pairing.js` does not exist.

- [ ] **Step 4: Implement strict domain schemas and pairing**

Define `RatingSchema = z.union([z.literal(0), ... z.literal(5)])`, source-file and session schemas in `domain.ts`. In `pairing.ts`, normalize directory and stem with Unicode NFC plus `toLocaleLowerCase("en-US")`, classify extensions with fixed sets, create IDs using SHA-256 of normalized relative directory and stem, select one preferred candidate per kind, attach same-stem XMP, and emit duplicate/unpaired warnings. Do not read the filesystem from this module.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/server/pairing.test.ts && pnpm typecheck && pnpm lint`

Expected: all commands exit 0.

Run `git add -A`, then commit: `git commit -m "feat: add photo pairing domain"`

### Task 2: Adaptive grouping and perceptual similarity

**Files:**
- Create: `src/server/grouping.ts`
- Create: `src/server/perceptual-hash.ts`
- Test: `src/server/grouping.test.ts`
- Test: `src/server/perceptual-hash.test.ts`

**Interfaces:**
- Consumes: `PhotoUnit`, `BurstGroup` from `src/shared/domain.ts`.
- Produces: `computeAdaptiveThreshold(gapsMs): number`, `groupBursts(photos, options): BurstGroup[]`, `splitGroup(groups, photoId)`, `mergeGroupWithNext(groups, groupId)`, `differenceHash(pixels): string`, and `hashSimilarity(a, b): number`.

- [ ] **Step 1: Write failing deterministic boundary tests**

```ts
it("uses similarity only inside the ambiguous time band", () => {
  const photos = [photo("a", 0, "0".repeat(16)), photo("b", 1200, "0".repeat(15) + "f"), photo("c", 2400, "f".repeat(16))];
  const groups = groupBursts(photos, { thresholdMs: 1000, sensitivity: 1 });
  expect(groups.map((group) => group.photoIds)).toEqual([["a", "b"], ["c"]]);
});

it("keeps a shared burst id together up to twice the threshold", () => {
  const groups = groupBursts([photo("a", 0, undefined, "burst-7"), photo("b", 1900, undefined, "burst-7")], { thresholdMs: 1000, sensitivity: 1 });
  expect(groups).toHaveLength(1);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/grouping.test.ts src/server/perceptual-hash.test.ts`

Expected: FAIL with missing exported functions.

- [ ] **Step 3: Implement the specification formula exactly**

Implement median/MAD and `clamp(m + 3 * max(mad, 80), 650, 3500)`. Boundary order must be: different known camera, shared burst ID, consecutive sequence under `2t`, time under `0.65t`, time over `1.6t`, then similarity `>=0.72`. dHash accepts exactly 72 grayscale bytes ordered as 9 columns by 8 rows and returns 16 lowercase hexadecimal digits.

- [ ] **Step 4: Add manual split/merge tests and implementation**

Test that splitting before the first item is a no-op, splitting the middle preserves order, merging the final group is a no-op, and all generated group IDs are stable hashes of member IDs.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/server/grouping.test.ts src/server/perceptual-hash.test.ts && pnpm typecheck`

Expected: all tests pass and type checking exits 0.

Run `git add -A`, then commit: `git commit -m "feat: add adaptive burst grouping"`

### Task 3: Atomic sessions, commands, and undo

**Files:**
- Create: `src/server/session-store.ts`
- Create: `src/server/session-service.ts`
- Test: `src/server/session-store.test.ts`
- Test: `src/server/session-service.test.ts`

**Interfaces:**
- Consumes: `AlbumSession`, `Rating`, grouping helpers.
- Produces: `SessionStore.load/save`, `SessionService.ratePhoto`, `ratePhotos`, `split`, `merge`, `regroup`, and `undo`.

- [ ] **Step 1: Write failing command tests**

```ts
it("persists a rating command and undo restores the prior value", async () => {
  const service = createService(sessionWith(photo("p1", 0)));
  await service.ratePhoto("p1", 4);
  expect(service.snapshot().photos[0].rating).toBe(4);
  await service.undo();
  expect(service.snapshot().photos[0].rating).toBe(0);
  expect(service.snapshot().history).toHaveLength(0);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/session-store.test.ts src/server/session-service.test.ts`

Expected: FAIL because the store and service modules are missing.

- [ ] **Step 3: Implement atomic persistence**

`save` must validate with `AlbumSessionSchema`, write JSON to a sibling `.tmp-<random>` file with mode `0o600`, call `FileHandle.sync()`, close it, and rename it over the target. `load` returns `undefined` for a missing file and renames invalid JSON to `.corrupt-<timestamp>` before returning `undefined`.

- [ ] **Step 4: Implement immutable commands with bounded history**

Every command stores the smallest inverse payload, updates `updatedAt`, saves before publishing the new snapshot, and caps history at 100 entries. Invalid IDs return stable `PHOTO_NOT_FOUND` or `GROUP_NOT_FOUND` domain errors.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/server/session-store.test.ts src/server/session-service.test.ts && pnpm typecheck`

Expected: all pass.

Run `git add -A`, then commit: `git commit -m "feat: persist culling sessions and undo"`

### Task 4: Metadata, images, scanner, and demo album

**Files:**
- Create: `src/server/adapters/metadata.ts`
- Create: `src/server/adapters/image.ts`
- Create: `src/server/scanner.ts`
- Create: `src/server/demo.ts`
- Test: `src/server/scanner.test.ts`
- Test: `src/server/adapters/image.test.ts`

**Interfaces:**
- Produces: `MetadataAdapter.read/readRaw/writeRating/extractPreview`, `ImageAdapter.thumbnail/differenceHash/inspect`, `scanAlbum(options, onProgress)`, and `createDemoAlbum()`.
- Scanner progress is `{ phase: "inventory" | "metadata" | "hashing" | "grouping"; completed: number; total: number }`.

- [ ] **Step 1: Write a failing scanner integration test with fakes**

```ts
it("pairs, enriches, hashes, groups and reports progress", async () => {
  const result = await scanAlbum({ root: fixtureRoot, metadata: fakeMetadata, images: fakeImages, sessionStore }, (event) => events.push(event));
  expect(result.photos[0]).toMatchObject({ capturedAtMs: 1000, perceptualHash: "0000000000000000" });
  expect(result.groups[0].photoIds).toEqual(result.photos.map((item) => item.id));
  expect(events.at(-1)).toMatchObject({ phase: "grouping", completed: 1, total: 1 });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/scanner.test.ts src/server/adapters/image.test.ts`

Expected: FAIL with missing scanner and adapters.

- [ ] **Step 3: Implement adapters and bounded scanning**

ExifTool reads metadata with a four-process pool and a 30-second task timeout. Scanner concurrency is eight metadata reads and four image operations. Sharp uses autorotation, `fit: "inside"`, sRGB output, and no upscaling. dHash requests raw 9x8 grayscale pixels. Cache keys include canonical path, size, mtime, width, and height.

- [ ] **Step 4: Implement deterministic demo data**

Create three burst groups with 5, 7, and 4 local SVG portraits, distinct timestamps, paired-file labels, and zero ratings. Demo export endpoints remain previews and never write a filesystem source.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/server/scanner.test.ts src/server/adapters/image.test.ts && pnpm typecheck`

Expected: all pass.

Run `git add -A`, then commit: `git commit -m "feat: scan and analyze local photo folders"`

### Task 5: Secure local HTTP service

**Files:**
- Create: `src/shared/api.ts`
- Create: `src/server/adapters/folder-picker.ts`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Test: `src/server/app.test.ts`

**Interfaces:**
- Consumes: scanner, session service, demo album, export services from Tasks 7 and 8 through injected optional interfaces.
- Produces: `createApp(dependencies)`, `startServer()`, and versioned `/api/v1` endpoints.

- [ ] **Step 1: Write failing security and rating route tests**

```ts
it("rejects a mutating request without the process token", async () => {
  const response = await request(app).patch("/api/v1/photos/p1/rating").send({ rating: 3 });
  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe("INVALID_TOKEN");
});

it("accepts a valid token and validates the rating", async () => {
  const response = await request(app).patch("/api/v1/photos/p1/rating").set("x-burstpick-token", token).send({ rating: 5 });
  expect(response.status).toBe(200);
  expect(response.body.data.photo.rating).toBe(5);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/app.test.ts`

Expected: FAIL with missing app module.

- [ ] **Step 3: Implement typed envelopes and security**

Generate 32 random bytes as a hex token. Require exact token match for all non-GET requests and reject non-loopback startup hosts. Validate bodies with Zod. Map domain errors to stable 400/403/404/409/500 envelopes. Do not include absolute paths or stack traces in responses.

- [ ] **Step 4: Implement the macOS picker boundary and startup**

Use `spawn("osascript", ["-e", script])` without a shell. The script returns a POSIX folder path; cancellation maps to `PICKER_CANCELLED`. Manual paths are canonicalized and must be readable directories. Startup mounts Vite middleware in development, built assets in production, and prints the complete tokenized URL.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/server/app.test.ts && pnpm typecheck && pnpm lint`

Expected: all pass.

Run `git add -A`, then commit: `git commit -m "feat: expose secure local photo API"`

### Task 6: Grid culling client and keyboard workflow

**Files:**
- Create: `index.html`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/api.ts`
- Create: `src/client/use-album.ts`
- Create: `src/client/use-culling-keys.ts`
- Create: `src/client/components/Welcome.tsx`
- Create: `src/client/components/TopBar.tsx`
- Create: `src/client/components/GroupRail.tsx`
- Create: `src/client/components/PhotoGrid.tsx`
- Create: `src/client/components/Loupe.tsx`
- Create: `src/client/components/ExportPanel.tsx`
- Create: `src/client/styles.css`
- Test: `src/client/App.test.tsx`
- Test: `src/client/components/PhotoGrid.test.tsx`

**Interfaces:**
- Consumes: `/api/v1` contracts and `AlbumSession`.
- Produces: accessible browser workflow, optimistic rating updates with rollback, and all specified keyboard commands.

- [ ] **Step 1: Write failing UI behavior tests**

```tsx
it("rates the focused photo with a numeric key and announces it", async () => {
  render(<PhotoGrid group={group} photos={photos} onRate={onRate} />);
  await user.click(screen.getByRole("button", { name: /DSC_0001/ }));
  await user.keyboard("3");
  expect(onRate).toHaveBeenCalledWith("p1", 3);
  expect(screen.getByRole("status")).toHaveTextContent("DSC_0001，3 星");
});

it("does not capture rating keys while an input is active", async () => {
  render(<WorkspaceFixture />);
  await user.click(screen.getByLabelText("分组灵敏度"));
  await user.keyboard("5");
  expect(onRate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/client/App.test.tsx src/client/components/PhotoGrid.test.tsx`

Expected: FAIL with missing components.

- [ ] **Step 3: Implement the welcome and album state flow**

The welcome view offers `选择照片文件夹`, a manual path field, and `体验示例相册`. `useAlbum` loads snapshots, subscribes to SSE progress, makes optimistic commands, rolls back rejected commands, and restores token from the startup query into session storage before removing it from visible history.

- [ ] **Step 4: Implement the culling workspace**

Use semantic buttons for photos, CSS grid with `repeat(auto-fill, minmax(180px, 1fr))`, roving focus based on DOM positions, star labels that never rely on color alone, lazy thumbnail loading, multi-select, filter `全部/已评分/未评分`, loupe dialog, group rail, visible shortcuts, split/merge, sensitivity control, and undo.

- [ ] **Step 5: Implement responsive visual design**

Use a charcoal photo-viewing surface, warm neutral chrome, amber selection, system Chinese fonts, restrained motion honoring `prefers-reduced-motion`, 44px minimum pointer targets, and breakpoint reflow at 760px. Do not hide core operations behind hover-only controls.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run src/client && pnpm typecheck && pnpm lint && pnpm build`

Expected: all pass and `dist` contains client and server outputs.

Run `git add -A`, then commit: `git commit -m "feat: add keyboard-first burst culling UI"`

### Task 7: Transactional Lightroom metadata export

**Files:**
- Create: `src/server/export/metadata-export.ts`
- Create: `src/server/export/metadata-snapshot.ts`
- Create: `tests/fixtures/existing-lightroom.xmp`
- Test: `src/server/export/metadata-export.test.ts`

**Interfaces:**
- Consumes: `PhotoUnit`, `Rating`, `MetadataAdapter`, `ImageAdapter`.
- Produces: `previewMetadataExport(session)`, `commitMetadataExport(plan, confirmation)`, and `rollbackMetadataExport(auditId)`.

- [ ] **Step 1: Write failing preservation and rollback tests**

```ts
it("changes only Rating in an existing Lightroom sidecar", async () => {
  const before = await metadata.readRaw(xmpPath);
  const result = await exporter.commit(planFor(rawPair, 4), confirmation);
  const after = await metadata.readRaw(xmpPath);
  expect(after.Rating).toBe(4);
  expect(withoutVolatileRating(after)).toEqual(withoutVolatileRating(before));
  expect(result.items[0].status).toBe("written");
});

it("restores the RAW sidecar when paired JPEG verification fails", async () => {
  images.inspect.mockRejectedValueOnce(new Error("decode failed"));
  await expect(exporter.commit(planFor(rawPair, 5), confirmation)).rejects.toMatchObject({ code: "PAIR_VERIFY_FAILED" });
  expect(await fs.readFile(xmpPath, "utf8")).toBe(originalXmp);
  expect(await fs.readFile(jpegPath)).toEqual(originalJpeg);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/export/metadata-export.test.ts`

Expected: FAIL with missing exporter.

- [ ] **Step 3: Implement dry-run conflict detection**

Record canonical target path, kind, rating, size, mtime, content hash for sidecars, and normalized metadata excluding `Rating`, `MetadataDate`, and ExifTool bookkeeping warnings. Reject stale sources, unwritable parents, demo albums, missing confirmation IDs, and any target outside the active source root.

- [ ] **Step 4: Implement one-pair transactions**

Prepare sibling temporary targets, write `XMP-xmp:Rating` through the metadata adapter, verify rating and protected metadata, inspect JPEG/DNG dimensions and thumbnail decode, rename originals to transaction backups, rename prepared targets into place, final-read both targets, then remove backups. On any error restore originals in reverse order and retain a redacted audit record.

- [ ] **Step 5: Add endpoints and UI confirmation**

Wire preview, commit, and most-recent rollback to the app and `ExportPanel`. Require the user to check `我已保存 Lightroom 元数据并关闭 Lightroom` when the source is not demo. Show per-file success, skip, conflict, and error counts.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run src/server/export/metadata-export.test.ts src/server/app.test.ts src/client && pnpm typecheck`

Expected: all pass.

Run `git add -A`, then commit: `git commit -m "feat: export Lightroom ratings transactionally"`

### Task 8: Collision-safe selected-file copy export

**Files:**
- Create: `src/server/export/copy-export.ts`
- Test: `src/server/export/copy-export.test.ts`

**Interfaces:**
- Consumes: rated `PhotoUnit[]`, source root, destination root.
- Produces: `previewCopyExport`, `commitCopyExport`, progress callbacks, and JSON report.

- [ ] **Step 1: Write failing copy behavior tests**

```ts
it("copies RAW, JPEG and XMP for rated units and verifies hashes", async () => {
  const preview = await previewCopyExport(session, destination);
  expect(preview.items.map((item) => item.relativePath)).toEqual(["day/one.arw", "day/one.jpg", "day/one.xmp"]);
  const result = await commitCopyExport(preview, confirmation);
  expect(result.counts).toEqual({ copied: 3, skipped: 0, conflicts: 0, failed: 0 });
});

it("reports different existing content and never overwrites it", async () => {
  await fs.writeFile(destinationFile, "keep me");
  const preview = await previewCopyExport(session, destination);
  expect(preview.items[0].status).toBe("conflict");
  await commitCopyExport(preview, confirmation);
  expect(await fs.readFile(destinationFile, "utf8")).toBe("keep me");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/export/copy-export.test.ts`

Expected: FAIL with missing copy exporter.

- [ ] **Step 3: Implement preview and commit**

Canonicalize roots, reject equal or nested source/destination relationships, include only units rated 1–5, preserve relative paths, calculate required bytes, compare existing size then SHA-256, and classify each item as `copy`, `skip`, or `conflict`. Commit copies to `.burstpick-copy-<random>`, syncs, verifies SHA-256, and renames without overwriting.

- [ ] **Step 4: Add endpoints and UI progress**

Wire folder picking, preview, confirmation, commit, SSE progress, cancel-after-current-file, and downloadable JSON report into the API and `ExportPanel`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/server/export/copy-export.test.ts src/server/app.test.ts src/client && pnpm typecheck`

Expected: all pass.

Run `git add -A`, then commit: `git commit -m "feat: copy selected source pairs safely"`

### Task 9: Documentation, end-to-end verification, and release audit

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/demo.spec.ts`
- Create: `README.md`
- Create: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: the production application and demo album.
- Produces: documented one-command operation and acceptance evidence.

- [ ] **Step 1: Write the failing browser workflow**

```ts
const startUrl = process.env.BURSTPICK_URL ?? "http://127.0.0.1:43110/?token=e2e-token";

test("demo album supports culling, grouping and export preview", async ({ page }) => {
  await page.goto(startUrl);
  await page.getByRole("button", { name: "体验示例相册" }).click();
  await page.getByRole("button", { name: /DEMO_0001/ }).focus();
  await page.keyboard.press("3");
  await expect(page.getByRole("status")).toContainText("3 星");
  await page.keyboard.press("]");
  await expect(page.getByText(/第 2 组/)).toBeVisible();
  await page.getByRole("button", { name: "导出" }).click();
  await expect(page.getByText(/已评分 1 张/)).toBeVisible();
});
```

- [ ] **Step 2: Verify RED, then complete missing behavior**

Run: `pnpm test:e2e -- tests/e2e/demo.spec.ts`

Expected before fixes: FAIL at the first missing integration. Implement only the missing behavior until the scenario passes.

- [ ] **Step 3: Write the Chinese README**

Document Node/pnpm requirements, `pnpm install`, `pnpm dev`, `pnpm build && pnpm start`, folder permissions, shortcuts, formats, backups, rollback, Lightroom-before-import, Lightroom-after-import, RAW+JPEG import preference, privacy, tests, and first-release limitations. Include the warning that Lightroom's `从文件读取元数据` can overwrite catalog-only changes.

- [ ] **Step 4: Run full automated verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
```

Expected: every command exits 0 with zero failed tests and no browser console errors.

- [ ] **Step 5: Run a real-folder metadata safety smoke test**

Generate a temporary JPEG plus an existing Lightroom-style XMP fixture, scan it through the public API, rate it, run metadata preview and commit, then verify with ExifTool that both targets contain the rating and that the original protected tags remain byte-equivalent by normalized metadata comparison. Run only against the generated temporary folder, never personal photos.

- [ ] **Step 6: Audit the specification acceptance criteria**

For each of the twelve acceptance criteria in `docs/superpowers/specs/2026-07-11-burstpick-design.md`, record the proving test, command output, or manual browser observation in `docs/verification.md`. Any criterion without direct evidence remains incomplete.

- [ ] **Step 7: Commit the verified release**

Run: `git status --short && git diff --check`

Expected: only intended documentation and test changes are present and no whitespace errors are reported.

Run `git add -A`, then commit: `git commit -m "docs: document and verify BurstPick workflow"`
