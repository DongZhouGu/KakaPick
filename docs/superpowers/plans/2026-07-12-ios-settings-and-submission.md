# iOS Settings and Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded culling toolbar with an iOS-style settings sheet, visible save feedback, and a clear completion sheet.

**Architecture:** Extract settings and completion surfaces into focused React components while `CullingWorkspace` owns navigation, persistence callbacks, and transient save state. Keep all server APIs unchanged and restyle the workspace with local CSS only.

**Tech Stack:** React 19, TypeScript 5.5, CSS, Vitest, Testing Library, Playwright.

## Global Constraints

- Ratings remain immediately persisted to the local session.
- The only final output entry is the blue `完成` button.
- Settings use an iOS grouped-list sheet and all visible targets remain at least 44px.
- No new icon, component, or animation dependency.
- Existing metadata and copy-export safety behavior must remain unchanged.

---

### Task 1: Simplify persisted culling preferences

**Files:**
- Modify: `src/client/culling-preferences.ts`
- Modify: `src/client/culling-preferences.test.ts`

**Interfaces:**
- Produces: `CullingPreferences { photosPerPage, advanceAfterRating }` without presentation-only expansion state.

- [ ] **Step 1: Write the failing test**

Update the preference expectation so a stored `groupToolsExpanded` field is ignored and the returned object contains only `photosPerPage` and `advanceAfterRating`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/client/culling-preferences.test.ts`
Expected: FAIL because `groupToolsExpanded` is still returned.

- [ ] **Step 3: Write minimal implementation**

Remove `groupToolsExpanded` from `CullingPreferences`, defaults, parsing, and serialized values.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/client/culling-preferences.test.ts`
Expected: PASS.

### Task 2: Build the iOS settings sheet

**Files:**
- Create: `src/client/components/CullingSettings.tsx`
- Create: `src/client/components/CullingSettings.test.tsx`
- Modify: `src/client/components/CullingWorkspace.tsx`

**Interfaces:**
- Consumes: `CullingPreferences`, current sensitivity, current photo/group state, and existing merge/split/undo callbacks.
- Produces: `CullingSettings` dialog with `onClose`, `onPreferences`, `onSensitivity`, `onSplit`, `onMerge`, and `onUndo` callbacks.

- [ ] **Step 1: Write the failing component tests**

Test that `设置` opens a dialog named `选片设置`; selecting `每屏 1 张` changes the stage; toggling `评分后自动前进` changes behavior; group slider and action buttons call existing callbacks; `Escape` closes the dialog.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx src/client/components/CullingSettings.test.tsx`
Expected: FAIL because the dialog and component do not exist.

- [ ] **Step 3: Implement the focused component**

Create grouped sections for `浏览与评分`, `连拍分组`, and `数据与输出`. Use buttons with `aria-pressed` for density, a checkbox switch, range input with strict/loose labels, and the existing group action callbacks. Add `role="dialog"`, `aria-modal="true"`, a labelled title, backdrop close, and Escape handling.

- [ ] **Step 4: Integrate it into the workspace**

Replace the top-bar density and auto-advance controls plus the bottom advanced-grouping block with a single settings button and conditional `CullingSettings`. Keep the current focus and batch unchanged when opening or closing.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx src/client/components/CullingSettings.test.tsx`
Expected: PASS.

### Task 3: Expose rating save state and completion semantics

**Files:**
- Modify: `src/client/components/CullingWorkspace.tsx`
- Modify: `src/client/components/CullingWorkspace.test.tsx`

**Interfaces:**
- Produces: transient `idle | saving | saved | error` state rendered as an `aria-live` status; completion dialog remains backed by `ExportPanel`.

- [ ] **Step 1: Write failing tests**

Use a deferred `onRate` promise to assert `正在保存` before resolution and `已保存` after resolution. Reject once and assert `保存失败` with no focus advance. Assert `完成` opens `评分结果` with selected/rated/total counts and existing export actions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx`
Expected: FAIL because save state and renamed completion semantics are absent.

- [ ] **Step 3: Implement minimal state handling**

Set save state to `saving` before `onRate`, `saved` only when the result is not false, and `error` on false or rejection. Advance only on success. Render the localized state in a polite live region. Rename the action to `完成` and the dialog to `评分结果` while retaining `ExportPanel`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx`
Expected: PASS.

### Task 4: Apply the iOS visual system

**Files:**
- Modify: `src/client/styles.css`
- Modify: `tests/e2e/demo.spec.ts`

**Interfaces:**
- Consumes: the class names produced by `CullingWorkspace` and `CullingSettings`.
- Produces: responsive desktop sheet and mobile bottom sheet with system colors, grouped cards, segmented control, switch, and reduced-motion handling.

- [ ] **Step 1: Add failing browser assertions**

Update E2E selectors for `设置`, `选片设置`, and `完成`; verify the dialog opens at desktop and mobile sizes, settings remain operable, completion opens, and the document has no horizontal overflow.

- [ ] **Step 2: Run the focused E2E test**

Run: `pnpm test:e2e -- --grep "immersive"`
Expected: FAIL on the new selectors or responsive assertions.

- [ ] **Step 3: Implement the CSS visual system**

Define iOS dark tokens, simplify the top bar, use blue accent and focus rings, style the sheet backdrop/card/header/grouped rows/segmented control/switch/range, restyle focused photos and stars, and make the sheet bottom-aligned below 600px. Add a `prefers-reduced-motion: reduce` override.

- [ ] **Step 4: Run focused component and E2E tests**

Run: `pnpm vitest run src/client/components/CullingWorkspace.test.tsx src/client/components/CullingSettings.test.tsx && pnpm test:e2e -- --grep "immersive"`
Expected: PASS.

### Task 5: Update documentation and run release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/verification.md`

**Interfaces:**
- Produces: user documentation matching the settings and immediate-save behavior.

- [ ] **Step 1: Update user-facing documentation**

Describe the settings gear, immediate-save status, “连拍分组范围”, and the final `完成` action. Remove references to toolbar controls and the bottom `调整分组` disclosure.

- [ ] **Step 2: Run all verification gates**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e`
Expected: every command exits 0 with no failing tests.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git status --short`
Expected: no whitespace errors and only intended files modified.

- [ ] **Step 4: Commit the completed feature**

```bash
git add src/client docs README.md tests/e2e/demo.spec.ts
git commit -m "feat: add iOS-style culling settings"
```
