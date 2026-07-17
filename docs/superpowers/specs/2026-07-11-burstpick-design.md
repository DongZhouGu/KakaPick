# BurstPick Design Specification

## Product intent

BurstPick is a local-first photo culling application for photographers who shoot RAW+JPEG bursts and finish their workflow in Lightroom Classic. Its first release runs as a browser interface backed by a local Node.js service. It must turn a folder of burst photos into rated Lightroom-compatible files without uploading images or modifying proprietary RAW files.

The primary success criterion is that a user can choose a real photo folder, review automatically detected burst groups in a grid, rate any number of photos with the keyboard, and either write those ratings safely for Lightroom or copy the selected RAW+JPEG pairs to a destination folder.

## Confirmed product decisions

- The first release is a local browser application; its boundaries must permit a later Tauri or Electron shell.
- The application processes RAW+JPEG captures and treats files with the same normalized stem in the same directory as one photo unit.
- Burst detection combines capture timing, available EXIF burst fields, and thumbnail perceptual similarity.
- The default culling workspace is a whole-burst grid with an optional single-photo loupe.
- A burst may contain any number of rated photos.
- Ratings use Lightroom's familiar `0` through `5` stars.
- Export supports both Lightroom-compatible metadata and copying selected source pairs.
- Images and metadata remain on the local machine.

## Scope

### Included

- Recursive folder scanning for JPEG and common camera RAW extensions: ARW, CR2, CR3, NEF, RAF, RW2, ORF, and DNG.
- RAW+JPEG pairing, including case-insensitive extensions and unmatched-file reporting.
- EXIF capture-time extraction with subsecond precision when available.
- Adaptive burst grouping and manual split/merge corrections.
- Lazy thumbnails, group navigation, keyboard rating, loupe, filters, progress, undo, and session resume.
- Rating export to RAW XMP sidecars and embedded JPEG XMP.
- Copy export for every file in a rated photo unit, including its XMP sidecar when present.
- A demo album so the interface can be evaluated without touching personal files.
- macOS native folder picking through a platform adapter, with manual-path fallback.

### Excluded from the first release

- Cloud upload, accounts, collaboration, or remote access.
- Automatic aesthetic scoring, face recognition, eye-open detection, or generative AI.
- Lightroom catalog database writes or a Lightroom plugin.
- Color correction, presets, cropping, or RAW development.
- Deletion or rejection of source images.
- Windows packaging and signed macOS distribution.

## User workflow

1. The user starts BurstPick and opens the tokenized localhost URL printed by the service.
2. On the welcome screen, the user chooses a source folder or opens the demo album.
3. The service scans supported files, reads metadata, pairs RAW+JPEG files, produces thumbnails and perceptual hashes, and emits progress.
4. The grouping engine sorts photo units by capture time and proposes burst groups. The user can adjust grouping sensitivity and manually split or merge groups.
5. The user opens a group. All members appear in a responsive grid. Arrow keys move focus, `0`–`5` set the rating, Space toggles the loupe, `[` and `]` change groups, and Command/Ctrl+Z undoes the latest rating or grouping action.
6. Ratings are persisted atomically after every change. Closing and reopening the same source folder restores the session when the file inventory still matches.
7. The export screen summarizes rated photos and offers a dry run for metadata writing or a destination folder for copy export.
8. A final report lists successes, skips, conflicts, and failures without deleting or silently overwriting any source.

## Architecture

BurstPick is a single TypeScript repository with three explicit domains:

- `shared`: serializable types, schemas, constants, and API contracts. It has no browser, Node, React, or filesystem dependency.
- `server`: local filesystem, ExifTool, thumbnail generation, grouping, persistence, export transactions, security, and HTTP/SSE endpoints.
- `client`: React routes, album state, culling UI, keyboard commands, accessibility, and API integration.

