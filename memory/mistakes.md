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

## 2026-02-07 18:52
Context: Orbit sign-in Settings test stability
Type: mistake
Event: Initial Orbit sign-in test used fake timers with async polling and left the suite vulnerable to timer-state bleed/timeouts.
Action: Reworked the test to use an injected Orbit client prop with deterministic mocked responses and real timer waits.
Rule: For UI flows with delayed async polling, prefer dependency injection + deterministic mocks over fake timer orchestration unless timer control is strictly required.
Root cause: The test depended on module-level service references and fake timer scheduling that conflicted with React async update timing.
Fix applied: Added `orbitServiceClient` prop to `SettingsView`, switched test to pass explicit mock client, and removed fake timer manipulation.
Prevention rule: Keep side-effect service dependencies injectable for settings workflows so tests can validate behavior without global spies/timer hacks.

## 2026-02-07 19:08
Context: Orbit runner startup + settings token sync
Type: mistake
Event: Orbit runner startup resolved the wrong daemon binary name and Orbit auth actions updated backend token state without syncing `appSettings`, allowing stale token overwrite on later settings saves.
Action: Updated runner binary resolution to prioritize `codex_monitor_daemon` naming and added explicit token sync (`onUpdateAppSettings`) after Orbit sign-in authorization and sign-out.
Rule: For process launches and out-of-band settings mutations, keep UI state synchronized with backend writes and verify binary naming against packaged targets.
Root cause: Assumed hyphenated daemon executable naming and relied on draft-only token updates after backend-side token mutation.
Fix applied: Added candidate lookup for underscored daemon binary (with compatibility fallback) and implemented `syncRemoteBackendToken` in `SettingsView` plus regression tests.
Prevention rule: Validate executable names against real build outputs and treat auth token changes as persisted settings updates, not UI-only draft changes.

## 2026-02-07 19:21
Context: Orbit token sync follow-up regression
Type: mistake
Event: Token sync fix used stale `appSettings` snapshot during async sign-in polling, and URL token guard matched substring `token=` instead of exact query key.
Action: Switched token sync merge source to a live settings ref and changed URL query-key detection to exact parameter-name matching with fragment-safe append behavior.
Rule: Async settings writes must merge against latest state references, and query-parameter guards must match exact keys.
Root cause: Closure-captured props were reused after user edits, and string containment check was too loose for query parsing.
Fix applied: Added `latestSettingsRef`-based merge in `SettingsView`, plus exact query key parsing in `append_query` and expanded Orbit URL unit tests.
Prevention rule: For async UI flows, avoid merging with captured props; for URL query logic, parse keys explicitly instead of substring scans.

## 2026-02-07 19:39
Context: Orbit auth hardening follow-up (backend + shared URL/error helpers)
Type: mistake
Event: Orbit error-body truncation could panic on UTF-8 boundaries, websocket token query values were appended without URL encoding, and Orbit token persistence in app/daemon poll paths could overwrite newer settings snapshots.
Action: Made error excerpt truncation UTF-8-boundary safe, percent-encoded appended query components, and introduced shared `update_remote_backend_token_core` to persist token updates from latest settings state in both app and daemon.
Rule: For shared auth/network helpers, avoid raw byte string slicing and raw query interpolation, and persist token mutations through latest-state merge helpers rather than stale snapshots.
Root cause: Manual string slicing/interpolation shortcuts and copy-pasted token persistence logic between adapters.
Fix applied: Updated `shared/orbit_core.rs` and `shared/settings_core.rs`, then rewired `orbit/mod.rs` and daemon Orbit handlers to call the shared token updater.
Prevention rule: Keep app/daemon settings mutation logic centralized in shared core APIs and require edge-case tests for UTF-8 and reserved query characters.

## 2026-02-07 19:50
Context: Remote backend provider switch behavior
Type: mistake
Event: Switching remote provider in settings updated persisted config but left the in-memory remote transport cache active, so traffic continued over the old transport until restart/disconnect.
Action: Added transport-change detection in app settings update flow and clear `state.remote_backend` when transport-affecting fields change.
Rule: Any settings update that changes remote transport config must invalidate the cached remote backend client immediately.
Root cause: Remote client cache lifecycle was only tied to disconnect/errors, not to transport settings mutations.
Fix applied: Updated `src-tauri/src/settings/mod.rs` to compare previous vs updated transport settings and reset cached remote backend when they differ; added predicate unit tests.
Prevention rule: Treat transport-config settings as cache keys and invalidate on change at the backend boundary, not only from UI handlers.

