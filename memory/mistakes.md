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
