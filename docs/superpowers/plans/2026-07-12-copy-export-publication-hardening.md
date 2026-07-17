# Copy Export Publication Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make copy publication fail closed across ancestor replacement, installed-file mutation, cleanup races, and directory-sync failures without deleting an inode the job does not own.

**Architecture:** Pin the confirmed destination root and each final parent with open directory handles plus canonical/lstat/fstat identity. Stage every file in one private `0700` directory directly below the pinned root, record ownership only after exclusive creation, publish with a no-clobber hard link, and condition every unlink on both pinned-directory identity and owned-inode equality. Verify the installed file after the post-link injection window and sync containing directories before reporting success.

**Tech Stack:** TypeScript, Node.js filesystem promises/FileHandle APIs, Vitest.

## Global Constraints

- Preserve source/destination root rejection, canonical containment, macOS case folding, no-clobber publication, cancellation between files, and redacted relative reporting.
- Node does not expose general `openat`; fail closed on detected identity drift and document the residual local same-user race.
- Never unlink a pathname unless its current lstat device/inode equals an inode exclusively created and tracked by this job and its pinned parent still matches.

---

### Task 1: Reproduce publication, cleanup, verification, and durability gaps

**Files:**
- Modify: `src/server/export/copy-export.test.ts`

**Interfaces:**
- Consumes: `CreateCopyExportServiceOptions.failureInjection` lifecycle stages.
- Produces: regressions for ancestor swaps, attacker replacements, post-install mutation, and directory sync failure.

- [x] **Step 1: Add failing tests** that replace a final ancestor before create/link/after link/cleanup, replace an owned temporary before cleanup, mutate the installed inode after link, and inject final-parent/report-directory sync failures.
- [x] **Step 2: Run `pnpm vitest run src/server/export/copy-export.test.ts`** and confirm failures demonstrate outside writes/deletes, false `copied`, or silent durability success.

### Task 2: Pin directories and own staging inodes

**Files:**
- Modify: `src/server/export/copy-export.ts`

**Interfaces:**
- Produces: pinned directory records with canonical path, open handle, fstat identity, and lstat identity; owned files recorded only after `wx` creation and fstat.

- [x] **Step 1: Implement directory pin/revalidation** with no-follow/open-directory flags where supported and canonical containment checks.
- [x] **Step 2: Create one private `0700` staging directory directly under the confirmed root**, pin it, and stream/generated-write bytes into exclusively created files there.
- [x] **Step 3: Run focused tests** and keep existing copy behavior green.

### Task 3: Harden publication, verification, cleanup, and fsync

**Files:**
- Modify: `src/server/export/copy-export.ts`
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: verified `copied`, safe `failed`, or `RECOVERY_REQUIRED`; durable final-parent and report publication.

- [x] **Step 1: Revalidate parent immediately before/after link**, verify final canonical containment plus lstat inode equality, then re-lstat/hash/size after the post-install hook before setting `copied`.
- [x] **Step 2: On mismatch, remove only an owned inode under a still-valid pinned parent** and sync the parent; otherwise retain and throw `RECOVERY_REQUIRED` with only the relative label.
- [x] **Step 3: Replace all unconditional `finally` unlinks** with inode- and parent-validated cleanup.
- [x] **Step 4: Sync final parents after publication/removal and the report directory after atomic report publication**, surfacing injected or real sync failures.
- [x] **Step 5: Run focused core/UI tests** and update schemas only if report status changes are required.

### Task 4: Document and verify

**Files:**
- Modify: `.superpowers/sdd/task-8-report.md`

**Interfaces:**
- Produces: review remediation evidence and residual-race disclosure.

- [x] **Step 1: Run focused core/UI, non-socket full suite, typecheck, lint, build, and diff-check.**
- [x] **Step 2: Append RED/GREEN evidence, counts, socket-suite limitation, and the residual same-user race caused by lack of general Node `openat`.**
- [x] **Step 3: Commit the reviewed fix.**

### Task 5: Make every directory-entry mutation durable

**Files:**
- Modify: `src/server/export/copy-export.ts`
- Modify: `src/server/export/copy-export.test.ts`
- Modify: `.superpowers/sdd/task-8-report.md`

**Interfaces:**
- Produces: owning-directory fsync after every destination/report `mkdir`, `rmdir`, `link`, `unlink`, and exclusive staging/report temporary creation.

- [x] **Step 1: Add RED call-order and injected-failure tests** for nested final parents, staging lifecycle entries, report-directory creation, and report publication entries.
- [x] **Step 2: Replace recursive final-parent creation** with pinned component-by-component creation that syncs each owning parent before descending.
- [x] **Step 3: Route every entry mutation through pinned owner/root revalidation and fsync**, with operation-specific failure-injection evidence.
- [x] **Step 4: Run final verification, append evidence, and commit.**