The local service binds only to `127.0.0.1`. At startup it creates an unguessable session token. Every mutating API call requires that token and a same-origin request. File operations are restricted to the active source folder and an explicitly chosen destination folder. A platform adapter owns macOS folder selection so a future desktop shell can replace it without changing album or UI logic.

Production uses the built client served by the local service. Development uses Vite middleware behind the same service so the browser remains on one origin.

## Core data model

```ts
type Rating = 0 | 1 | 2 | 3 | 4 | 5;

interface SourceFile {
  path: string;
  relativePath: string;
  kind: "raw" | "jpeg" | "xmp";
  size: number;
  modifiedAtMs: number;
}

interface PhotoUnit {
  id: string;
  stem: string;
  raw?: SourceFile;
  jpeg?: SourceFile;
  xmp?: SourceFile;
  capturedAtMs: number;
  captureTimeSource: "exif" | "file-mtime";
  cameraId?: string;
  burstId?: string;
  sequenceNumber?: number;
  perceptualHash?: string;
  rating: Rating;
}

interface BurstGroup {
  id: string;
  photoIds: string[];
  startedAtMs: number;
  endedAtMs: number;
  confidence: number;
  manual: boolean;
}

interface AlbumSession {
  schemaVersion: 1;
  sourcePathHash: string;
  inventoryFingerprint: string;
  boundaryOverrides: Array<{ action: "split" | "join"; leftPhotoId: string; rightPhotoId: string }>;
  photos: PhotoUnit[];
  groups: BurstGroup[];
  groupingSensitivity: number;
  history: SessionCommand[];
  updatedAt: string;
}
```

IDs are stable hashes of relative directory plus normalized stem. The source path itself is never sent to logs or exposed beyond the local UI. Sessions live under the user's BurstPick application-data directory, keyed by a hash of the canonical source path. Writes use a temporary file, `fsync`, and atomic rename.

## Scanning and pairing

The scanner walks the selected directory recursively while ignoring hidden directories, BurstPick backup directories, and destination directories nested beneath the source. It normalizes Unicode, extension case, and path separators but preserves the original path for I/O.

Files in the same directory with the same case-folded stem form a photo unit. At most one primary RAW and one primary JPEG are selected using an extension preference table; duplicate candidates are reported and never silently discarded. Existing same-stem XMP is attached to the unit. Unpaired RAW or JPEG files remain usable and receive a visible warning.

ExifTool is the metadata authority. Capture time uses `SubSecDateTimeOriginal`, then `DateTimeOriginal` plus subsecond fields, then filesystem modification time with a visible fallback badge. Camera serial/model and any available burst UUID, drive mode, image number, and sequence fields are normalized behind a metadata adapter.

For normal RAW+JPEG units, the JPEG is the preview source. For RAW-only units, the service attempts to extract the embedded preview through ExifTool. Thumbnail output is cached by a key containing source path, size, mtime, and requested dimensions.

## Hybrid burst grouping algorithm

Photo units are sorted by `capturedAtMs`, then stable ID. Grouping occurs independently per camera ID when present.

1. Compute positive adjacent time gaps for the album.
2. Keep gaps at or below five seconds and calculate their median `m` and median absolute deviation `mad`.
3. Calculate an adaptive base threshold `t = clamp(m + 3 * max(mad, 80 ms), 650 ms, 3500 ms)`.
4. Apply the user sensitivity multiplier in the range `0.5` through `2.0`.
5. For every adjacent pair:
   - split immediately when known camera IDs differ;
   - keep together when a shared burst ID exists;
   - keep together when sequence numbers are consecutive and the gap is at most `2t`;
   - keep together when the gap is at most `0.65t`;
   - split when the gap exceeds `1.6t`;
   - in the ambiguous band, keep together only when perceptual similarity is at least `0.72`.

Perceptual similarity uses a 64-bit difference hash generated from a 9x8 grayscale thumbnail. Similarity is `1 - hammingDistance / 64`. It is a boundary hint, not an aesthetic score. Missing EXIF or hash data degrades to timing rules rather than failing the scan.

