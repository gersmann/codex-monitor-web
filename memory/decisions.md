# Decisions

## Canonical Memory Model

- `memory/decisions.md` stores active, high-signal canonical rules only.
- Full historical detail for the pre-compaction log is archived at `memory/archive/decisions-2026-02-07-full.md`.
- New low-signal implementation-step history should go to `memory/archive/` instead of this file.

## Entry Template

```md
## YYYY-MM-DD HH:mm
Context: <task or feature>
Type: decision | preference
Rule: <one-line future behavior>
Why: <short reason this rule exists>
```

## Active Canonical Rules

### Documentation and Memory

- Keep `AGENTS.md` canonical and current-state only; avoid phase/progress framing.
- Keep design-system guidance in `AGENTS.md` aligned with implemented primitives, guardrails, and scripts.
- Keep `memory/decisions.md` high-signal; move detailed timelines to `memory/archive/`.

### Backend Architecture

- Keep domain logic in `src-tauri/src/shared/*`; app/daemon code should remain thin adapters.
- For app/daemon parity work, extract shared implementations instead of duplicating logic.
- Add new backend behavior in shared core first, then wire app commands and daemon RPC handlers.

### Remote and Mobile Direction

- Keep mobile remote implementation Orbit-first and Orbit-named across runtime/config/docs.
- Keep Orbit setup/docs/UI self-host-only unless the user explicitly requests hosted mode.
- Do not introduce CloudKit/PR31-based mobile backend patterns unless the user explicitly requests them.
- For iOS rollout, prioritize backend/transport parity for existing responsive UI flows over net-new mobile-specific UI.
- For current mobile remote scope, terminal and dictation parity remain out of scope unless the user re-enables them.
- Keep Tailscale as first-run bootstrap for TCP self-host setup while Orbit remains the target production relay path.
- Keep remote provider labels marked `(wip)` until the user requests removal.

### Remote Implementation Rules

- Keep remote transport behind provider-selected `RemoteTransport` abstractions.
- Keep Orbit auth/session contract-driven around typed `deviceCode` polling.
- Persist remote backend token changes through shared settings-core helpers to avoid stale overwrite races.
- Invalidate cached remote backend clients when transport-affecting settings change.
- Desktop CLI integrations must resolve from `PATH` plus deterministic fallback install locations.

### Frontend Design System

- Use DS primitives/tokens first for modal, toast, panel, and popover shell behavior.
- Keep feature CSS focused on feature-specific layout/content; do not duplicate DS shell chrome.
- Use DS toast sub-primitives for shared toast structure.
- Modal consumers must provide accessible labels.
- Tablist UIs must use proper tab semantics and move selection and focus together.
- For DS migration follow-ups, run `npm run codemod:ds:dry` and keep DS lint guardrails green.

### Frontend UX and Performance

- Automatic message pinning should be immediate and non-animated; smooth scrolling is user-initiated only.
- High-frequency reducers must return previous state for no-op transitions.
- Memoize high-churn UI shells when unrelated app updates can impact input responsiveness.
- Keep a single trigger path for accelerator-backed actions to avoid duplicate execution and telemetry.

### Release and Telemetry

- Keep Sentry telemetry enabled unless the user explicitly asks to remove or replace it.
- Release metadata must be generated from normalized artifact names and validated before publishing.

## 2026-02-07 21:35
Context: Memory compaction model update
Type: decision
Rule: Keep `memory/decisions.md` as a compact canonical rule register and archive detailed historical decision timelines under `memory/archive/`.
Why: This improves retrieval quality for future agents and reduces low-signal duplicate context during implementation.

## 2026-02-07 21:34
Context: Message file-link display controls
Type: decision
Rule: Keep file-link parent path display in messages behind `showMessageFilePath`, defaulting to enabled.
Why: This preserves existing context-rich defaults while allowing users to reduce visual noise in message file references.

## 2026-02-07 21:22
Context: Settings IA for mobile/backend setup
Type: preference
Rule: Keep backend/mobile connectivity controls in a dedicated `Server` settings section (not `Codex`), with explicit mobile-access daemon controls.
Why: Desktop Codex configuration and remote/mobile server operations are different mental models and should be separated in UX.

## 2026-02-08 06:27
Context: Server settings desktop/mobile behavior
Type: preference
Rule: Keep mobile access controls visible in `Server` regardless of desktop backend mode; `backendMode` only affects whether desktop traffic is local or routed through remote transport.
Why: The desktop app should stay local by default while still allowing users to configure and operate the mobile daemon path.
