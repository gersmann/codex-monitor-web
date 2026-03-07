# Web Migration

This document is the canonical reference for the browser-based CodexMonitor migration.

## Goal

Run CodexMonitor as a browser UI backed by the existing Rust remote backend and daemon, with only a thin web transport layer added on top. The Rust backend remains the source of truth for backend behavior and parity with the desktop app.

## Current State

The current web implementation proved the browser UI path, but it duplicated too much backend behavior in `server/`.

- Browser frontend: React + Vite
- Current temporary web backend: Node.js + TypeScript in `server/`
- Existing parity reference and backend core: Tauri app + Rust daemon
- Reusable remote backend transport entry point: `src-tauri/src/remote_backend/mod.rs`
- Reusable daemon RPC/event surface: `src-tauri/src/bin/codex_monitor_daemon.rs` and `src-tauri/src/bin/codex_monitor_daemon/rpc.rs`

## Target Runtime Model

- Browser frontend: React + Vite
- Local web transport process: thin Node.js or Rust-hosted adapter responsible for HTTP/WebSocket only
- Backend core: existing Rust daemon and remote backend RPC/event implementation
- Frontend compatibility seam: `src/services/tauri.ts` and `src/services/events.ts`

The web build should keep the frontend IPC contract as stable as possible and replace the Tauri invoke/event bridge with:

- HTTP RPC under `/api/rpc/<method>`
- WebSocket events under `/events`

The transport layer should forward requests and notifications to the Rust daemon instead of reimplementing backend behavior in TypeScript.

## In Scope

These areas are part of the intended web product:

- Workspace CRUD and persistence
- Prompt and agent configuration management
- Codex thread lifecycle
- External Codex session discovery and resume
- Streamed thread events
- Review, steer, fork, compact, and related thread controls
- Git and worktree features that operate on the local repo through the companion server
- GitHub issue and pull request read flows when they fit the git workflow
- Metadata and configuration parity needed for normal Codex usage

## Out Of Scope

These areas are currently excluded from the web migration plan:

- Dictation
- Tailscale helpers
- Tray integration
- Native menu accelerator management
- Desktop window effects and other shell chrome behavior
- Terminal / PTY management
- Native updater flows
- Other machine-level integrations that do not fit a browser UI cleanly

## Current State

### Implemented

- Browser-safe transport layer for the frontend service facade
- Local TypeScript companion server for app settings, workspaces, prompts, and threads
- Codex SDK-backed thread start and resume flows
- Shell-out based external session discovery via `codex app-server`
- Thread controls for steer, review start, fork, compact, and run metadata
- Core git reads and actions through the local companion: status, diffs, log, commit diffs, remote detection, staging, commit/fetch/pull/push/sync, and branch list/create/checkout
- Worktree setup markers plus basic worktree add/rename flows
- Browser-safe event subscription and runtime guards for Tauri-only features
- Web-safe rendering fixes for messages, file previews, drag/drop hooks, liquid glass hooks, and usage widgets
- Sentry disabled in the web runtime

### Partially Implemented

- Account and metadata APIs return compatibility responses but not full parity
- Agent settings work in the web companion but are not yet sourced from `CODEX_HOME/config.toml`
- The current web backend duplicates behavior that already exists in the Rust daemon and remote backend
- The current TypeScript backend should be treated as an interim compatibility layer, not the long-term backend source of truth

### Not Implemented

- GitHub issue and pull request API parity
- Full metadata parity for skills, MCP status, experimental features, and related config surfaces

## Parity Priorities

### Priority 1: Core Codex Thread Controls

Current status: implemented in the web companion. Keep this area covered with regression tests and manual runtime validation when Codex app-server behavior changes.

### Priority 2: Git And Worktree

Current status: the core repo-management and worktree path is implemented in the web companion. Remaining work is concentrated in GitHub-specific integrations and config/metadata parity.

## Pivot Plan

### Phase 1: Transport Reuse

- Reuse the existing daemon RPC and event surface instead of reimplementing `lib.rs` behavior in TypeScript
- Define a browser-safe transport adapter that maps:
  - HTTP requests to daemon RPC calls
  - WebSocket event streams to daemon event notifications
- Preserve the current frontend contract in `src/services/tauri.ts` and `src/services/events.ts`

Tracking:
- `CodexMonitor-42b0`

### Phase 2: Local Daemon Supervision

- Start and monitor the Rust daemon from web mode
- Handle local port allocation, readiness checks, auth token wiring, and clean shutdown
- Make the browser app depend on the daemon lifecycle, not on duplicated backend logic in `server/codex.ts`

Tracking:
- `CodexMonitor-1cd5`

### Phase 3: Frontend Cutover

- Retarget web runtime calls to the daemon-backed transport
- Keep browser-only concerns in the transport layer:
  - CORS-safe request handling
  - WebSocket subscription fanout
  - capability reporting
  - browser-safe URL/open/dialog behavior
- Avoid changing feature code outside the frontend transport seam unless required

Tracking:
- `CodexMonitor-c72d`

### Phase 4: Backend Deduplication

- Remove or greatly shrink the duplicated backend logic in `server/codex.ts`
- Keep only the pieces that are truly transport-only or browser-only
- Treat the Rust daemon as the backend source of truth for parity-sensitive behavior

Tracking:
- `CodexMonitor-08fa`

### Phase 5: Parity Validation And Cleanup

- Validate daemon-backed parity for the browser build against the desktop backend contract
- Document intentionally unsupported desktop-only surfaces
- Close remaining gaps in GitHub and config/metadata parity

Tracking:
- `CodexMonitor-f28b`
- `CodexMonitor-3e35`
- `CodexMonitor-f550`
- `CodexMonitor-9e2e`
- `CodexMonitor-bf58`

### Priority 3: Metadata And Config

- `CODEX_HOME/config.toml` integration
- Skills list parity
- MCP server status parity
- Experimental feature parity
- Account/config surfaces that affect visible UI state

These remove placeholder behavior and align the web build with the CLI and desktop app.

### Priority 4: GitHub Read Flows

- Issues list
- Pull request list
- Pull request diff
- Pull request comments
- PR checkout when it can be implemented safely on top of the git layer

These should follow, not block, the core git parity work.

## Active Tracking

The long-running migration work is tracked in `bd`:

- `CodexMonitor-3a81` Pivot web app backend to reuse Rust remote backend
- `CodexMonitor-9e2e` Use `CODEX_HOME/config.toml` as the source of truth for web companion agent settings
- `CodexMonitor-bf58` Improve metadata parity for web companion
- `CodexMonitor-3e35` Port GitHub issue and PR parity to web companion
- `CodexMonitor-f550` Port GitHub repo creation parity to web companion
- `CodexMonitor-42b0` Bridge web transport to Rust daemon RPC and events
- `CodexMonitor-1cd5` Add local daemon supervisor for web mode
- `CodexMonitor-c72d` Adapt frontend runtime to daemon-backed web transport
- `CodexMonitor-08fa` Retire duplicated TypeScript backend logic after daemon cutover
- `CodexMonitor-f28b` Validate daemon-backed web parity and document unsupported surfaces

## Implementation Notes

- Keep the frontend contract in `src/services/tauri.ts` stable unless there is a deliberate product change.
- Prefer reusing the Rust daemon and remote backend before adding new TypeScript backend logic.
- Prefer capability-driven UI hiding over broken stubs.
- Keep desktop-only behavior out of the web path unless there is a strong product reason to port it.
- When backend behavior is shared conceptually with the Tauri app, use `src-tauri/src/lib.rs` as the parity reference.