Manual split and merge commands are stored after automatic groups and re-applied by stable photo IDs whenever the inventory fingerprint still contains their members. A changed inventory triggers regrouping while preserving ratings for unchanged photo IDs.

## Culling interface

The visual hierarchy prioritizes photographs rather than application chrome:

- A compact top bar shows album name, scan/export state, rated count, filter, and settings.
- A narrow group rail shows chronological burst groups, item count, rated count, and current position.
- The main workspace renders the selected burst as a responsive grid. Grid cells preserve aspect ratio, show a clear focus ring, and display only filename, rating, pairing warning, and selection state.
- Clicking a grid cell focuses it. Double-click or Space opens a dark loupe with pixel-fit and 100% modes.
- A bottom shortcut strip is visible until dismissed and remains available from Help.

Keyboard behavior is deterministic and ignored while a text or range input is active:

- Arrow keys: spatial focus movement.
- `0`–`5`: set rating for the focused photo.
- Shift+`0`–`5`: set rating for all currently multi-selected photos.
- Space: toggle loupe.
- `[` / `]`: previous or next burst group.
- `S`: split the group before the focused photo.
- `M`: merge the current group with the next group.
- Command/Ctrl+Z: undo.
- Escape: close loupe or clear multi-selection.

All functionality is available with pointer input, visible labels, native buttons, keyboard focus, and screen-reader status announcements. The layout supports 320px width but is optimized for laptop and desktop screens.

## Rating persistence and Lightroom export

`xmp:Rating` is the only metadata field BurstPick changes. Valid values are zero through five. BurstPick never modifies proprietary RAW bytes or the Lightroom catalog.

### Proprietary RAW

- The target is the same-stem `.xmp` sidecar beside the RAW file.
- If the sidecar exists, ExifTool updates only `XMP-xmp:Rating` and preserves every other namespace and tag.
- If it does not exist, ExifTool creates a standards-compliant sidecar containing the rating and metadata needed to associate it with the source.
- Lightroom 15 `.acr` sidecars are not read, changed, renamed, or copied as an XMP substitute.

### JPEG and DNG

- ExifTool writes the same `XMP-xmp:Rating` into the file's embedded XMP.
- The image is processed one file at a time through a sibling temporary file.
- After writing, BurstPick reopens the file, verifies dimensions, decodes a thumbnail, confirms the rating, and confirms that a snapshot of protected XMP/EXIF fields is unchanged.

### Pair transaction

For each photo unit, the service snapshots source sizes, mtimes, existing rating, and protected metadata. It prepares all changes in sibling temporary files. It then verifies both outputs before atomically replacing either target. If the second replacement fails after the first succeeds, the first is restored from the retained transaction backup. Temporary backups are removed only after both targets pass a final read. A JSON audit record supports explicit rating rollback for the most recent export.

Before export, the UI performs a dry run and warns the user to save Lightroom catalog metadata to files and close Lightroom when the same folder is already imported. BurstPick does not attempt concurrent edits with Lightroom. For an already imported album, the completion screen explains how to use Lightroom's `Metadata > Read Metadata From File` command and that it may replace catalog-only metadata.

## Copy export

Copy export includes the RAW, JPEG, and existing/generated XMP for each photo rated at least one star. It preserves relative subdirectories under the chosen destination. Before copying, the service checks that source and destination are different canonical directories and estimates required space.

Collision behavior is deterministic:

- same relative path, size, and content hash: skip as already copied;
- same path but different content: leave the existing file untouched and report a conflict;
- no collision: copy to a temporary name, verify size and SHA-256, then rename atomically.

Canceling stops after the current file and leaves already verified copies intact. The report can be downloaded as JSON.

## HTTP contract

The service exposes versioned JSON endpoints under `/api/v1`:

