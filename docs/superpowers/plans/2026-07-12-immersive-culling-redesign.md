# Immersive Culling Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dense whole-burst workspace with an immersive 1–4 photo stage that supports independent ratings, continuous keyboard advancement, hold-to-inspect at 100%, and a simplified completion flow.

**Architecture:** Keep the existing album hook, server session, rating API, grouping commands, and export services authoritative. Split display preferences, batch navigation, hold-to-inspect behavior, filmstrip navigation, and completion presentation into focused client modules; compose them in a smaller `CullingWorkspace` while preserving the existing `PhotoGrid` export surface only until its tests are migrated.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Playwright.

## Global Constraints

- Use the approved immersive dark visual direction and keep photographs visually dominant.
- Support `photosPerPage` values `1 | 2 | 3 | 4`, persisted locally, without changing server photo state.
- Rate every photo independently; do not introduce comparison, winner, or rejection semantics.
- Default `advanceAfterRating` to `true`, allow users to disable it, and never advance after a failed rating request.
- Move symmetrically across batches and groups while preserving stable server photo order.
- Hold Space for temporary 100% inspection and restore on keyup, blur, visibility loss, or unmount.
- Keep existing metadata and copy export safety behavior unchanged.
- Preserve keyboard accessibility, 44×44 px visible controls, 320 px layout support, and zero horizontal overflow.
- Follow TDD for every behavior change and keep existing tests green.

---

### Task 1: Validated culling preferences

**Files:**
- Create: `src/client/culling-preferences.ts`
- Test: `src/client/culling-preferences.test.ts`

**Interfaces:**
- Produces: `type PhotosPerPage = 1 | 2 | 3 | 4`, `interface CullingPreferences`, `readCullingPreferences(storage?: Storage): CullingPreferences`, and `writeCullingPreferences(preferences, storage?: Storage): void`.
- Default: `{ photosPerPage: 2, advanceAfterRating: true, groupToolsExpanded: false }`.

- [ ] **Step 1: Write failing preference tests**

```ts
it("uses the approved defaults when storage is empty or malformed", () => {
  expect(readCullingPreferences(memoryStorage())).toEqual({
    photosPerPage: 2,
    advanceAfterRating: true,
    groupToolsExpanded: false,
  });
});

it("round-trips only validated preferences", () => {
  const storage = memoryStorage();
  writeCullingPreferences({ photosPerPage: 4, advanceAfterRating: false, groupToolsExpanded: true }, storage);
  expect(readCullingPreferences(storage)).toEqual({ photosPerPage: 4, advanceAfterRating: false, groupToolsExpanded: true });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/client/culling-preferences.test.ts`

Expected: FAIL because `culling-preferences.ts` does not exist.

- [ ] **Step 3: Implement strict preference parsing**

Use one versioned key, `burstpick:culling-preferences:v1`. Parse JSON inside `try/catch`; accept only integers 1–4 and booleans, falling back field-by-field to defaults. Treat unavailable or throwing storage as defaults/no-op.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/client/culling-preferences.test.ts`

Expected: all preference tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/culling-preferences.ts src/client/culling-preferences.test.ts
git commit -m "feat: persist immersive culling preferences"
```

### Task 2: Batch navigation model and immersive photo stage

**Files:**
- Create: `src/client/culling-navigation.ts`
- Test: `src/client/culling-navigation.test.ts`
- Create: `src/client/components/PhotoStage.tsx`
- Test: `src/client/components/PhotoStage.test.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Produces: `visibleBatch(photoIds, focusedId, photosPerPage)`, `moveFocus(photoIds, focusedId, delta)`, and `PhotoStage`.
- `PhotoStage` consumes ordered `PublicPhotoUnit[]`, focused ID, `PhotosPerPage`, failure state, and pointer callbacks; it renders only the current batch and independent rating controls.

- [ ] **Step 1: Write failing navigation tests**

```ts
it("returns the batch containing focus and crosses boundaries symmetrically", () => {
  const ids = ["a", "b", "c", "d", "e"];
  expect(visibleBatch(ids, "c", 2)).toEqual(["c", "d"]);
  expect(moveFocus(ids, "d", 1)).toBe("e");
  expect(moveFocus(ids, "c", -1)).toBe("b");
});
```

- [ ] **Step 2: Verify navigation RED**

Run: `pnpm vitest run src/client/culling-navigation.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement pure navigation helpers**

Clamp invalid focus to the first item, compute batches from `Math.floor(index / photosPerPage)`, and return `undefined` only for empty arrays or movement beyond album boundaries.

- [ ] **Step 4: Write failing `PhotoStage` tests**

```tsx
it("renders two independently rated photos and moves focus by pointer", async () => {
  render(<PhotoStage photos={photos} focusedId="p1" photosPerPage={2} onFocus={onFocus} onRate={onRate} />);
  expect(screen.getAllByRole("article")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "将 DSC_0002 评为 4 星" }));
  expect(onRate).toHaveBeenCalledWith("p2", 4);
});
```

- [ ] **Step 5: Verify stage RED**

Run: `pnpm vitest run src/client/components/PhotoStage.test.tsx`

