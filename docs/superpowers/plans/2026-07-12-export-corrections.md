# Export Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lightroom export write only the expected sidecar for RAW pairs and make copy export automatically use a safe adjacent `<album>-精选` directory.

**Architecture:** Keep transactional metadata and copy publication internals intact. Correct metadata target selection and volatility/cleanup at the metadata-export boundary; derive and safely create the copy destination at the HTTP application boundary, then pass the canonical directory into the existing copy service.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Express, React, Zod, Vitest, ExifTool, Sharp.

## Global Constraints

- RAW+JPEG pairs write only the RAW XMP sidecar; standalone JPEG and DNG remain directly writable.
- Existing copy files are skipped when identical and reported as conflicts when different; no overwrite behavior changes.
- Symlink, containment, inode, race, rollback, and audit protections remain fail-closed.
- No new dependencies.

---

### Task 1: Correct metadata export targets and comparison

**Files:**
- Modify: `src/server/export/metadata-export.test.ts`
- Modify: `src/server/export/metadata-export.ts`

**Interfaces:**
- Consumes: existing `createMetadataExportService` and `normalizeProtectedMetadata` exports.
- Produces: unchanged public metadata-export interfaces with corrected target selection.

- [ ] **Step 1: Write failing regressions**

Add tests asserting a CR3+JPEG pair previews only one `xmp` item, a standalone JPEG still previews one `jpeg` item, and normalization treats `MPImageStart`/`MPImageLength` as volatile while retaining an unrelated `CameraModelName` difference.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/export/metadata-export.test.ts`

Expected: the paired target count and MP-offset normalization assertions fail against current behavior.

- [ ] **Step 3: Implement minimal target and volatility changes**

Change target selection to:

```ts
if (photo.raw === undefined && photo.jpeg !== undefined) {
  specs.push({ kind: "jpeg", path: photo.jpeg.path, sourcePaths: [photo.jpeg.path] });
}
```

Add lowercase `mpimagestart` and `mpimagelength` to `VOLATILE_TOP_LEVEL_KEYS`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/server/export/metadata-export.test.ts`

Expected: all metadata-export tests pass.

### Task 2: Remove transaction-owned ExifTool backups

**Files:**
- Modify: `src/server/export/metadata-export.test.ts`
- Modify: `src/server/export/metadata-export.ts`

**Interfaces:**
- Consumes: `prepareTarget` transaction temporary path.
- Produces: exact-path cleanup of `${temporaryPath}_original` on success and failure.

- [ ] **Step 1: Write a failing cleanup regression**

Use a metadata-adapter test double whose `writeRating(path)` writes `${path}_original`; commit one XMP target and assert no `_original` file remains beside the source.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/export/metadata-export.test.ts -t "removes ExifTool backup"`

Expected: FAIL because the backup exists.

- [ ] **Step 3: Implement exact-path cleanup**

Track `const exifToolBackupPath = `${temporaryPath}_original`` and remove it with `rm(..., { force: true })` after verification and in the catch path. Do not use globbing.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/server/export/metadata-export.test.ts`

Expected: all metadata-export tests pass.

### Task 3: Derive and create the adjacent copy destination

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/server/app.test.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Consumes: `ExportContext.sourceRoot` and copy preview `minRating`.
- Produces: `CopyExportPreviewRequestSchema` containing only `minRating`; response gains `destinationName: string`.

- [ ] **Step 1: Write failing API tests**

Replace the picker-based copy-preview test with one whose source root is `<temp>/新疆婚礼`, posts `{ minRating: 1 }`, and asserts the service receives canonical `<temp>/新疆婚礼-精选`. Add cases proving an existing directory is reused and a symlink/non-directory at the derived path returns `UNSAFE_COPY_PATH` without calling the service.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/server/app.test.ts -t "copy"`

Expected: requests fail schema validation or attempt the old selection lookup.

- [ ] **Step 3: Implement safe destination creation**

At the copy-preview route, derive `join(dirname(sourceRoot), `${basename(sourceRoot)}-精选`)`. Use `mkdir(path, { recursive: false })`; on `EEXIST`, require `lstat` to report a non-symbolic-link directory, then canonicalize it. Pass it to `copyExport.preview` and return its basename as `destinationName`. Map unsafe creation to `UNSAFE_COPY_PATH`.

- [ ] **Step 4: Update schemas and verify GREEN**

Remove `selectionId` from `CopyExportPreviewRequestSchema`, add `destinationName` to `CopyExportPreviewResponseSchema`, and update demo handling.

Run: `pnpm vitest run src/server/app.test.ts src/shared/api.test.ts`

Expected: all selected tests pass.

### Task 4: Update the copy-export client flow

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/components/ExportPanel.test.tsx`
- Modify: `src/client/components/ExportPanel.tsx`

**Interfaces:**
- Consumes: `previewCopyExport(minRating)` and response `destinationName`.
- Produces: a picker-free copy workflow displaying the generated destination.

- [ ] **Step 1: Write failing component/API tests**

Enable/update the copy workflow test so one click calls `/exports/copy/preview` directly, never calls `/directories/pick`, displays `新疆婚礼-精选`, and starts the existing copy job.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run src/client/components/ExportPanel.test.tsx src/client/api.test.ts`

Expected: the client calls the picker or sends the obsolete selection ID.

- [ ] **Step 3: Implement the picker-free flow**

Change `previewCopyExport` to accept only `minRating`. Remove `pickDirectory` and selection state from `ExportPanel`; set the status from `preview.destinationName`. Rename the action to `复制到自动生成的精选文件夹` and update explanatory copy.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run src/client/components/ExportPanel.test.tsx src/client/api.test.ts`

Expected: selected client tests pass.

### Task 5: Full verification

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: verified application build.

- [ ] **Step 1: Run complete automated checks**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: every command exits 0 with no test failures or type/lint/build errors.

- [ ] **Step 2: Inspect final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only the planned export/API/client/test files are modified.
