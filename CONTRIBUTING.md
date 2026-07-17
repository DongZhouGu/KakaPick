# Contributing to KakaPick

Thanks for helping improve KakaPick. Bug reports, focused fixes, tests, and documentation improvements are welcome.

## Development setup

KakaPick currently targets macOS 13 or newer and requires Node.js 20.3+ and pnpm 11.7.0.

Fork the repository on GitHub, clone your fork, and run the following commands from the repository directory:

```bash
pnpm install
pnpm dev
```

The local server must remain bound to `127.0.0.1`. Do not change it to a LAN-facing address.

## Before opening a pull request

Run the full local checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:metadata-smoke
```

Behavior changes should begin with a failing test. Changes that touch file operations, metadata, session persistence, or export behavior need focused safety tests as well as the full suite.

Keep pull requests narrow. Do not include personal photo libraries, application data, generated caches, local environment files, or machine-specific paths. Public API responses and logs must never expose users' absolute photo paths.

## Product and compatibility boundaries

- Do not modify proprietary RAW bytes.
- Do not silently overwrite export conflicts.
- Preserve the existing `BurstPick` application-data directory and internal storage keys unless a migration is included.
- Keep client code separated from real filesystem paths and native capabilities.
- Update the relevant file under `docs/` when product behavior, architecture, branding, or release commands change.

By contributing, you agree that your contribution is licensed under the MIT License in this repository.