## 2026-02-07 20:36
Context: Orbit token sync persistence retry behavior in Settings
Type: mistake
Event: `syncRemoteBackendToken` updated `latestSettingsRef` before settings persistence succeeded, so a failed save could make later retries no-op.
Action: Moved `latestSettingsRef` mutation to after successful `onUpdateAppSettings` completion and added a regression test for retry-after-failure.
Rule: In async settings flows, only advance local "latest" refs after persistence succeeds.
Root cause: Optimistically mutating in-memory settings state before awaiting durable save.
Fix applied: Updated `src/features/settings/components/SettingsView.tsx` token sync ordering and added `retries Orbit token persistence after a failed save` in `src/features/settings/components/SettingsView.test.tsx`.
Prevention rule: Keep optimistic UI drafts separate from persisted-settings refs and add explicit retry-path tests for async save failures.

## 2026-02-07 21:01
Context: Tailscale settings helper token preview freshness
Type: mistake
Event: Tailscale daemon command preview did not auto-refresh after remote token changes, leaving `tokenConfigured` warning state stale until manual refresh.
Action: Added `appSettings.remoteBackendToken` as a dependency of the auto-refresh effect in `SettingsView` so preview data is recomputed after token edits.
Rule: Any derived helper output that depends on settings values must include those values in effect dependencies (or equivalent invalidation paths).
Root cause: The effect dependency list tracked provider/mode only and omitted token changes used by preview generation.
Fix applied: Updated `src/features/settings/components/SettingsView.tsx` effect dependencies and revalidated `SettingsView` tests.
Prevention rule: When adding helper panels, explicitly audit dependency arrays against all backend inputs shown in that panel (especially token/auth state).

## 2026-02-07 21:03
Context: Tailscale helper auto-preview on mobile
Type: mistake
Event: Settings auto-fetched desktop-only Tailscale daemon command preview on mobile, creating immediate unsupported-error noise.
Action: Added `isMobilePlatform` helper and gated auto preview fetch in `SettingsView` to desktop platforms only.
Rule: Do not auto-run desktop-only diagnostics on mobile surfaces; gate by platform first.
Root cause: Auto-refresh effect was scoped by provider/mode only and assumed desktop capabilities.
Fix applied: Updated `src/features/settings/components/SettingsView.tsx` effect logic and added `src/utils/platformPaths.test.ts` coverage for mobile detection.
Prevention rule: For any auto-run settings helper, explicitly classify desktop-only vs cross-platform behavior before wiring useEffect refreshes.

## 2026-02-07 21:09
Context: Messages auto-scroll regression follow-up (thread switch)
Type: mistake
Event: Converting the auto-scroll effect to `useLayoutEffect` introduced an ordering bug where thread switches could skip initial re-pin if the previous thread was scrolled up.
Action: Switched thread-change `autoScrollRef` reset to `useLayoutEffect`, added `threadId` to auto-scroll layout effect dependencies, and added a regression test for thread-switch re-pin behavior.
Rule: When converting effects between `useEffect` and `useLayoutEffect`, preserve ordering guarantees for dependent refs across thread/navigation boundaries.
Root cause: `autoScrollRef.current = true` still ran in `useEffect` after the new layout scroll pass, so first render on thread switch could evaluate stale `false`.
Fix applied: Updated `src/features/messages/components/Messages.tsx` hook ordering/dependencies and added `re-pins to bottom on thread switch even when previous thread was scrolled up` in `src/features/messages/components/Messages.test.tsx`.
Prevention rule: For scroll/anchor refs, pair layout-timing ref resets with layout-timing consumers and add regression coverage for cross-thread transitions.

