# App-Server Events Reference (Codex `3878c3dc7c88f356e3ec983dae30a01902a3ec53`)

This document helps agents quickly answer:
- Which app-server events CodexMonitor supports right now.
- Where to look in CodexMonitor to add support.
- Where to look in `../codex` to compare event lists and find emitters.

When updating this document:
1. Update the Codex hash in the title using `git -C ../codex rev-parse HEAD`.
2. Compare Codex events vs CodexMonitor routing.
3. Update both the supported and missing lists below.

## Where To Look In CodexMonitor

Primary event router:
- `src/features/app/hooks/useAppServerEvents.ts`

Event handler composition:
- `src/features/threads/hooks/useThreadEventHandlers.ts`

Thread/turn/item handlers:
- `src/features/threads/hooks/useThreadTurnEvents.ts`
- `src/features/threads/hooks/useThreadItemEvents.ts`
- `src/features/threads/hooks/useThreadApprovalEvents.ts`
- `src/features/threads/hooks/useThreadUserInputEvents.ts`

State updates:
- `src/features/threads/hooks/useThreadsReducer.ts`

Item normalization / display shaping:
- `src/utils/threadItems.ts`

UI rendering of items:
- `src/features/messages/components/Messages.tsx`

## Supported Events (Current)

These are the events explicitly routed in `useAppServerEvents.ts` (plus
`requestApproval` methods matched by substring):

- `codex/connected`
- `*requestApproval*` (matched via `method.includes("requestApproval")`)
- `item/tool/requestUserInput`
- `item/agentMessage/delta`
- `turn/started`
- `error`
- `turn/completed`
- `thread/compacted`
- `turn/plan/updated`
- `turn/diff/updated`
- `thread/tokenUsage/updated`
- `account/rateLimits/updated`
- `item/completed`
- `item/started`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`

## Missing Events (Codex v2 Notifications)

Compared against Codex app-server protocol v2 notifications, the following
events are currently not routed:

- `account/updated`
- `configWarning`
- `deprecationNotice`
- `item/mcpToolCall/progress`
- `mcpServer/oauthLogin/completed`
- `rawResponseItem/completed`
- `thread/started`
- `windows/worldWritableWarning`

## Where To Look In ../codex

Start here for the authoritative v2 notification list:
- `../codex/codex-rs/app-server-protocol/src/protocol/common.rs`

Useful follow-ups:
- Notification payload types:
  - `../codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
- Emitters / wiring from core events to server notifications:
  - `../codex/codex-rs/app-server/src/bespoke_event_handling.rs`
- Human-readable protocol notes:
  - `../codex/codex-rs/app-server/README.md`

## Quick Comparison Workflow

Use this workflow to update the lists above:

1. Get the current Codex hash:
   - `git -C ../codex rev-parse HEAD`
2. List Codex v2 notification methods:
   - `rg -n \"=> \\\".*\\\" \\(v2::.*Notification\\)\" ../codex/codex-rs/app-server-protocol/src/protocol/common.rs`
3. List CodexMonitor routed methods:
   - `rg -n \"method === \\\"\" src/features/app/hooks/useAppServerEvents.ts`
4. Update the Supported and Missing sections.

## Notes

- Not all missing events must be surfaced in the conversation view; some may
  be better as toasts, settings warnings, or debug-only entries.
- For conversation view changes, prefer:
  - Route in `useAppServerEvents.ts`
  - Handle in `useThreadTurnEvents.ts` or `useThreadItemEvents.ts`
  - Update state in `useThreadsReducer.ts`
  - Render in `Messages.tsx`