Expected: FAIL because `PhotoStage` does not exist.

- [ ] **Step 6: Implement `PhotoStage` and immersive CSS**

Render an `article` per visible photo with a focus button, image using `thumbnailUrl(photo.id)`, compact filename/pairing state, and six native rating buttons. Set `data-density` to the requested count and use CSS grid rules for 1–4 items, with responsive fallback that never changes the saved preference.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm vitest run src/client/culling-navigation.test.ts src/client/components/PhotoStage.test.tsx`

Expected: all navigation and stage tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/client/culling-navigation.ts src/client/culling-navigation.test.ts src/client/components/PhotoStage.tsx src/client/components/PhotoStage.test.tsx src/client/styles.css
git commit -m "feat: add immersive multi-photo stage"
```

### Task 3: Continuous rating, cross-group movement, and filmstrip

**Files:**
- Create: `src/client/components/Filmstrip.tsx`
- Test: `src/client/components/Filmstrip.test.tsx`
- Create: `src/client/components/CullingWorkspace.tsx`
- Test: `src/client/components/CullingWorkspace.test.tsx`
- Modify: `src/client/use-culling-keys.ts`
- Test: `src/client/App.test.tsx`
- Modify: `src/client/App.tsx`

**Interfaces:**
- `CullingWorkspace` consumes the album snapshot and controller command callbacks, and owns group index, focused ID, preferences, and batch transitions.
- `Filmstrip` consumes ordered photos, focused ID, and visible IDs; it exposes `onFocus(photoId)`.
- Extend `useCullingKeys` with keyup-safe inspection callbacks in Task 4 without changing editable-target protection.

- [ ] **Step 1: Write failing filmstrip tests**

```tsx
it("marks the focused and visible photos and jumps by stable ID", async () => {
  render(<Filmstrip photos={photos} focusedId="p2" visibleIds={["p1", "p2"]} onFocus={onFocus} />);
  expect(screen.getByRole("button", { name: /DSC_0002/u })).toHaveAttribute("aria-current", "true");
  await user.click(screen.getByRole("button", { name: /DSC_0003/u }));
  expect(onFocus).toHaveBeenCalledWith("p3");
});
```

- [ ] **Step 2: Verify filmstrip RED**

Run: `pnpm vitest run src/client/components/Filmstrip.test.tsx`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement `Filmstrip`**

Use native buttons with thumbnail images and accessible names including position and rating. Apply `aria-current` only to focused ID and a separate class to every visible ID.

- [ ] **Step 4: Write failing workspace tests**

Cover density changes, persisted auto-advance settings, successful rating advancement, rejected rating staying put, right movement into the next group, left movement back to the previous group, and advanced grouping tools collapsed by default.

```tsx
it("advances only after the rating promise resolves", async () => {
  const pending = deferred<void>();
  render(<CullingWorkspace album={album} onRate={() => pending.promise} {...commands} />);
  await user.keyboard("4");
  expect(screen.getByText("DSC_0001")).toHaveClass("is-focused");
  pending.resolve();
  await waitFor(() => expect(screen.getByText("DSC_0002")).toHaveClass("is-focused"));
});
```

- [ ] **Step 5: Verify workspace RED**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx`

Expected: FAIL because `CullingWorkspace` is missing.

- [ ] **Step 6: Implement continuous workspace behavior**

Move focus only after `await onRate(photoId, rating)` succeeds. When navigation returns beyond a group boundary, select the adjacent non-empty group and focus its first/last photo. Persist density, auto-advance, and advanced-tool expansion immediately. Keep undo, split, merge, regroup sensitivity, filters, and scan warnings accessible but visually secondary.

- [ ] **Step 7: Replace the old workspace composition in `App.tsx`**

Keep welcome/scanning/empty states unchanged. Pass the existing controller methods into `CullingWorkspace`, remove always-visible `GroupRail`, `PhotoGrid`, shortcut strip, and `ExportPanel` from the top-level composition, and preserve the fixture route used by release-surface tests.

- [ ] **Step 8: Verify GREEN**

Run: `pnpm vitest run src/client/components/Filmstrip.test.tsx src/client/components/CullingWorkspace.test.tsx src/client/App.test.tsx src/client/use-album.test.tsx`

Expected: all focused client tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/client/components/Filmstrip.tsx src/client/components/Filmstrip.test.tsx src/client/components/CullingWorkspace.tsx src/client/components/CullingWorkspace.test.tsx src/client/App.tsx src/client/App.test.tsx src/client/use-culling-keys.ts src/client/styles.css
git commit -m "feat: streamline continuous culling workflow"
```

### Task 4: Hold-to-inspect and simplified completion flow

