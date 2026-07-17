# KakaPick Brand Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the user-visible BurstPick identity with 咔咔选 / KakaPick, add a scalable logo and app icon, and unify the existing dark UI around the approved orange brand system without changing product behavior.

**Architecture:** Add one reusable React brand component and one canonical SVG asset, then consume them from the welcome and workspace surfaces. Centralize brand and semantic colors in CSS custom properties while retaining current components and interaction flow. Keep internal `burstpick` storage keys, API headers, package name, and application-data paths unchanged for compatibility.

**Tech Stack:** React 19, TypeScript, CSS, SVG, Vitest, Testing Library, Sharp, Vite.

## Global Constraints

- Chinese brand name is `咔咔选`; English brand name is `KakaPick`.
- Primary slogan is `拍得多，也能选得快。`.
- Functional explanation is `连拍自动成组，并排看清差异，快速完成评分、淘汰与导出。`.
- Brand orange is `#FF7A1A`; hover is `#FF8F3D`; pressed is `#E86100`.
- Preserve the existing information architecture, workflows, keyboard shortcuts, grouping, rating, rejection, persistence, and export behavior.
- Preserve internal `burstpick` identifiers and application-data paths.
- Rating remains yellow, rejection/error remains red, and success remains green.
- Do not add a runtime dependency.

---

### Task 1: Reusable Brand Mark

**Files:**
- Create: `src/client/components/BrandMark.tsx`
- Create: `src/client/components/BrandMark.test.tsx`
- Create: `src/client/assets/kakapick-mark.svg`

**Interfaces:**
- Produces: `BrandMark({ showName?: boolean, language?: "zh" | "en", className?: string }): JSX.Element`.
- Produces: canonical SVG asset with two offset rounded frames and a check mark.

- [ ] **Step 1: Write the failing component test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark.js";

