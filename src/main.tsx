import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import { isMobilePlatform } from "./utils/platformPaths";

const sentryDsn =
  import.meta.env.VITE_SENTRY_DSN ??
  "https://8ab67175daed999e8c432a93d8f98e49@o4510750015094784.ingest.us.sentry.io/4510750016012288";

Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn),
  release: __APP_VERSION__,
});

Sentry.metrics.count("app_open", 1, {
  attributes: {
    env: import.meta.env.MODE,
    platform: "macos",
  },
});

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

  const setViewportHeight = () => {
    const visualViewport = window.visualViewport;
    const visualHeight = visualViewport
      ? visualViewport.height + visualViewport.offsetTop
      : 0;
    const rootHeight = document.documentElement?.clientHeight ?? 0;
    const bodyHeight = document.body?.clientHeight ?? 0;
    const screenCssHeight =
      window.screen?.height && window.devicePixelRatio > 0
        ? window.screen.height / window.devicePixelRatio
        : 0;
    const nextHeight = Math.round(
      Math.max(
        window.innerHeight,
        visualHeight,
        rootHeight,
        bodyHeight,
        screenCssHeight,
      ),
    );
    document.documentElement.style.setProperty("--app-height", `${nextHeight}px`);
  };

  setViewportHeight();
  window.addEventListener("resize", setViewportHeight, { passive: true });
  window.addEventListener("orientationchange", setViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("resize", setViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("scroll", setViewportHeight, { passive: true });
}

disableMobileZoomGestures();
syncMobileViewportHeight();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
