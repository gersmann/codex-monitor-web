export const WEB_ADAPTED_RPC_METHOD_GROUPS = {
  runtime: [
    "app_build_type",
    "daemon_info",
    "daemon_shutdown",
    "is_macos_debug_build",
    "is_mobile_runtime",
    "ping",
  ],
  browser: [
    "open_workspace_in",
    "send_notification_fallback",
  ],
} as const;

export const WEB_ADAPTED_RPC_METHODS = Object.freeze(
  Object.values(WEB_ADAPTED_RPC_METHOD_GROUPS).flat() as string[],
);

export const INTENTIONALLY_UNSUPPORTED_RPC_METHOD_GROUPS = {
  github: [
  ],
  shell: [
    "get_open_app_icon",
    "menu_set_accelerators",
    "set_tray_recent_threads",
    "set_tray_session_usage",
    "write_text_file",
  ],
  codex: [
    "codex_update",
  ],
  dictation: [
    "dictation_cancel",
    "dictation_cancel_download",
    "dictation_download_model",
    "dictation_model_status",
    "dictation_remove_model",
    "dictation_request_permission",
    "dictation_start",
    "dictation_stop",
  ],
  tailscale: [
    "tailscale_daemon_command_preview",
    "tailscale_daemon_start",
    "tailscale_daemon_status",
    "tailscale_daemon_stop",
    "tailscale_status",
  ],
  terminal: [
    "terminal_close",
    "terminal_open",
    "terminal_resize",
    "terminal_write",
  ],
} as const;

export const INTENTIONALLY_UNSUPPORTED_RPC_METHODS = Object.freeze(
  Object.values(INTENTIONALLY_UNSUPPORTED_RPC_METHOD_GROUPS).flat() as string[],
);

export const PARTIAL_PARITY_RPC_METHOD_GROUPS: Record<string, readonly string[]> = {};

export const PARTIAL_PARITY_RPC_METHODS = Object.freeze(
  Object.values(PARTIAL_PARITY_RPC_METHOD_GROUPS).flat() as string[],
);

export const SUPPORTED_WITHOUT_EXPLICIT_CASE = new Set<string>([
  ...WEB_ADAPTED_RPC_METHODS,
  ...INTENTIONALLY_UNSUPPORTED_RPC_METHODS,
]);

export function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

export function unsupportedRpcMessage(method: string) {
  return `${method} is not supported in the web companion.`;
}
