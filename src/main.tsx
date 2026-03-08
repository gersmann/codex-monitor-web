import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import { isWebCompanionRuntime } from "./services/runtime";
import { isMobilePlatform } from "./utils/platformPaths";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
const sentryEnabled =
  !isWebCompanionRuntime() &&
  typeof sentryDsn === "string" &&
  sentryDsn.trim().length > 0;
const clientLogsEnabled =
  isWebCompanionRuntime() &&
  import.meta.env.VITE_CODEX_MONITOR_CLIENT_LOGS !== "0";

type ClientLogPayload = {
  level: "error";
  source: "window-error" | "unhandledrejection" | "console.error";
  message: string;
  href: string | null;
  userAgent: string | null;
  stack?: string;
  details?: Record<string, unknown>;
};

function serializeUnknown(value: unknown) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function postClientLog(payload: ClientLogPayload) {
  if (!clientLogsEnabled || typeof window === "undefined") {
    return;
  }
  const body = JSON.stringify(payload);
  const blob = new Blob([body], { type: "application/json" });
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
  ) {
    try {
      navigator.sendBeacon("/api/client-log", blob);
      return;
    } catch {
      // Fall through to fetch.
    }
  }
  void fetch("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Intentionally swallow logging failures.
  });
}

function installWebClientErrorLogging() {
  if (!clientLogsEnabled || typeof window === "undefined") {
    return;
  }

  const baseContext = {
    href: window.location.href,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  };

  window.addEventListener("error", (event) => {
    const target = event.target;
    const isResourceError =
      target instanceof HTMLElement && target !== window.document.body;
    postClientLog({
      level: "error",
      source: "window-error",
      message: event.message || "Unhandled window error",
      href: baseContext.href,
      userAgent: baseContext.userAgent,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      details: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        resourceTag: isResourceError ? target.tagName : undefined,
        resourceSource:
          isResourceError && target instanceof HTMLImageElement
            ? target.currentSrc || target.src
            : undefined,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    postClientLog({
      level: "error",
      source: "unhandledrejection",
      message: extractErrorMessage(reason),
      href: baseContext.href,
      userAgent: baseContext.userAgent,
      stack: reason instanceof Error ? reason.stack : undefined,
      details: {
        reason: serializeUnknown(reason),
      },
    });
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    const [firstArg] = args;
    postClientLog({
      level: "error",
      source: "console.error",
      message: extractErrorMessage(firstArg),
      href: baseContext.href,
      userAgent: baseContext.userAgent,
      details: {
        args: args.map((entry) => serializeUnknown(entry)),
      },
    });
  };
}

if (sentryEnabled) {
  Sentry.init({
    dsn: sentryDsn,
    enabled: true,
    release: __APP_VERSION__,
  });

  Sentry.metrics.count("app_open", 1, {
    attributes: {
      env: import.meta.env.MODE,
      platform: "macos",
    },
  });
}

function disableMobileZoomGestures() {
  if (!isMobilePlatform() || typeof document === "undefined") {
    return;
  }
  const preventGesture = (event: Event) => event.preventDefault();
  const preventPinch = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      event.preventDefault();
    }
  };

  document.addEventListener("gesturestart", preventGesture, { passive: false });
  document.addEventListener("gesturechange", preventGesture, { passive: false });
  document.addEventListener("gestureend", preventGesture, { passive: false });
  document.addEventListener("touchmove", preventPinch, { passive: false });
}

function syncMobileViewportHeight() {
  if (!isMobilePlatform() || typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  let rafHandle = 0;

  const setViewportHeight = () => {
    const visualViewport = window.visualViewport;
    const viewportHeight = visualViewport
      ? visualViewport.height + visualViewport.offsetTop
      : window.innerHeight;
    const nextHeight = Math.round(viewportHeight);
    document.documentElement.style.setProperty("--app-height", `${nextHeight}px`);
  };

  const scheduleViewportHeight = () => {
    if (rafHandle) {
      return;
    }
    rafHandle = window.requestAnimationFrame(() => {
      rafHandle = 0;
      setViewportHeight();
    });
  };

  const setComposerFocusState = () => {
    const activeElement = document.activeElement;
    const isComposerTextareaFocused =
      activeElement instanceof HTMLTextAreaElement &&
      activeElement.closest(".composer") !== null;
    document.documentElement.dataset.mobileComposerFocus = isComposerTextareaFocused
      ? "true"
      : "false";
  };

  setViewportHeight();
  setComposerFocusState();
  window.addEventListener("resize", scheduleViewportHeight, { passive: true });
  window.addEventListener("orientationchange", scheduleViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("resize", scheduleViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("scroll", scheduleViewportHeight, { passive: true });
  document.addEventListener("focusin", setComposerFocusState);
  document.addEventListener("focusout", () => {
    requestAnimationFrame(setComposerFocusState);
  });
}

disableMobileZoomGestures();
syncMobileViewportHeight();
installWebClientErrorLogging();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
