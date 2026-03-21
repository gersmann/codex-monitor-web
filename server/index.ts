import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { main } from "./http/index.js";

export * from "./http/index.js";

function isEntrypoint(moduleUrl: string, argvEntry: string | undefined) {
  if (!argvEntry) {
    return false;
  }
  return fileURLToPath(moduleUrl) === path.resolve(argvEntry);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error) => {
    process.exitCode = 1;
    throw error;
  });
}
