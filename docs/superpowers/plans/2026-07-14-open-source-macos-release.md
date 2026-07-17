# KakaPick Open Source macOS Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare KakaPick for public source release and produce a standalone Apple Silicon macOS app and DMG that do not depend on the repository, pnpm, or a system Node.js installation.

**Architecture:** Keep the existing React and Express application, add a small hardened Electron main process that starts and stops the loopback server, and package production output with Electron Builder. Preserve existing internal BurstPick storage identifiers for compatibility while using KakaPick for public product names.

**Tech Stack:** TypeScript, React, Express, Electron, Electron Builder, Vitest, Playwright, pnpm

## Global Constraints

- Target macOS 13+ on Apple Silicon (`arm64`).
- Use ad-hoc local signing; Developer ID notarization is out of scope.
- Preserve `com.burstpick.app`, `BurstPick` application-data paths, API headers, and browser storage keys.
- Do not overwrite or revert pre-existing working-tree changes.
- Do not publish personal filesystem paths, local environments, caches, build artifacts, or user photo data.
- Use the MIT license with `KakaPick contributors` as the copyright holder.

---

### Task 1: Open-source repository hygiene

**Files:**
- Modify: `.gitignore`
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Delete: `bin/burstpick`
- Delete: `bin/burstpick-launcher.applescript`
- Delete: `bin/BurstPick.app/Contents/**`

**Interfaces:**
- Produces: a repository without tracked machine-specific launchers and with public contribution, security, and licensing terms.

- [ ] Expand `.gitignore` for Electron artifacts, local caches, virtual environments, video-generation caches, and macOS metadata.
- [ ] Add the complete MIT license text using `KakaPick contributors`.
- [ ] Document setup, tests, pull-request expectations, and responsible vulnerability reporting without exposing a private address.
- [ ] Remove the obsolete launcher bundle that embeds a developer-specific project and pnpm path.
- [ ] Run `git grep -n -E '/Users/|Documents/dzgu|codex-runtimes'` and expect no matches outside test assertions or ignored untracked files.

### Task 2: Scanner resume performance

**Files:**
- Modify: `src/server/scanner.test.ts`
- Modify: `src/server/scanner.ts`

**Interfaces:**
- Consumes: existing `mapLimited` concurrency helper and `ImageAdapter` optional metrics.
- Produces: fast resume that indexes photos by ID and analyzes missing metrics with bounded concurrency.

- [ ] Add a test with multiple resumed photos that records concurrent sharpness work and verifies source descriptors remain refreshed.
- [ ] Run `pnpm vitest run src/server/scanner.test.ts` and verify the new concurrency assertion fails.
- [ ] Replace repeated `find`/`indexOf` and the serial loop with ID maps plus `mapLimited` at `IMAGE_CONCURRENCY`.
- [ ] Run the scanner test and verify it passes.

### Task 3: Electron desktop lifecycle and security

**Files:**
- Create: `src/electron/security.ts`
- Create: `src/electron/security.test.ts`
- Create: `src/electron/main.ts`
- Create: `tsconfig.electron.json`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `startServer({ port: 0, environment: "production", installSignalHandlers: false, folderPicker })`.
- Produces: Electron entry point `dist/electron/main.js`, same-origin navigation policy, native directory picker, single-instance behavior, and graceful server shutdown.

- [ ] Add failing pure tests proving only the active loopback origin is internal and only safe HTTP(S) external URLs may leave the app.
- [ ] Implement the URL policy and verify the focused tests pass.
- [ ] Implement the Electron main process with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, a native folder dialog, external-navigation denial, startup error dialog, and awaited shutdown.
- [ ] Add Electron and Electron Builder as exact dev dependencies and add `desktop:build`, `desktop:pack`, and `desktop:dist` scripts.
- [ ] Configure Electron Builder for `KakaPick.app`, `KakaPick-<version>-arm64.dmg`, `com.burstpick.app`, macOS 13, arm64, ASAR unpacking for Sharp and ExifTool, and the existing icon.
- [ ] Run `pnpm typecheck` and the Electron security test.

### Task 4: Public documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`
- Modify: `docs/verification.md`
- Modify: `docs/brand.md`
- Modify: `docs/README.md`

**Interfaces:**
- Produces: public install, source-build, architecture, privacy, packaging, and verification documentation consistent with the actual app.

- [ ] Rewrite Quick Start around the packaged KakaPick app and generic clone/install commands.
- [ ] Add clear platform status, privacy boundaries, screenshots/assets guidance, development commands, desktop packaging commands, and current limitations.
- [ ] Update architecture and brand references from the obsolete browser launcher to the Electron desktop lifecycle and packaged icon.
- [ ] Add the new release commands and artifact checks to verification docs.
- [ ] Scan all tracked text for machine-specific paths and stale `BurstPick.app` user-facing instructions.

### Task 5: Package and verify the Mac app

**Files:**
- Generated and ignored: `release/KakaPick.app/**`
- Generated and ignored: `release/KakaPick-1.0.0-arm64.dmg`

**Interfaces:**
- Produces: locally signed standalone `.app` and `.dmg` artifacts.

- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test:metadata-smoke` with permissions needed for loopback tests.
- [ ] Run `pnpm desktop:dist` and confirm both artifacts exist.
- [ ] Run `codesign --verify --deep --strict release/mac-arm64/KakaPick.app` and inspect `codesign -dv --verbose=4`.
- [ ] Copy the app to a temporary directory outside the repository and launch its executable with an isolated `HOME`.
- [ ] Verify the loopback health endpoint and production HTML respond, then terminate the app and confirm its server port closes.
- [ ] Inspect the packaged file list for source maps, tests, development tools, personal paths, and secrets.
- [ ] Record artifact names, sizes, hashes, test counts, and any Gatekeeper limitation in the final report.