- `GET /health`: version and readiness.
- `POST /directories/pick`: platform folder picker request.
- `POST /albums/open`: validate path and start/restore a scan.
- `GET /albums/:id/events`: server-sent scan and export progress.
- `GET /albums/:id`: session snapshot.
- `GET /photos/:id/thumbnail`: cached thumbnail bytes with size query.
- `PATCH /photos/:id/rating`: persist a rating command.
- `POST /photos/ratings`: atomically persist one exact rating for a nonempty unique list of photo IDs.
- `POST /groups/split`, `/groups/merge`, `/groups/regroup`: grouping commands.
- `POST /history/undo`: undo the latest session command.
- `POST /exports/metadata/preview`: metadata dry run.
- `POST /exports/metadata/commit`: token-confirmed metadata transaction.
- `POST /exports/metadata/rollback`: rollback the most recent completed rating export.
- `POST /exports/copy/preview`: copy size and conflict preview.
- `POST /exports/copy/commit`: token-confirmed copy transaction.

Every response uses a typed envelope containing either `data` or a stable error code, safe user message, and optional field details. Raw exception messages and unrestricted filesystem paths are never sent to the browser.

## Error handling

- Unsupported or corrupt files are skipped individually and included in the scan report.
- Missing EXIF falls back to mtime and is visible in the UI.
- Permission errors identify the affected relative file and offer retry after access is corrected.
- Source changes after scanning produce a conflict and require rescan; exports never use stale assumptions.
- ExifTool timeout, crash, or malformed output fails only the affected item and keeps its originals.
- Thumbnail failures show a retryable placeholder without blocking ratings.
- Session corruption moves the invalid file aside and starts a recoverable new session.
- All export operations are idempotent and emit structured audit records.

## Testing strategy

- Unit tests cover filename pairing, timestamp normalization, adaptive thresholds, perceptual hash similarity, boundary rules, manual overrides, rating commands, undo, path containment, and collision policy.
- Metadata fixture tests cover new RAW sidecars, existing Lightroom XMP with develop settings, JPEG embedded ratings, zero-star clearing, protected-field preservation, pair rollback, and concurrent source modification.
- Integration tests use temporary directories and adapter fakes to exercise scanning, persistence, API validation, export previews, and transaction failure recovery.
- React tests cover group-grid rendering, focus movement, rating shortcuts, loupe behavior, undo, empty/error states, and accessible names/status.
- Browser end-to-end tests use the demo album to cover opening, rating multiple photos, split/merge, reload persistence, filtering, and export preview.
- Completion requires unit/integration/UI tests, TypeScript checking, linting, production build, and a real browser smoke test with no console errors.

## Delivery and operation

The repository includes a Chinese README with prerequisites, installation, one-command development startup, production build/start, shortcut reference, Lightroom-before-import and Lightroom-after-import workflows, backup/rollback behavior, supported formats, and known first-release limitations.

The project targets Node.js 20 or newer on macOS 13 or newer. Dependencies are pinned in the lockfile. The service must not require administrator privileges, modify files outside explicitly selected roots, or listen on a non-loopback interface.

## Acceptance criteria

1. A real folder containing same-stem RAW+JPEG pairs can be scanned without uploading data.
2. The UI shows each pair once and reports unmatched or duplicate files.
3. Automatic burst groups are deterministic and combine time, EXIF burst information, and perceptual similarity.
4. Manual group corrections survive reload when their photo IDs remain valid.
5. The whole-burst grid supports mouse and documented keyboard rating for any number of photos.
6. Ratings survive reload and can be undone.
7. Metadata dry run shows every target and conflict before committing.
8. Export writes only `xmp:Rating`, preserves existing Lightroom metadata, never changes proprietary RAW bytes, and gives paired RAW/JPEG the same rating.
9. A failed pair write restores both targets to their pre-export state.
10. Copy export includes the rated RAW, JPEG, and XMP, verifies copies, and never overwrites a conflicting destination.
11. The demo workflow is usable without personal photos.
12. Automated verification, production build, and browser smoke testing all pass.
