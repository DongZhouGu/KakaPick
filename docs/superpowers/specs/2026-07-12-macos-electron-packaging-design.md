# BurstPick macOS Electron Packaging Design

## Goal

Package BurstPick as a standalone Apple Silicon macOS application for local use. The resulting app must run without the source repository, pnpm, or a system Node.js installation. The build also produces a DMG for installation.

This first version is intended for the owner's Mac only. It uses ad-hoc signing and does not include Developer ID signing, notarization, auto-update, or Mac App Store support.

## Chosen Approach

Use Electron to preserve the existing React client and Node/Express backend. Electron supplies the desktop window, application lifecycle, and bundled Node runtime. The production package includes the compiled client, compiled server, required runtime dependencies, Sharp native binaries, and the vendored ExifTool distribution.

Tauri was rejected because retaining the Node backend would require a sidecar and extra lifecycle work, while replacing it would mean rewriting the image and metadata pipeline. A native Swift/WKWebView implementation was rejected because it would turn packaging into a product rewrite.

## Architecture

### Electron main process

The Electron main process owns the desktop lifecycle. On launch it:

1. Starts the existing Express application on loopback using an available local port.
2. Receives the server's authentication token without scraping console output.
3. Creates a `BrowserWindow` with Node integration disabled and context isolation enabled.
4. Loads the authenticated loopback URL in that window.
5. Stops the HTTP server cleanly when the application exits.

Only same-origin application navigation is allowed in the window. Unexpected external URLs open in the user's default browser. New-window requests are denied unless explicitly handled.

### Server integration

The existing server entry point will expose a programmatic start/stop boundary while preserving the current command-line entry point. Development commands continue to work as they do today.

Production static files are resolved correctly from both a normal build directory and the packaged Electron resources. User data remains under `~/Library/Application Support/BurstPick/`; it is not placed inside the application bundle.

### Renderer

The React client remains unchanged except where runtime URL assumptions require adjustment. It continues to communicate with the local Express server over the authenticated loopback origin. No Electron APIs are exposed to renderer code unless a concrete need is discovered during implementation.

## Packaging

Electron Builder will create:

- `KakaPick.app` for Apple Silicon macOS
- A drag-to-install `.dmg`

The package will include production dependencies and unpack native or executable resources that cannot run from an ASAR archive. The bundle identifier remains `com.burstpick.app`, the minimum macOS version remains 13, and the existing app icon is reused initially.

The app receives an ad-hoc signature suitable for this Mac. Developer ID signing and Apple notarization are deliberately out of scope.

## Error Handling

Startup failures show a native error dialog with a concise message and a log-file location, then exit cleanly. A port collision is avoided by requesting an available loopback port rather than killing unrelated processes. Server shutdown errors are logged without blocking application termination.

Production logs are stored in the standard BurstPick application-support or Electron log location rather than `/tmp` where practical.

## Compatibility

The first artifact targets Apple Silicon (`arm64`) only. Existing browser-based development and CLI scripts remain available. The obsolete path-dependent app launcher may remain as a historical artifact during implementation, but documentation will point to the packaged application.

## Verification

Implementation is complete when:

1. Existing unit tests, type checking, linting, and the web production build pass.
2. The Electron main-process lifecycle has focused automated coverage where feasible.
3. The macOS package command produces both `.app` and `.dmg` artifacts.
4. The packaged app passes `codesign --verify --deep --strict`.
5. Launching the packaged app opens the BurstPick UI in an Electron window, the health endpoint responds, and quitting leaves no BurstPick server process behind.
6. The packaged app can be moved outside the repository and launched without pnpm or the repository path.

## Non-goals

- Intel (`x64`) or universal binaries
- Developer ID signing and notarization
- Mac App Store sandboxing
- Automatic updates
- Rewriting the backend in Swift or Rust
- UI redesign unrelated to desktop packaging
