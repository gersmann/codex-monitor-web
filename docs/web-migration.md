# Web Migration

This document is the canonical reference for the browser-based CodexMonitor migration.

## Goal

Run CodexMonitor as a browser UI backed by a local Node.js and TypeScript runtime. Rust is a parity reference for backend behavior, not a web runtime dependency.

## Architecture State

The browser UI path is working and the active web backend is the in-process TypeScript companion.

- Browser frontend: React + Vite
- Active web transport: Node.js server in `server/index.ts`
- Active backend core: `server/codex.ts`
- Vendored app-server client: `server/vendor/codexSdk.ts`
- Active parity policy: `server/parity.ts` + `server/parity.test.ts`
- Frontend compatibility seam: `src/services/tauri.ts` and `src/services/events.ts`
- Rust parity reference: `src-tauri/src/lib.rs` and `src-tauri/src/bin/codex_monitor_daemon.rs`

## Current Stage

The migration is no longer in architecture-buildout mode. The TS-only web backend is established and the remaining work is parity hardening and web-shell cleanup.

Current focus:

- Finish live-thread parity edge cases where the backend is idle but the UI can remain stuck in `Working...`
- Wire the remaining lower-priority app-server notifications that have real frontend value
- Remove the last native menu surfaces that still leak into the web experience
- Close the migration epic once the web path is stable enough to be treated as the default browser runtime

## Target Runtime Model

- Browser frontend: React + Vite
- Local backend process: Node.js
- Codex integration: vendored local app-server client
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
- Vendored local app-server shellout client
- Persistent app-server client reuse for metadata, account, and control-plane requests
- Direct app-server-backed thread start, turn start, turn interrupt, approval responses, and live server-request forwarding
- Live-thread parity for the TS web backend: turn completion clears processing immediately, turn snapshots hydrate final items without manual sync, and active-thread refresh/recovery is enabled in the web companion runtime
- Shell-out based external session discovery via `codex app-server`
- Thread controls for steer, review start, fork, compact, and app-server-backed run metadata
- Backend admin parity methods: `ping`, `daemon_info`, `daemon_shutdown`
- Explicit support policy for web-adapted and intentionally unsupported RPC methods
- App-server-backed metadata/account parity for `model_list`, `skills_list`, `apps_list`, `list_mcp_server_status`, `collaboration_mode_list`, `experimental_feature_list`, `account_rate_limits`, `account_read`, `codex_login`, and `codex_login_cancel`
- Metadata parity for `codex_doctor`, `generate_commit_message`, and `generate_agent_description`
- Local usage parity for `local_usage_snapshot` against `CODEX_HOME/sessions`
- Runtime Codex arg handoff parity for `set_workspace_runtime_codex_args`
- Agent settings parity backed directly by `CODEX_HOME/config.toml`, including managed agent CRUD and managed agent config TOML reads and writes
- Core git reads and actions through the local companion: status, diffs, log, commit diffs, remote detection, staging, commit/fetch/pull/push/sync, and branch list/create/checkout
- Worktree setup markers plus basic worktree add and rename flows
- Browser-safe event subscription and runtime guards for Tauri-only features
- Web-safe rendering fixes for messages, file previews, drag/drop hooks, liquid glass hooks, and usage widgets
- Sentry disabled in the web runtime
- GitHub parity for issues, pull requests, checkout, diff/comments, and repository creation
- Stable one-shot backend runtime plus explicit helper scripts for daemonized local server operation

### Partially Implemented

- App-server notification persistence is in place for core thread and turn lifecycle, and the frontend now handles `skills/changed`, `serverRequest/resolved`, `model/rerouted`, `configWarning`, `deprecationNotice`, and `item/mcpToolCall/progress`
- Live-thread parity is close, but still under hardening for rare stale-processing cases during resume/read reconciliation

### Not Implemented

- Frontend handling for some lower-priority app-server notifications such as fuzzy file search updates, OAuth completion, raw response items, and platform-specific warnings

### Explicit Support Policy

Web-adapted RPC methods:

- Runtime and backend identity: `ping`, `daemon_info`, `daemon_shutdown`, `app_build_type`, `is_mobile_runtime`, `is_macos_debug_build`
- Browser-only adapters: `open_workspace_in` (URL-only), `send_notification_fallback`

Intentionally unsupported RPC methods:

- Native shell and tray surfaces: `get_open_app_icon`, `menu_set_accelerators`, `set_tray_recent_threads`, `set_tray_session_usage`, `write_text_file`
- Desktop-only integrations: `dictation_*`, `tailscale_*`, `terminal_*`
- Codex self-update: `codex_update`

## Migration Direction

### Phase 1: Architecture Reset And TS Backend Cutover

- Keep the browser transport seam and restore the in-process TS backend as the active path
- Remove Rust daemon runtime assumptions from web mode
- Preserve request logging, WebSocket fanout, and browser-safe runtime guards

Status: complete.

### Phase 2: Vendor Codex Integration And App-Server Promotion

- Vendor the local app-server client into the repo
- Add typed app-server abstractions for missing control-plane features
- Route all Codex CLI and app-server calls through the vendored local layer

Status: complete for the core runtime path.

### Phase 3: Close Core Parity Gaps

- Use `src-tauri/src/lib.rs` and the Rust daemon as behavior references only
- Fill the remaining metadata, config, GitHub, and control-plane gaps in TS
- Keep desktop-only features out of the web runtime unless intentionally ported

Status: mostly complete.

### Phase 4: Parity Hardening

- Fix remaining live-thread correctness bugs in resume/read/event reconciliation
- Tighten app-server notification handling for less common but user-visible event families
- Keep the backend and frontend parity tests aligned with real failure cases found during daily use

### Phase 5: Web Shell Cleanup And Epic Closure

- Replace remaining native menu surfaces with web-safe menus
- Refresh the canonical docs and support-policy lists to match live state
- Close the migration epic once the remaining open web-only tasks are complete

## Active Tracking

The long-running migration work is tracked in `bd`:

- `CodexMonitor-ac41` Complete TS-only web backend migration
- `CodexMonitor-131d` Normalize stale in-progress app-server turns during resume/read
- `CodexMonitor-cea0` Replace remaining native menus outside sidebar with web menus

## Implementation Notes

- Keep the frontend contract in `src/services/tauri.ts` stable unless there is a deliberate product change.
- Prefer local typed abstractions around Codex CLI and app-server calls over ad hoc shellouts.
- Prefer capability-driven UI hiding over broken stubs.
- Keep desktop-only behavior out of the web path unless there is a strong product reason to port it.
- When backend behavior is shared conceptually with the Tauri app, use `src-tauri/src/lib.rs` as the parity reference.