## 2026-02-07 21:14
Context: CI `test-js` failure (`platformPaths.test.ts`)
Type: mistake
Event: New mobile platform tests mutated `navigator` directly without ensuring a `navigator` object exists in Node test environments.
Action: Updated `withNavigatorValues` in `src/utils/platformPaths.test.ts` to create a temporary `globalThis.navigator` shim when missing, restore descriptors after each test, and clean up with `Reflect.deleteProperty`.
Rule: Node-targeted unit tests must not assume browser globals exist; create and tear down explicit shims in helper setup.
Root cause: The tests were authored assuming `navigator` is always available, but Vitest runs with `environment: node` in CI.
Fix applied: Added a global-scope navigator shim path and descriptor-safe restore logic in `src/utils/platformPaths.test.ts`.
Prevention rule: For tests that patch `navigator`, `window`, or `document`, guard setup with `typeof ... === \"undefined\"` and perform full teardown in `finally`.

## 2026-02-07 21:16
Context: Tailscale CLI detection from GUI app runtime
Type: mistake
Event: Tailscale detection relied on `PATH` only, which can differ from shell aliases and fail in Tauri GUI runtime.
Action: Added binary resolution fallback candidates (including macOS app bundle path) before reporting CLI missing.
Rule: For desktop-integrated CLIs, resolve from PATH plus standard install locations; do not assume shell alias/path propagation.
Root cause: Implementation assumed the app process inherits the same shell PATH/aliases as user terminal sessions.
Fix applied: Updated `src-tauri/src/tailscale/mod.rs` to probe candidate binaries and execute status/version via resolved path.
Prevention rule: Any new CLI integration in Tauri should include explicit path fallback logic and a test for candidate list coverage.

## 2026-02-08 06:34
Context: TCP mobile daemon status metadata refresh
Type: mistake
Event: `tailscale_daemon_status` only updated `listen_addr` when it was `None`, so stopped/error states could show stale listen ports after settings changes.
Action: Added a shared `sync_tcp_daemon_listen_addr` helper and used it in both status and stop paths; added unit tests for stopped-vs-running behavior.
Rule: Non-running daemon status responses must re-sync listen metadata from current settings.
Root cause: Status handler treated listen address as immutable cached state rather than configuration-derived metadata for stopped/error states.
Fix applied: `src-tauri/src/tailscale/mod.rs` now refreshes listen addr unless daemon is actively running with a known bind, and tests cover both branches.
Prevention rule: Any status endpoint that reports config-derived fields should recompute those fields on refresh when runtime state is inactive.

## 2026-02-08 06:39
Context: Tailscale preflight test implementation
Type: mistake
Event: Added `#[tokio::test]` in a crate configuration where Tokio test macros are not enabled, causing compile failure.
Action: Replaced macro usage with a standard `#[test]` and an explicit current-thread Tokio runtime in the test body.
Rule: In this repo, use explicit runtime-backed tests unless Tokio test-macro support is confirmed enabled.
Root cause: Assumed Tokio test-macro feature availability from runtime dependency alone.
Fix applied: Updated the test to build a runtime manually in `src-tauri/src/tailscale/mod.rs`.
Prevention rule: Prefer `runtime.block_on(...)` for async unit tests in `src-tauri` modules unless existing files already use `#[tokio::test]`.

## 2026-02-08 07:49
Context: iOS mobile shell viewport/safe-area behavior
Type: mistake
Event: A `100dvh` height change for iOS caused bottom tab bar lift/gap while the phone shell still lacked top safe-area inset, creating status-bar overlap.
Action: Reverted app/root height to `100vh` and added top safe-area padding on phone compact shell.
Rule: For Tauri iOS webviews, do not switch root container height units without validating safe-area behavior on-device/simulator.
Root cause: Assumed Safari-style `dvh` behavior would improve iOS viewport stability in WKWebView.
Fix applied: Updated `src/styles/base.css` and `src/styles/compact-phone.css` for stable phone shell geometry.
Prevention rule: Validate both status-bar overlap and tab-bar bottom alignment after any viewport/meta/height CSS change.

## 2026-02-08 07:47
Context: iOS compact layout tab bar visibility
Type: mistake
Event: On iOS, pinch-zoom and viewport sizing let the compact tab bar render outside the visible area.
Action: Forced phone layout on mobile runtime, disabled mobile pinch gestures, and switched root/app height to dynamic viewport units.
Rule: Mobile shells must use stable non-zooming viewport behavior and `dvh` sizing to keep fixed navigation visible.
Root cause: Width-only layout detection and `100vh` sizing were combined with zoomable WebView behavior.
Fix applied: Updated `src/features/layout/hooks/useLayoutMode.ts`, `index.html`, `src/main.tsx`, and `src/styles/base.css`.
Prevention rule: For iOS/Tauri webview flows, always validate pinch-zoom behavior and bottom-nav visibility before considering layout complete.

