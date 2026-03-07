# Web Migration

This document is the canonical reference for the browser-based CodexMonitor migration.

## Goal

Run CodexMonitor as a browser UI backed by a local Node.js and TypeScript runtime. Rust is a parity reference for backend behavior, not a web runtime dependency.

## Architecture State

The browser UI path is working and the active web backend is the in-process TypeScript companion.

- Browser frontend: React + Vite
- Active web transport: Node.js server in `server/index.ts`
- Active backend core: `server/codex.ts`
- Vendored Codex runtime: `server/vendor/codex-sdk`
- Active parity policy: `server/parity.ts` + `server/parity.test.ts`
- Frontend compatibility seam: `src/services/tauri.ts` and `src/services/events.ts`
- Rust parity reference: `src-tauri/src/lib.rs` and `src-tauri/src/bin/codex_monitor_daemon.rs`

## Target Runtime Model

- Browser frontend: React + Vite
- Local backend process: Node.js
- Codex integration: vendored local app-server client with a small remaining SDK utility shim
- Frontend compatibility seam: `src/services/tauri.ts` and `src/services/events.ts`

The web build keeps the frontend IPC contract stable and exposes:

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

## Feature State

### Implemented

- Browser-safe transport layer for the frontend service facade
- In-process TS companion server for app settings, workspaces, prompts, and threads
- Vendored local Codex runtime and app-server shellout client
- Persistent app-server client reuse for metadata, account, and control-plane requests
- Direct app-server-backed thread start, turn start, turn interrupt, approval responses, and live server-request forwarding
- Shell-out based external session discovery via `codex app-server`
- Thread controls for steer, review start, fork, compact, and run metadata
- Backend admin parity methods: `ping`, `daemon_info`, `daemon_shutdown`
- Explicit support policy for web-adapted and intentionally unsupported RPC methods
- App-server-backed metadata/account parity for `model_list`, `skills_list`, `apps_list`, `list_mcp_server_status`, `collaboration_mode_list`, `experimental_feature_list`, `account_rate_limits`, `account_read`, `codex_login`, and `codex_login_cancel`
- Core git reads and actions through the local companion: status, diffs, log, commit diffs, remote detection, staging, commit/fetch/pull/push/sync, and branch list/create/checkout
- Worktree setup markers plus basic worktree add and rename flows
- Browser-safe event subscription and runtime guards for Tauri-only features
- Web-safe rendering fixes for messages, file previews, drag/drop hooks, liquid glass hooks, and usage widgets
- Sentry disabled in the web runtime

### Partially Implemented

- `generate_run_metadata` still uses a small SDK utility path instead of the app-server client
- App-server notification persistence is in place for core thread and turn lifecycle, and the frontend now handles `skills/changed` and `serverRequest/resolved`, but some secondary notification families still need parity work
- Agent settings work in the web companion but are not yet sourced from `CODEX_HOME/config.toml`
- `local_usage_snapshot`, `generate_commit_message`, and runtime Codex arg respawn behavior are not yet at daemon parity

### Not Implemented

- GitHub issue and pull request API parity
- Full metadata parity for skills, MCP status, experimental features, and related config surfaces
- Frontend handling for some web-relevant app-server notifications such as `model/rerouted`, config warnings, deprecation notices, and MCP progress updates

## Migration Direction

### Phase 1: TS Backend Reset

- Keep the browser transport seam and restore the in-process TS backend as the active path
- Remove Rust daemon runtime assumptions from web mode
- Preserve request logging, WebSocket fanout, and browser-safe runtime guards

### Phase 2: Vendor Codex Integration

- Vendor the Codex SDK runtime into the repo
- Add a local app-server client abstraction for missing control-plane features
- Route all Codex CLI and app-server calls through the vendored local layer

### Phase 3: Close Parity Gaps

- Use `src-tauri/src/lib.rs` and the Rust daemon as behavior references only
- Fill the remaining metadata, config, GitHub, and control-plane gaps in TS
- Keep desktop-only features out of the web runtime unless intentionally ported

## Active Tracking

The long-running migration work is tracked in `bd`:

- `CodexMonitor-ac41` Complete TS-only web backend migration
- `CodexMonitor-5a4d` Remove remaining SDK utility usage from TS web backend
- `CodexMonitor-9e2e` Use `CODEX_HOME/config.toml` as the source of truth for web companion agent settings
- `CodexMonitor-cf85` Validate TS-backed web parity and document unsupported surfaces
- `CodexMonitor-bf58` Improve metadata parity for web companion
- `CodexMonitor-3e35` Port GitHub issue and PR parity to web companion
- `CodexMonitor-f550` Port GitHub repo creation parity to web companion

## Implementation Notes

- Keep the frontend contract in `src/services/tauri.ts` stable unless there is a deliberate product change.
- Prefer local typed abstractions around Codex CLI and app-server calls over ad hoc shellouts.
- Prefer capability-driven UI hiding over broken stubs.
- Keep desktop-only behavior out of the web path unless there is a strong product reason to port it.
- When backend behavior is shared conceptually with the Tauri app, use `src-tauri/src/lib.rs` as the parity reference.
