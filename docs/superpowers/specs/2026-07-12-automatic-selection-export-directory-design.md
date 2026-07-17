# Automatic Selection Export Directory Design

## Problem

Copy export asks the user to choose a destination directory, then rejects a natural choice such as `<album>/选出` because nested source and destination roots are forbidden. The picker creates unnecessary friction and exposes a safety rule as a user-facing error.

## Intended behavior

- Starting “复制入选照片” requires no destination-folder picker.
- BurstPick derives a sibling directory from the active album: `<album-name>-精选` in the album parent's directory.
- An existing sibling directory with that name is reused.
- Existing identical files are skipped; existing files with different contents remain conflicts and are never overwritten.
- Source and destination must still be distinct, non-nested canonical directories. Symlink, inode, path traversal, race, and recovery protections remain unchanged.
- Demo export keeps its current in-memory preview behavior.
- The interface displays the generated destination name before and during export.

## Failure behavior

If the parent is not writable, the sibling path is unsafe, or the directory cannot be created safely, export stops with a specific destination-creation error. It must not fall back to a location inside the album or overwrite an unrelated non-directory entry.

## Implementation

Move destination derivation and safe creation to the server boundary, where the canonical source root is available. The copy-export service continues to receive a validated destination root and retains all of its existing publication protections. Remove the directory-selection step from the client copy flow and update API schemas accordingly.

## Tests

1. A source album automatically exports to an adjacent `<album-name>-精选` directory.
2. A pre-existing safe directory is reused with normal skip/conflict semantics.
3. A conflicting file or symlink at the derived path fails closed.
4. Source and destination remain non-nested.
5. The client starts preview directly and reports the generated directory name.

Run focused server, API, and export-panel tests, followed by the complete test suite, typecheck, lint, and build.