## 2026-02-08 07:49
Context: iOS viewport unit correction after simulator validation
Type: mistake
Event: The earlier `dvh` guidance proved incorrect in WKWebView and produced bottom-gap/tab-bar lift.
Action: Superseded prior guidance by restoring root/app containers to `100vh` and keeping safe-area handling explicit in shell/tabbar CSS.
Rule: In this app, prefer `100vh` for root/app on iOS Tauri unless device validation proves a different unit is required.
Root cause: Over-generalized Safari viewport behavior to Tauri WKWebView runtime.
Fix applied: Reverted `dvh` usage in `src/styles/base.css` and added safe-area top inset in `src/styles/compact-phone.css`.
Prevention rule: Treat viewport unit changes as platform-runtime specific and always validate in the target Tauri runtime.

## 2026-02-08 07:50
Context: iOS tab bar disappearing after viewport changes
Type: mistake
Event: A global width media query in `tabbar.css` hid the tab bar for widths above 521px, which can occur on iOS with viewport scaling.
Action: Removed the width-based hide rule and set tab bar to non-shrinking in the phone shell.
Rule: Do not use global width-based hide rules for mobile navigation when layout mode already controls rendering.
Root cause: Legacy responsive CSS conflicted with runtime layout gating and iOS viewport behavior.
Fix applied: Updated `src/styles/tabbar.css` to keep `.tabbar` always rendered and `flex-shrink: 0`.
Prevention rule: Scope navigation visibility to explicit layout classes/runtime state rather than coarse viewport breakpoints.

## 2026-02-08 07:54
Context: iOS layout mode still selecting tablet shell
Type: mistake
Event: Even after tab bar CSS fixes, iOS sometimes remained in tablet layout because mobile-platform detection did not cover desktop-style iPad user agents.
Action: Hardened `isMobilePlatform()` to include mobile UA tokens, touch-point checks, and iPad desktop-mode detection.
Rule: Mobile runtime gating must account for iPadOS desktop-style UA/platform values.
Root cause: Detection relied mainly on explicit `iphone`/`ipad` platform strings that are not guaranteed in modern iOS webviews.
Fix applied: Updated `src/utils/platformPaths.ts` and expanded `src/utils/platformPaths.test.ts` coverage.
Prevention rule: When using platform detection for layout, include tests for desktop-style iPad UA + touch capability.

## 2026-02-08 07:55
Context: iOS runtime layout gating reliability
Type: mistake
Event: Browser-side UA/touch heuristics remained too brittle for reliable iOS shell selection in Tauri.
Action: Added backend command `is_mobile_runtime` and made `useLayoutMode` trust runtime platform detection before applying responsive width logic.
Rule: For platform-critical UI gates in Tauri, prefer backend runtime signals over browser heuristics.
Root cause: Heuristic detection varied across simulator/device WebView identification.
Fix applied: Updated `src-tauri/src/lib.rs`, `src/services/tauri.ts`, and `src/features/layout/hooks/useLayoutMode.ts`.
Prevention rule: Route platform-critical decisions through compile-time/runtime backend authority when available.

## 2026-02-08 08:02
Context: iOS phone shell bottom navigation clipping
Type: mistake
Event: Phone tab bar rendered below the visible iOS webview area even though phone layout was active.
Action: Bound app/root height to runtime `visualViewport.height` on mobile and switched compact shell sizing from fixed `height: 100%` to flex growth.
Rule: In Tauri iOS webviews, drive root/app height from runtime viewport metrics, not static `100vh` assumptions.
Root cause: Static CSS viewport height did not consistently match the visible WKWebView viewport after safe-area and gesture-driven viewport changes.
Fix applied: Added `syncMobileViewportHeight()` in `src/main.tsx`, updated `src/styles/base.css` to use `--app-height`, and updated `src/styles/compact-base.css` shell sizing.
Prevention rule: After any iOS viewport/safe-area change, verify both top status-bar clearance and bottom tab bar visibility on simulator/device screenshots.

