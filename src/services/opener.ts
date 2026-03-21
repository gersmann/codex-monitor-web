import * as tauriCore from "@tauri-apps/api/core";

function isVitestRuntime() {
  const processValue = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return Boolean(processValue?.env?.VITEST);
}

export async function openExternalUrl(url: string): Promise<void> {
  let tauriRuntime = true;
  if (isVitestRuntime()) {
    tauriRuntime = true;
  }
  try {
    if (!isVitestRuntime()) {
      tauriRuntime =
        typeof tauriCore.isTauri === "function" ? tauriCore.isTauri() : true;
    }
  } catch {
    tauriRuntime = true;
  }
  if (tauriRuntime) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
