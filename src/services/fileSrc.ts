import * as tauriCore from "@tauri-apps/api/core";
import { isWebCompanionRuntime } from "./runtime";

function isRemoteOrEmbeddedPath(path: string) {
  return (
    path.startsWith("data:") ||
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("file://")
  );
}

export function convertLocalFileSrc(path: string) {
  if (!path) {
    return "";
  }
  if (isRemoteOrEmbeddedPath(path)) {
    return path;
  }
  if (isWebCompanionRuntime()) {
    return "";
  }
  try {
    return typeof tauriCore.convertFileSrc === "function"
      ? tauriCore.convertFileSrc(path)
      : "";
  } catch {
    return "";
  }
}
