# TODO

## Open
- [ ] 2026-02-07: Ship mobile remote-mode foundation: Cloudflare bridge (Worker + Durable Object + auth), daemon/local command parity for remote routing, and iOS-safe backend gating/stubs.

## Done
- [x] 2026-02-07: Restored Sentry frontend reporting removed in `83a37da` (`@sentry/react`, `Sentry.init`, captureException callsites, and metrics instrumentation).
- [x] Complete phase-2 design-system migration cleanup for targeted families (modals, toasts, panel shells, diff theme defaults).
- [x] Add lint/codemod automation for DS primitive adoption (`modal-shell`, `panel-shell`, `toast-shell`) as defined in `docs/design-system-migration-plan.md`.
- [x] Run manual visual parity QA checklist for migrated modal/toast/panel/diff families and delete remaining unreferenced legacy selectors.
- [x] 2026-02-07: Replace daemon `local_usage_snapshot` temporary zeroed snapshot implementation with shared real session-log scanner parity.
- [x] 2026-02-07: Extract newly mirrored daemon git/github/prompts/codex utility logic into shared core modules to eliminate remaining app/daemon duplication.
- [x] 2026-02-07: Replace daemon `local_usage_snapshot` temporary implementation by sharing real local usage scanner logic in `shared/local_usage_core.rs`.
- [x] 2026-02-07: Eliminate app/daemon duplication for git/github/prompt/codex utility behavior via shared cores (`git_ui_core`, `prompts_core`, `codex_aux_core`).
- [x] 2026-02-07: Move remaining duplicated workspace-action logic (`add_clone`, `apply_worktree_changes`, `open_workspace_in`, `get_open_app_icon`) into shared core helpers.
