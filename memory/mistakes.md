# Mistakes

## Entry Template

## YYYY-MM-DD HH:mm
Context: <task or feature>
Type: mistake
Event: <what happened>
Action: <what changed / fix applied>
Rule: <one-line future behavior>
Root cause: <why it happened>
Fix applied: <what was changed>
Prevention rule: <how to avoid recurrence>

## 2026-02-07 10:51
Context: Settings modal migration to `ModalShell`
Type: mistake
Event: Settings window stopped centering after switching to DS modal shell.
Action: Removed `position` and `z-index` from `.settings-window` to let `.ds-modal-card` own centering.
Rule: Avoid redefining primitive-owned positioning styles in migrated feature shell classes.
Root cause: `.settings-window { position: relative; }` overrode `.ds-modal-card` absolute centering because `settings.css` loads after `ds-modal.css`.
Fix applied: Removed `position` and `z-index` from `.settings-window` so DS card positioning controls centering.
Prevention rule: When migrating existing shell classes onto DS primitives, avoid redeclaring layout-positioning properties (`position/top/left/transform`) already owned by the primitive.

## 2026-02-07 16:58
Context: Codex utility dedup refactor (`src-tauri/src/codex/mod.rs`)
Type: mistake
Event: A bulk file rewrite command truncated `codex/mod.rs` during refactor, temporarily dropping unrelated command handlers.
Action: Restored file from `HEAD` immediately and reapplied refactor using targeted replacements/patches only.
Rule: For large Rust modules, avoid full-file/head-tail rewrites unless line boundaries are verified; prefer function-scoped `apply_patch` edits.
Root cause: Used brittle line-count/head-tail rewrite workflow while file contents were changing.
Fix applied: Recovered from git snapshot and switched to explicit function-level patching.
Prevention rule: Use patch hunks anchored on function signatures for high-churn files and verify file length/function inventory after each structural edit.
