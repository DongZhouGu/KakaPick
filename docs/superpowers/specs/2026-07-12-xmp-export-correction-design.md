# XMP Export Correction Design

## Problem

Metadata export currently expands a proprietary RAW+JPEG photo pair into two write targets: an XMP sidecar and the paired JPEG. This doubles the work, modifies a file the user does not expect to change, and makes large exports unnecessarily slow. Real Canon JPEGs also change internal MP-image offsets when ExifTool adds a rating. The safety comparison treats those layout offsets as protected metadata and rejects the valid write with `PAIR_VERIFY_FAILED`.

ExifTool additionally leaves `<temporary>_original` files when it writes the transaction's temporary copies. The transaction removes its own temporary path but does not remove this ExifTool-owned backup.

## Intended behavior

- A photo with a proprietary RAW source exports its rating only to the RAW sidecar XMP, whether or not a paired JPEG exists.
- A standalone JPEG continues to receive its rating directly because there is no RAW sidecar target.
- DNG remains directly writable.
- Metadata safety comparison ignores layout-only MP offset fields whose values necessarily move when metadata size changes. It continues to reject changes to substantive camera and image metadata.
- Preparation removes ExifTool `_original` backups for transaction-owned temporary paths on both success and failure.
- Transaction rollback and audit behavior remain unchanged.

## Implementation

Adjust target selection so the JPEG target is emitted only when the photo has no RAW source. Extend the volatile metadata-key set with the MP offset fields demonstrated by the real failing Canon JPEG. Add a small cleanup helper for the exact temporary backup path and invoke it from `prepareTarget` without broad globbing.

## Tests

Add regression coverage that first fails against the current behavior:

1. A proprietary RAW+JPEG pair produces one XMP target and never asks the metadata adapter to write the JPEG.
2. A standalone JPEG remains a direct metadata target.
3. MP-image layout offsets are excluded from protected metadata comparison while unrelated metadata remains protected.
4. ExifTool-style `_original` files associated with transaction temporary paths are removed after preparation.

Run the focused metadata-export tests, then the full test suite, typecheck, lint, and build.