## 2026-02-08 08:04
Context: iOS phone shell tab bar bottom anchoring
Type: mistake
Event: Mobile viewport sync preferred `visualViewport.height`, which fixed clipping but made the app container slightly shorter than the device viewport, so the tab bar floated above the bottom edge.
Action: Changed mobile app-height calculation to use the larger of `window.innerHeight` and `visualViewport.height`.
Rule: On iOS WKWebView, avoid using `visualViewport.height` alone for root layout height.
Root cause: Assumed `visualViewport.height` matched full renderable app viewport in Tauri iOS.
Fix applied: Updated `syncMobileViewportHeight` in `src/main.tsx` to compute `--app-height` with `Math.max(window.innerHeight, visualViewport.height ?? 0)`.
Prevention rule: Treat root viewport sizing as WKWebView-specific and validate both clipping and bottom anchoring before finalizing.

## 2026-02-08 08:15
Context: Settings modal mobile master/detail rollout
Type: mistake
Event: Initial master/detail gating required both mobile-platform detection and narrow width, which made behavior inconsistent in test/runtime scenarios where width was narrow but platform heuristics varied.
Action: Switched master/detail trigger to a pure viewport-width predicate (`max-width: 720px`) and validated with dedicated Settings mobile-layout tests.
Rule: For responsive modal navigation, gate layout by viewport constraints unless platform-specific behavior is strictly required.
Root cause: Over-constrained layout gating mixed platform heuristics into a screen-size-driven UX requirement.
Fix applied: Updated `SettingsView` layout gating and added regression coverage in `src/features/settings/components/SettingsView.test.tsx`.
Prevention rule: Align layout triggers directly to UX constraints (width/height) and keep platform checks only for truly platform-specific capability differences.

## 2026-02-08 08:22
Context: iOS settings modal vertical placement
Type: mistake
Event: Mobile settings modal remained visually too high, overlapping status-bar/notch area and making the top navigation feel collapsed.
Action: Added mobile safe-area-aware modal sizing/offset to shift the settings card lower on narrow viewports.
Rule: On iOS-style narrow layouts, modal card placement must account for safe-area top inset explicitly.
Root cause: Centered modal placement used viewport-only geometry without safe-area compensation for notched displays.
Fix applied: Updated `src/styles/settings.css` mobile rules to include safe-area-aware height and top offset.
Prevention rule: Validate modal vertical placement against notch/status-bar safe areas whenever mobile modal dimensions or centering behavior change.

## 2026-02-08 08:49
Context: iOS compact shell full-height regression
Type: mistake
Event: Applied safe-area top inset to the entire `.compact-shell`, which reduced usable layout height and lifted bottom navigation off the device edge.
Action: Moved top safe-area offset from shell-level container padding to top content regions (`.sidebar` and `.compact-topbar`) and validated with `scripts/build_run_ios.sh` + simulator screenshot.
Rule: Never apply global safe-area padding to the full-height phone shell container; apply safe-area offsets only to top content/header regions.
Root cause: Safe-area compensation was added at the wrong layout level, shrinking the entire vertical flex stack.
Fix applied: Updated `src/styles/compact-phone.css` and validated via full iOS build/run screenshot workflow.
Prevention rule: For iOS safe-area adjustments, verify tab bar bottom anchoring after changes and prefer localized top-inset handling over shell-level padding.

## 2026-02-08 08:39
Context: iOS bottom-gap in compact shell
Type: mistake
Event: Mobile root height sync used `visualViewport.height` directly, which can exclude top viewport offset in WKWebView and leave the app container shorter than the simulator frame.
Action: Updated viewport sync to use `visualViewport.height + visualViewport.offsetTop` and keep `window.innerHeight` as a fallback candidate.
Rule: In iOS WKWebView, treat viewport height as `visualViewport.height + offsetTop` when computing root app height.
Root cause: Assumed `visualViewport.height` alone represented full visible app height in Tauri iOS runtime.
Fix applied: Updated `syncMobileViewportHeight()` in `src/main.tsx`.
Prevention rule: After viewport sync changes, verify bottom anchoring with simulator screenshots and avoid raw `visualViewport.height`-only calculations.