describe("BrandMark", () => {
  it("renders an accessible Chinese lockup and hides decorative geometry", () => {
    const { container } = render(<BrandMark />);
    expect(screen.getByText("咔咔选")).toBeVisible();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("supports icon-only and English lockups", () => {
    const { rerender } = render(<BrandMark showName={false} />);
    expect(screen.queryByText("咔咔选")).not.toBeInTheDocument();
    rerender(<BrandMark language="en" />);
    expect(screen.getByText("KakaPick")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/client/components/BrandMark.test.tsx`

Expected: FAIL because `BrandMark.tsx` does not exist.

- [ ] **Step 3: Implement the component and canonical SVG**

Implement `BrandMark` with an inline `viewBox="0 0 48 48"` SVG: a rear rounded frame at `x=13 y=7 width=27 height=27`, a front rounded frame at `x=7 y=13 width=27 height=27`, and a round-capped check path `M15 27l6 6 13-15`. Use `currentColor`, `fill="none"`, and `strokeWidth="4"`. Add a sibling `<span className="brand-name">` only when `showName` is true.

Create the same geometry in `src/client/assets/kakapick-mark.svg` with brand orange `#FF7A1A` so it is the source for generated application assets.

- [ ] **Step 4: Run the component test**

Run: `pnpm vitest run src/client/components/BrandMark.test.tsx`

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/BrandMark.tsx src/client/components/BrandMark.test.tsx src/client/assets/kakapick-mark.svg
git commit -m "feat: add KakaPick brand mark"
```

### Task 2: User-Visible Identity and Product Copy

**Files:**
- Modify: `src/client/components/Welcome.tsx`
- Modify: `src/client/components/CullingWorkspace.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/App.test.tsx`
- Modify: `src/client/components/CullingWorkspace.test.tsx`

**Interfaces:**
- Consumes: `BrandMark` from Task 1.
- Produces: consistent visible identity on welcome, scanning, empty, and workspace surfaces.

- [ ] **Step 1: Update tests first**

Change the welcome assertions to require the heading `拍得多，也能选得快。`, visible text `咔咔选`, and the functional description beginning `连拍自动成组`. Add a workspace assertion that the home button has accessible name `返回咔咔选首页` and contains visible brand text.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm vitest run src/client/App.test.tsx src/client/components/CullingWorkspace.test.tsx`

Expected: FAIL on the old BurstPick name and old welcome heading.

- [ ] **Step 3: Apply the approved identity**

In `Welcome.tsx`, replace the temporary six-span mark and BurstPick eyebrow with `<BrandMark />`, change the heading to `拍得多，也能选得快。`, and change the body to `连拍自动成组，并排看清差异，快速完成评分、淘汰与导出。`. Keep the privacy line and all opening behavior unchanged.

In `CullingWorkspace.tsx`, replace the BurstPick text button content with `<BrandMark />` and set `aria-label="返回咔咔选首页"`.

In `App.tsx`, add icon-only `<BrandMark showName={false} />` to scanning and empty-album states without changing progress or reset logic.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run src/client/App.test.tsx src/client/components/CullingWorkspace.test.tsx src/client/components/BrandMark.test.tsx`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/Welcome.tsx src/client/components/CullingWorkspace.tsx src/client/App.tsx src/client/App.test.tsx src/client/components/CullingWorkspace.test.tsx
git commit -m "feat: apply KakaPick identity"
```

### Task 3: Brand Tokens and Visual Consistency

**Files:**
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: class names emitted by `BrandMark` and existing components.
- Produces: root tokens `--brand-orange`, `--brand-orange-hover`, `--brand-orange-pressed`, `--canvas`, `--surface`, `--surface-raised`, `--text-primary`, `--text-secondary`, `--success`, `--warning`, `--danger`, and `--rating`.

- [ ] **Step 1: Add token contract and logo styles**

Define the approved tokens on `:root`. Add `.brand-lockup`, `.brand-logo`, and `.brand-name` rules; size the welcome mark to 58px and the workspace mark to 24px. Retain the system font stack.

- [ ] **Step 2: Replace brand-purpose gold/blue values**

Change existing `--accent` and `--gold` aliases to `var(--brand-orange)`. Update primary-button, finish-button, focused photo border/glow, current filmstrip item, current overview card, and selected threshold controls to use the orange token and its hover/pressed variants. Do not change `.stage-rating`, rejected, saved, warning, or error colors except to reference their semantic tokens.

- [ ] **Step 3: Normalize major surfaces**

Use `--canvas`, `--surface`, `--surface-raised`, `--text-primary`, and `--text-secondary` for the welcome card, immersive shell, top bar, settings sheet, completion card, and buttons touched by the brand refresh. Preserve layout dimensions and responsive rules.

- [ ] **Step 4: Verify CSS and components**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run src/client/App.test.tsx src/client/components/CullingWorkspace.test.tsx`

Expected: commands exit 0 and focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/styles.css
git commit -m "style: unify KakaPick brand tokens"
```

### Task 4: Application Metadata, Icons, and Documentation

**Files:**
- Modify: `index.html`
- Modify: `README.md`
- Modify: `bin/BurstPick.app/Contents/Info.plist`
- Modify: `bin/BurstPick.app/Contents/Resources/AppIcon.png`
- Create: `public/favicon.svg`

**Interfaces:**
- Consumes: canonical SVG from Task 1.
- Produces: KakaPick browser title/favicon, macOS display name/icon, and public-facing README.

- [ ] **Step 1: Update metadata assertions through static checks**

After editing, these commands must succeed:

```bash
rg -q '<title>咔咔选 · KakaPick</title>' index.html
rg -q '<string>咔咔选</string>' bin/BurstPick.app/Contents/Info.plist
rg -q '^# 咔咔选 KakaPick$' README.md
```

- [ ] **Step 2: Update user-visible metadata**

Set the page title to `咔咔选 · KakaPick`, theme color to `#0B0C0E`, and add `<link rel="icon" href="/favicon.svg" />`. Change `CFBundleDisplayName` and `CFBundleName` to `咔咔选`; keep `CFBundleIdentifier` unchanged. Copy the canonical mark into `public/favicon.svg` with a dark rounded background suitable for browser display.

- [ ] **Step 3: Generate the macOS icon**

Use the already installed `sharp` dependency to render a 1024px PNG with a `#181A1E` rounded-square background, orange offset frames, and a warm-white check. Write the result to `bin/BurstPick.app/Contents/Resources/AppIcon.png`. Do not rename the bundle path or application-data directory.

- [ ] **Step 4: Rewrite README branding**

Change the heading and opening description to the approved brand, slogan, functional explanation, and three value points. Keep commands, internal paths, technical behavior, privacy guarantees, shortcut tables, and test instructions accurate; retain `BurstPick.app` where it is an actual current filesystem path.

- [ ] **Step 5: Verify assets and metadata**

Run the three `rg -q` checks above, then:

```bash
file bin/BurstPick.app/Contents/Resources/AppIcon.png
pnpm build
```

Expected: PNG reports 1024 x 1024 and the production build exits 0.

- [ ] **Step 6: Commit**

```bash
git add index.html README.md bin/BurstPick.app/Contents/Info.plist bin/BurstPick.app/Contents/Resources/AppIcon.png public/favicon.svg
git commit -m "docs: publish KakaPick product identity"
```

### Task 5: Full Regression and Visual Acceptance

**Files:**
- Modify only files required to fix brand-refresh regressions found by verification.

**Interfaces:**
- Consumes: completed brand component, UI copy, tokens, metadata, and assets.
- Produces: verified brand refresh with unchanged product behavior.

- [ ] **Step 1: Run full automated verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: every command exits 0.

- [ ] **Step 2: Run the existing browser acceptance suite**

Run: `pnpm test:e2e`

Expected: all existing end-to-end tests PASS with no workflow changes.

- [ ] **Step 3: Inspect user-visible legacy naming**

Run:

```bash
rg -n 'BurstPick' src index.html README.md bin/BurstPick.app/Contents/Info.plist
```

Expected: no user-visible product label remains; matches are limited to intentionally preserved compatibility paths or technical identifiers documented in the spec.

- [ ] **Step 4: Review the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional brand-refresh files are changed.

- [ ] **Step 5: Commit any verification fixes**

```bash
git add -u
git commit -m "fix: complete KakaPick brand migration"
```

Skip this commit when verification required no fixes.
