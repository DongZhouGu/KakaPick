# Metadata Export Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Add real-time, cancellable metadata export progress.

**Architecture:** Instrument the existing transactional service, then wrap preview+commit in an application job with SSE, mirroring the hardened copy-job lifecycle. Keep existing direct endpoints for compatibility.

**Tech Stack:** TypeScript, Express, React, Zod, Vitest, Server-Sent Events.

## Tasks

- [ ] Add shared progress, job, terminal, and cancel schemas.
- [ ] Add failing service tests for scanning/writing/verifying progress and abort checks.
- [ ] Implement optional service callbacks and AbortSignal checks.
- [ ] Add failing app tests for metadata job start, SSE replay, completion, failure, cancellation, and duplicate-job rejection.
- [ ] Implement retained metadata jobs and endpoints.
- [ ] Add failing client API and component tests for event validation, progress rendering, cancellation, and terminal result.
- [ ] Replace blocking client metadata calls with the job workflow.
- [ ] Run full tests, typecheck, lint, build, diff review, and code review.
