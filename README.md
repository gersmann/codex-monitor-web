# CodexMonitor

![CodexMonitor](screenshot.png)

CodexMonitor is a macOS Tauri app for orchestrating multiple Codex agents across local workspaces. It provides a sidebar to manage projects, a home screen for quick actions, and a conversation view backed by the Codex app-server protocol.

## Features (MVP)

- Add and persist workspaces using the system folder picker.
- Spawn one `codex app-server` per workspace and stream events over JSON-RPC.
- Restore threads per workspace from the Codex rollout history (`thread/list`) and resume on selection.
- Start agent threads, send messages, show reasoning/tool call items, and handle approvals.
- Git diff sidebar with per-file +/- counts (libgit2).
- Skills menu that inserts `$skill` tokens into the composer.
- Archive threads (removes from UI and calls `thread/archive`).
- macOS overlay title bar with vibrancy effects.

## Requirements

- Node.js + npm
- Rust toolchain (stable)
- Codex installed on your system and available as `codex` in `PATH`

If the `codex` binary is not in `PATH`, update the backend to pass a custom path per workspace.

## Getting Started

Install dependencies:

```bash
npm install
```

Run in dev mode:

```bash
npm run tauri dev
```

## Project Structure

```
src/
  components/       UI building blocks
  hooks/            state + event wiring
  services/         Tauri IPC wrapper
  styles/           split CSS by area
  types.ts          shared types
  src-tauri/
  src/lib.rs        Tauri backend + codex app-server client
  tauri.conf.json   window configuration
```

## Notes

- Workspaces persist to `workspaces.json` under the app data directory.
- Threads are restored by filtering `thread/list` results using the workspace `cwd`.
- Selecting a thread always calls `thread/resume` to refresh messages from disk.
- CLI sessions appear if their `cwd` matches the workspace path; they are not live-streamed unless resumed.
- The app uses `codex app-server` over stdio; see `src-tauri/src/lib.rs`.
