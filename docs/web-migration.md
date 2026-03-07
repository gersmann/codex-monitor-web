# Web Migration

This document is the canonical reference for the browser-based CodexMonitor migration.

## Goal

Run CodexMonitor as a browser UI backed by a local TypeScript companion server while preserving the core Codex workflow used by the current desktop app.

## Current Runtime Model

- Browser frontend: React + Vite
- Local companion backend: Node.js + TypeScript in `server/`
- Existing desktop backend: Tauri Rust app in `src-tauri/src/lib.rs`
- Compatibility seam: `src/services/tauri.ts` and `src/services/events.ts`

The web build keeps the frontend IPC contract as stable as possible and replaces the Tauri invoke/event bridge with:

- HTTP RPC under `/api/rpc/<method>`
- WebSocket events under `/events`

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
- Local companion server for app settings, workspaces, prompts, and threads
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
- Worktree lifecycle parity is still partial; upstream rename/apply flows remain less complete than the desktop app
- Thread control parity now routes through `codex app-server`, but this remains a regression-sensitive area because it spans SDK-managed threads and app-server requests

### Not Implemented

- Full worktree orchestration parity, especially patch application and deeper upstream-management behavior
- GitHub issue and pull request API parity
- Full metadata parity for skills, MCP status, experimental features, and related config surfaces

## Parity Priorities

### Priority 1: Core Codex Thread Controls

Current status: implemented in the web companion. Keep this area covered with regression tests and manual runtime validation when Codex app-server behavior changes.

### Priority 2: Git And Worktree

Current status: the core repo-management and worktree path is implemented in the web companion. Remaining work is concentrated in GitHub-specific integrations and config/metadata parity.

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

- `CodexMonitor-9e2e` Use `CODEX_HOME/config.toml` as the source of truth for web companion agent settings
- `CodexMonitor-bf58` Improve metadata parity for web companion
- `CodexMonitor-3e35` Port GitHub issue and PR parity to web companion
- `CodexMonitor-f550` Port GitHub repo creation parity to web companion

## Implementation Notes

- Keep the frontend contract in `src/services/tauri.ts` stable unless there is a deliberate product change.
- Prefer app-server parity when thread behavior already exists in `codex app-server`.
- Prefer capability-driven UI hiding over broken stubs.
- Keep desktop-only behavior out of the web path unless there is a strong product reason to port it.
- When backend behavior is shared conceptually with the Tauri app, use `src-tauri/src/lib.rs` as the parity reference.
