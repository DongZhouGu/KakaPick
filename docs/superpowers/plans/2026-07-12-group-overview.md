# Group Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an iOS Photos-style overview that shows every burst group, its collage cover, rating progress, and a direct route back into culling.

**Architecture:** A pure `GroupOverview` component derives card statistics from the current public album snapshot. `CullingWorkspace` owns overview visibility, current group selection, focus restoration, and shortcut suppression; no server API or persisted schema changes.

**Tech Stack:** React 19, TypeScript 5.5, CSS, Vitest, Testing Library, Playwright.

## Global Constraints

- Card order must exactly follow `album.groups`.
- Selecting a group focuses its first unrated photo, otherwise its first photo.
- Overview shortcuts must not mutate hidden culling state.
- No new server endpoint, dependency, or persisted preference.
- All visible controls remain at least 44px and mobile has no horizontal overflow.

---

### Task 1: Build the pure group overview

**Files:**
- Create: `src/client/components/GroupOverview.tsx`
- Create: `src/client/components/GroupOverview.test.tsx`

**Interfaces:**
- Consumes: `albumName: string`, `groups: readonly BurstGroup[]`, `photosById: ReadonlyMap<string, PublicPhotoUnit>`, `currentGroupId?: string`, `onBack(): void`, `onSelectGroup(index: number): void`.
- Produces: an `所有组` region containing summary text and accessible group-card buttons.

- [ ] **Step 1: Write failing tests**

Create a two-group fixture and assert the first card has a four-image collage, text `4 张 · 已评分 2 · 入选 1`, a 50% progress value, and `当前` state. Assert the second card skips a missing photo reference and calls `onSelectGroup(1)` when clicked. Assert `返回选片` calls `onBack`.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run src/client/components/GroupOverview.test.tsx`
Expected: FAIL because `GroupOverview` does not exist.

- [ ] **Step 3: Implement the minimal component**

Map group photo IDs through `photosById`, calculate rated and selected counts, render up to four `thumbnailUrl(photo.id, 480)` images, expose `data-cover-count`, and render native `<progress max={photos.length} value={rated}>`.

- [ ] **Step 4: Verify the tests pass**

Run: `pnpm vitest run src/client/components/GroupOverview.test.tsx`
Expected: PASS.

### Task 2: Integrate overview navigation and shortcut isolation

**Files:**
- Modify: `src/client/components/CullingWorkspace.tsx`
- Modify: `src/client/components/CullingWorkspace.test.tsx`

**Interfaces:**
- Consumes: `GroupOverview` from Task 1.
- Produces: `overviewOpen` workflow, title entry, selection focus policy, Escape/back restoration, and disabled culling shortcuts while overview is open.

- [ ] **Step 1: Write failing workspace tests**

Use a two-group album. Open `所有组`, click the second group, and assert the first unrated photo is focused. Reopen, press Escape, and assert the prior focus remains. While open, press `5`, `ArrowRight`, and `Space`; assert `onRate` is not called and no 100% region appears.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx`
Expected: FAIL because the overview entry and navigation do not exist.

- [ ] **Step 3: Implement workspace integration**

Add `overviewOpen`; change the group title to a button labelled `所有组`; conditionally render `GroupOverview` instead of `PhotoStage`, `Filmstrip`, and hints. Add `selectGroup(index)` that sets `groupIndex`, selects the first existing unrated group member or first existing member, then closes the overview. In the keyboard effect, handle Escape first and return immediately for every other key while the overview is open.

- [ ] **Step 4: Verify workspace tests pass**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx src/client/components/GroupOverview.test.tsx`
Expected: PASS.

### Task 3: Add iOS overview styling and browser coverage

**Files:**
- Modify: `src/client/styles.css`
- Modify: `tests/e2e/demo.spec.ts`
- Modify: `README.md`
- Modify: `docs/verification.md`

**Interfaces:**
- Produces: adaptive overview grid, collage layouts for one through four images, current-group styling, and documented user flow.

- [ ] **Step 1: Add failing E2E assertions**

Open `所有组`, assert three group cards and the global summary, select `第 2 组`, assert the workspace reports group 2, then reopen and use `返回选片`. Run the existing release-surface check at desktop and mobile sizes.

- [ ] **Step 2: Verify the focused E2E fails**

Run: `BURSTPICK_E2E_PORT=43111 pnpm test:e2e -- --grep "immersive"`
Expected: FAIL before overview integration and styles are complete.

- [ ] **Step 3: Implement responsive styles**

Add `.group-overview`, `.overview-header`, `.group-overview-grid`, `.group-overview-card`, `.group-cover`, `.group-card-meta`, and progress styles. Use `repeat(auto-fill,minmax(240px,1fr))` on desktop, two columns below 600px, and one column below 360px. Define cover layouts through `data-cover-count` and use iOS blue for current state.

- [ ] **Step 4: Update documentation**

Describe the top-title entry, group statistics, first-unrated focus behavior, and overview E2E evidence.

- [ ] **Step 5: Run complete verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && BURSTPICK_E2E_PORT=43111 pnpm test:e2e && pnpm test:metadata-smoke && git diff --check`
Expected: all commands exit 0; 0 test failures and no diff whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/verification.md src/client tests/e2e/demo.spec.ts
git commit -m "feat: add all-groups overview"
```
