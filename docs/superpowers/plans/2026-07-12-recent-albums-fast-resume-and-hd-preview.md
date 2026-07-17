# Recent Albums, Fast Resume, and HD Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated album opening fast, expose privacy-safe recent folders on the welcome screen, and deliver Retina-quality culling previews.

**Architecture:** Move prior-session validation immediately after inventory so unchanged albums bypass metadata and hashing. Persist recent canonical paths in a server-only atomic registry while exposing only opaque IDs and display names. Let browsers choose appropriate preview sizes with `srcset`, keeping low-resolution filmstrip and overview images.

**Tech Stack:** React 19, TypeScript 5.5, Express 5, Zod 4, Sharp, Vitest, Testing Library, Playwright.

## Global Constraints

- Recent API responses never include absolute paths.
- Fast resume requires an exact inventory fingerprint match.
- Recent registry file mode is 0600 and parent directory mode is 0700.
- Main stage supports 640/1280/2048/3200 sources; inspect uses 4096.
- No new runtime dependency and no changes to RAW bytes.

---

### Task 1: Add the unchanged-inventory scan fast path

**Files:**
- Modify: `src/server/scanner.ts`
- Modify: `src/server/scanner.test.ts`

**Interfaces:**
- Produces: `scanAlbum` returns a prior session immediately after inventory when source hash, inventory fingerprint, photo IDs, and requested sensitivity match.

- [ ] **Step 1: Write the failing test**

Scan a fixture once, then scan again with the persisted session and spies whose metadata/hash operations throw. Assert the second result restores ratings, groups, boundary overrides, and history while metadata reads and hashes have zero calls.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/scanner.test.ts -t "skips enrichment"`
Expected: FAIL because the second scan calls metadata before loading the prior session.

- [ ] **Step 3: Implement the fast path**

After inventory and pairing, calculate source/fingerprint, load the prior session, and compare paired photo IDs plus sensitivity. Emit completed metadata, hashing, and grouping progress; save `{ ...prior, updatedAt }`; return pairing and fallback warnings. Keep the existing full path for any mismatch and reuse the already loaded prior session later.

- [ ] **Step 4: Verify GREEN and changed-inventory regression**

Run: `pnpm vitest run src/server/scanner.test.ts`
Expected: PASS, including existing changed-inventory tests.

### Task 2: Build a secure recent-albums registry

**Files:**
- Create: `src/server/recent-albums-store.ts`
- Create: `src/server/recent-albums-store.test.ts`

**Interfaces:**
- Produces: `RecentAlbumsStore.list(): Promise<RecentAlbumRecord[]>`, `resolve(id: string): Promise<RecentAlbumRecord | undefined>`, and `record(canonicalPath: string): Promise<RecentAlbumRecord>`.
- Record fields: `id`, `name`, `canonicalPath`, `lastOpenedAt`.

- [ ] **Step 1: Write failing store tests**

Assert record deduplicates by SHA-256 ID, sorts newest first, keeps eight entries, saves mode 0600, returns empty after corrupt JSON while quarantining it, and resolves a known ID.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/recent-albums-store.test.ts`
Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement the store**

Validate a strict versioned Zod document, use an app-data-local file, `mkdir(..., { mode: 0o700 })`, write a mode-0600 temporary file, sync, rename atomically, and quarantine invalid contents. Hash canonical paths and expose no module-level mutable state.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/server/recent-albums-store.test.ts`
Expected: PASS.

### Task 3: Expose and consume privacy-safe recent album APIs

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/client/api.ts`

**Interfaces:**
- Produces: `RecentAlbumSummarySchema { id, name, lastOpenedAt }`, `RecentAlbumsResponseSchema`, `getRecentAlbums()`, and `{ recentId }` in `OpenAlbumRequestSchema`.
- `createApp` consumes `recentAlbums` with `list`, `resolve`, and `record`.

- [ ] **Step 1: Write failing API tests**

