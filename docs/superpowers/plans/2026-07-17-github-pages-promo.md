# GitHub Pages Promo Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a self-contained KakaPick promotional site on GitHub Pages, align README product messaging, and prepare a GitHub Release with the verified Apple Silicon DMG.

**Architecture:** Add a framework-free `site/` static page and a minimal GitHub Pages Actions workflow. Keep all marketing content local and deterministic, reusing the approved brand tokens and product facts without shipping ignored campaign caches.

**Tech Stack:** HTML, CSS, inline SVG, GitHub Actions, Vitest, GitHub CLI

## Global Constraints

- Target the public `DongZhouGu/KakaPick` repository and its anonymous single-commit history.
- Do not add `marketing/`, `videos/`, generated caches, personal paths, photo data, or third-party tracking scripts.
- Keep the public product name as `咔咔选 KakaPick`; preserve the accurate ad-hoc signing and macOS 13+ Apple Silicon limitations.
- Release the existing `release/KakaPick-1.0.0-arm64.dmg` only after checking its checksum and code signature.

---

### Task 1: Static-site contract test

**Files:**
- Create: `tests/integration/site-content.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Pages site", () => {
  const html = readFileSync("site/index.html", "utf8");
  const workflow = readFileSync(".github/workflows/pages.yml", "utf8");

  it("contains the public product story and fixed release links", () => {
    expect(html).toContain("拍得多，也能选得快");
    expect(html).toContain("https://github.com/DongZhouGu/KakaPick");
    expect(html).toContain("/releases/download/v1.0.0/KakaPick-1.0.0-arm64.dmg");
  });

  it("does not load third-party scripts or expose ignored campaign paths", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/marketing|videos|\.venv|\/Users\//i);
  });

  it("uses the Pages deployment workflow", () => {
    expect(workflow).toContain("actions/deploy-pages");
    expect(workflow).toContain("path: site");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true pnpm vitest run tests/integration/site-content.test.ts`

Expected: FAIL because `site/index.html` and `.github/workflows/pages.yml` do not exist.

### Task 2: GitHub Pages site and deployment

**Files:**
- Create: `site/index.html`
- Create: `site/styles.css`
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Implement the static page**

Create a semantic page with the hero, value cards, workflow, product mockup, trust facts, FAQ, and footer described in the design. Use inline SVG for the logo and CSS-only interface cards; link the download button to `/releases/download/v1.0.0/KakaPick-1.0.0-arm64.dmg` and the source button to `https://github.com/DongZhouGu/KakaPick`.

- [ ] **Step 2: Implement Pages deployment**

Use `actions/configure-pages`, `actions/upload-pages-artifact` with `path: site`, and `actions/deploy-pages`, triggered on pushes to `main` and manual dispatch, with the minimum `pages: write` and `id-token: write` permissions.

- [ ] **Step 3: Run the site test**

Run: `CI=true pnpm vitest run tests/integration/site-content.test.ts`

Expected: PASS with 3 assertions groups.

### Task 3: README product-story refresh

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the public landing-page link and product narrative**

Add a Pages link near the title, a short problem/solution paragraph based on the approved campaign copy, a concrete workflow section, a capability table, and a clear download/source path. Keep all technical privacy, installation, and verification details accurate.

- [ ] **Step 2: Verify docs consistency**

Run: `rg -n 'KakaPick|本地|Lightroom|ad-hoc|release|Pages' README.md site/index.html`

Expected: README and site share the same public product name, privacy boundary, download artifact name, and signing caveat.

### Task 4: Release and full verification

**Files:**
- No tracked binary files; upload `release/KakaPick-1.0.0-arm64.dmg` to GitHub Release `v1.0.0`.

- [ ] **Step 1: Run the focused and full verification**

Run: `CI=true pnpm vitest run tests/integration/site-content.test.ts`, `CI=true pnpm test`, `CI=true pnpm typecheck`, and `CI=true pnpm lint`.

Expected: all commands exit 0; existing test counts remain green.

- [ ] **Step 2: Verify the release artifact**

Run: `codesign --verify --deep --strict release/mac-arm64/KakaPick.app`, `hdiutil verify release/KakaPick-1.0.0-arm64.dmg`, and `shasum -a 256 release/KakaPick-1.0.0-arm64.dmg`.

Expected: signature and DMG checks pass; checksum is recorded in the release notes.

- [ ] **Step 3: Create the release and push source changes**

Run: `gh release create v1.0.0 release/KakaPick-1.0.0-arm64.dmg --title "KakaPick v1.0.0" --notes-file /private/tmp/kakapick-release-notes.md`, then `git push origin codex/public-release:main`.

Expected: public Release `v1.0.0` contains the DMG and the Pages workflow can deploy from `main`.
