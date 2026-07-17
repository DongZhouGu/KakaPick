# Metadata Export Progress Design

## Goal

Replace the blocking Lightroom metadata-export request with a background job that reports real scan, write, and verification progress.

## Behavior

- Starting Lightroom export returns a job ID immediately.
- Server-Sent Events report `phase`, `completed`, `total`, and the current safe relative filename.
- Phases are `scanning`, `writing`, and `verifying`; each phase uses its own real denominator.
- The client renders a determinate progress bar, count, phase label, and current filename.
- A cancel action aborts scanning or triggers transactional rollback during mutation.
- Reconnecting to the event endpoint replays the latest progress or terminal result.
- Only one metadata job may run for an album at a time.
- Existing transactional safety, recovery, audit, and direct preview/commit endpoints remain intact.

## Architecture

Add optional progress and abort inputs to the metadata export service. Add application-level metadata jobs modeled after the existing copy jobs. A job performs preview then commit, stores its latest validated event, broadcasts over SSE, and retains its terminal result briefly for reconnects. The client uses dedicated start, subscribe, and cancel API helpers.

## Verification

Tests cover service progress, abort propagation, job lifecycle and replay, client event validation, determinate progress rendering, cancellation, and successful terminal results. Complete test, typecheck, lint, and build checks must pass.