**Files:**
- Create: `src/client/components/HoldToInspect.tsx`
- Test: `src/client/components/HoldToInspect.test.tsx`
- Create: `src/client/components/CompletionFlow.tsx`
- Test: `src/client/components/CompletionFlow.test.tsx`
- Modify: `src/client/components/CullingWorkspace.tsx`
- Modify: `src/client/components/ExportPanel.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- `HoldToInspect` consumes the focused photo and active state; it renders a non-modal inspection layer and owns pointer panning.
- `CompletionFlow` consumes album statistics, `isDemo`, and a close callback; it lazily reveals the existing metadata/copy export controls.

- [ ] **Step 1: Write failing hold-to-inspect tests**

```tsx
it("shows only while Space is held and clears on blur", async () => {
  render(<Harness />);
  fireEvent.keyDown(window, { key: " ", code: "Space", repeat: false });
  expect(screen.getByRole("region", { name: /100% 查看/u })).toBeVisible();
  fireEvent.blur(window);
  expect(screen.queryByRole("region", { name: /100% 查看/u })).not.toBeInTheDocument();
});
```

Also test keyup, repeated keydown, visibility change, unmount cleanup, and editable-target pass-through.

- [ ] **Step 2: Verify inspection RED**

Run: `pnpm vitest run src/client/components/HoldToInspect.test.tsx`

Expected: FAIL with missing component.

- [ ] **Step 3: Implement hold lifecycle**

Register keydown/keyup, blur, and visibility listeners in one effect. Ignore editable targets and repeated keydown. Render the focused thumbnail with natural-size/100% presentation and pointer-driven pan offsets. Provide a touch-safe press-and-hold button using pointer down/up/cancel/leave.

- [ ] **Step 4: Write failing completion-flow tests**

```tsx
it("shows a culling summary before exposing either export workflow", async () => {
  render(<CompletionFlow album={album} onClose={vi.fn()} />);
  expect(screen.getByText("12 张入选照片")).toBeVisible();
  expect(screen.queryByText("预览 Lightroom 评分")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "写入 Lightroom 星级" }));
  expect(screen.getByText("预览 Lightroom 评分")).toBeVisible();
});
```

- [ ] **Step 5: Verify completion RED**

Run: `pnpm vitest run src/client/components/CompletionFlow.test.tsx`

Expected: FAIL with missing component.

- [ ] **Step 6: Implement completion composition**

Show total, rated, and selected (`rating >= 1`) counts first. Expose exactly two main choices, then mount the matching existing `ExportPanel` section. Preserve demo preview-only restrictions, confirmations, conflict reporting, rollback, cancellation, and JSON report download.

- [ ] **Step 7: Integrate inspection and completion into workspace**

Wire focused photo into `HoldToInspect`; ensure rating/navigation keys do not fire while inspection is active. Add one primary “完成选片” action and restore the workspace unchanged when completion closes.

- [ ] **Step 8: Verify GREEN**

Run: `pnpm vitest run src/client/components/HoldToInspect.test.tsx src/client/components/CompletionFlow.test.tsx src/client/components/CullingWorkspace.test.tsx src/client/components/ExportPanel.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/client/components/HoldToInspect.tsx src/client/components/HoldToInspect.test.tsx src/client/components/CompletionFlow.tsx src/client/components/CompletionFlow.test.tsx src/client/components/CullingWorkspace.tsx src/client/components/ExportPanel.tsx src/client/styles.css
git commit -m "feat: add hold inspection and guided completion"
```

### Task 5: Browser workflow, documentation, and release verification

**Files:**
- Modify: `tests/e2e/demo.spec.ts`
- Modify: `README.md`
- Modify: `docs/verification.md`

**Interfaces:**
- Produces browser evidence for density, independent rating, automatic advancement, hold-to-inspect restoration, filmstrip navigation, advanced tools, completion flow, reload persistence, responsive layout, and existing safe exports.

- [ ] **Step 1: Rewrite the E2E workflow before production adjustments**

Use the demo album to select density 2, rate the two visible photos differently, assert focus advancement into the next batch, disable auto-advance and assert focus remains, hold/release Space and verify exact focus restoration, jump with the filmstrip, expand grouping tools, finish selection, and preview both export paths.

- [ ] **Step 2: Verify browser RED where new behavior is incomplete**

Run: `pnpm test:e2e`

Expected: failures must identify missing or incorrect redesigned behavior, not selector or infrastructure errors.

- [ ] **Step 3: Finish production behavior required by browser evidence**

Make only the smallest changes needed for the failing acceptance assertions. Keep desktop and mobile release-surface checks for horizontal overflow, 44×44 controls, console warnings/errors, and page errors.

- [ ] **Step 4: Update user documentation**

Document the 1–4 photo selector, independent ratings, default auto-advance setting, continuous batch/group navigation, hold-Space inspection, collapsed advanced grouping tools, and “完成选片” export entry. Remove instructions that describe Space as a modal toggle or imply an always-visible whole-burst grid.

- [ ] **Step 5: Run focused and full verification**

Run separately and require exit 0:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
pnpm test:metadata-smoke
CI=true pnpm vitest run tests/integration/dev-startup.test.ts
git diff --check
```

- [ ] **Step 6: Re-read every acceptance requirement**

Confirm the redesign spec has direct implementation and test evidence, and that the original 12 safety/behavior criteria remain true. Update `docs/verification.md` with exact test names rather than deleted temporary report paths.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/demo.spec.ts README.md docs/verification.md
git commit -m "docs: verify immersive culling workflow"
```