Assert GET recent returns only id/name/time; POST open with a registered recent ID starts the same loader; invalid or missing IDs fail safely; responses never contain the canonical path; picker/manual/recent opening calls `record` after validation.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/app.test.ts -t "recent"`
Expected: FAIL because schemas, dependency, and route are missing.

- [ ] **Step 3: Implement schemas and server integration**

Add strict response schemas, dependency types, GET route, recentId resolution, and record-after-validation. In `startServer`, construct `RecentAlbumsStore(join(appDataRoot, "recent-albums-v1.json"))` and inject it.

- [ ] **Step 4: Implement client API**

Add `getRecentAlbums()` using `apiRequest("/albums/recent", RecentAlbumsResponseSchema)`.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm vitest run src/server/app.test.ts src/client/api.test.ts`
Expected: PASS.

### Task 4: Add recent albums to the welcome experience

**Files:**
- Modify: `src/client/components/Welcome.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/use-album.ts`
- Modify: `src/client/components/Welcome.test.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- `AlbumController` produces `recentAlbums` and `recentAlbumsError`.
- `Welcome` consumes summaries and opens `{ recentId }` with the summary name.

- [ ] **Step 1: Write failing component tests**

Assert two recent folders render newest-first, clicking one calls `onOpen({ recentId }, name)`, and a recent-list error leaves picker/manual/demo controls enabled.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/client/components/Welcome.test.tsx src/client/App.test.tsx`
Expected: FAIL because Welcome has no recent props or UI.

- [ ] **Step 3: Implement controller loading**

Fetch recent albums once while the phase is welcome, store summaries separately from fatal album errors, refresh after a successful non-demo open, and clear only the active album on reset.

- [ ] **Step 4: Implement the welcome cards and styles**

Render an iOS grouped `最近打开` section with folder icon, name, localized time, and chevron. Use buttons at least 44px; do not show paths.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm vitest run src/client/components/Welcome.test.tsx src/client/App.test.tsx src/client/use-album.test.tsx`
Expected: PASS.

### Task 5: Add Retina-aware stage and inspect previews

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Modify: `src/client/components/PhotoStage.tsx`
- Modify: `src/client/components/PhotoStage.test.tsx`
- Modify: `src/client/components/CullingWorkspace.tsx`
- Modify: `src/client/components/CullingWorkspace.test.tsx`

**Interfaces:**
- Produces: `thumbnailSrcSet(photoId, sizes = [640, 1280, 2048, 3200]): string` and density-aware `sizes` strings.

- [ ] **Step 1: Write failing URL and component tests**

Assert encoded srcset entries with width descriptors; stage images expose four candidates and mobile/density-aware sizes; inspect image URL contains width/height 4096.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/client/api.test.ts src/client/components/PhotoStage.test.tsx src/client/components/CullingWorkspace.test.tsx`
Expected: FAIL because srcset is absent and inspect remains 1600.

- [ ] **Step 3: Implement responsive sources**

Add the URL helper, apply `srcSet` and `sizes` only to stage images, retain a 640 fallback `src`, and change inspect to 4096.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/client/api.test.ts src/client/components/PhotoStage.test.tsx src/client/components/CullingWorkspace.test.tsx`
Expected: PASS.

### Task 6: Browser coverage, documentation, and release verification

**Files:**
- Modify: `tests/e2e/demo.spec.ts`
- Modify: `README.md`
- Modify: `docs/verification.md`

**Interfaces:**
- Produces: documented recent/fast/HD behavior and desktop/mobile acceptance coverage.

- [ ] **Step 1: Extend E2E assertions**

Assert stage images have `srcset` containing 3200w, inspect requests 4096, and returning home exposes the last real test folder when the warning fixture is opened. Keep path-redaction assertions.

- [ ] **Step 2: Update documentation**

Describe recent folders, exact-fingerprint fast restore, and adaptive high-resolution previews without claiming full RAW rendering where only an embedded preview exists.

- [ ] **Step 3: Run complete verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && BURSTPICK_E2E_PORT=43113 pnpm test:e2e && pnpm test:metadata-smoke && git diff --check`
Expected: all commands exit 0 with no failures.

- [ ] **Step 4: Commit**

```bash
git add README.md docs src tests
git commit -m "feat: add recent albums and fast HD resume"
```
