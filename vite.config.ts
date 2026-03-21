import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// @ts-expect-error process is a nodejs global
const tauriHost = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const webHost = process.env.CODEX_MONITOR_WEB_HOST;
const bindHost = tauriHost || webHost || false;

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as {
  version: string;
};

function resolveCommitHash() {
  const ciCommit =
    process.env.GIT_COMMIT ?? process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA;
  if (typeof ciCommit === "string" && ciCommit.trim().length > 0) {
    return ciCommit.trim().slice(0, 12);
  }
  try {
    return execSync("git rev-parse --short=12 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function resolveBuildDate() {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (typeof sourceDateEpoch === "string" && /^\d+$/.test(sourceDateEpoch)) {
    const milliseconds = Number(sourceDateEpoch) * 1000;
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      return new Date(milliseconds).toISOString();
    }
  }
  return new Date().toISOString();
}

function resolveGitBranch() {
  const ciBranch =
    process.env.GIT_BRANCH ?? process.env.GITHUB_REF_NAME ?? process.env.CI_COMMIT_REF_NAME;
  if (typeof ciBranch === "string" && ciBranch.trim().length > 0) {
    return ciBranch.trim();
  }
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
    if (!branch || branch === "HEAD") {
      return "unknown";
    }
    return branch;
  } catch {
    return "unknown";
  }
}

const appCommitHash = resolveCommitHash();
const appBuildDate = resolveBuildDate();
const appGitBranch = resolveGitBranch();
const allowedHosts = ["dev.taild97ff6.ts.net"];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    VitePWA({
      manifest: false,
      registerType: "autoUpdate",
      includeAssets: [
        "app-icon.png",
        "app-icon-180.png",
        "app-icon-192.png",
        "app-icon-512.png",
        "manifest.webmanifest",
      ],
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        navigateFallbackDenylist: [/^\/api\//, /^\/events(?:\/|$)/],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@app": fileURLToPath(new URL("./src/features/app", import.meta.url)),
      "@settings": fileURLToPath(new URL("./src/features/settings", import.meta.url)),
      "@threads": fileURLToPath(new URL("./src/features/threads", import.meta.url)),
      "@services": fileURLToPath(new URL("./src/services", import.meta.url)),
      "@utils": fileURLToPath(new URL("./src/utils", import.meta.url)),
    },
  },
  worker: {
    format: "es",
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_COMMIT_HASH__: JSON.stringify(appCommitHash),
    __APP_BUILD_DATE__: JSON.stringify(appBuildDate),
    __APP_GIT_BRANCH__: JSON.stringify(appGitBranch),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts"],
    setupFiles: ["src/test/vitest.setup.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: bindHost,
    allowedHosts,
    proxy: tauriHost
      ? undefined
      : {
          "/api": {
            target: "http://127.0.0.1:4318",
            changeOrigin: true,
          },
          "/events": {
            target: "ws://127.0.0.1:4318",
            ws: true,
          },
        },
    hmr: tauriHost
      ? {
          protocol: "ws",
          host: tauriHost,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.codex-worktrees/**"],
    },
  },
}));
