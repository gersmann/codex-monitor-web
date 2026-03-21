import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";

const EXEC_MAX_BUFFER_BYTES = 10 * (2 ** 20);

export type CommandResult = {
  stdout: string;
  stderr: string;
};

function commandFailureDetail(
  command: string,
  args: string[],
  error: import("node:child_process").ExecFileException,
  stdout: string,
  stderr: string,
) {
  const timedOut =
    error.name === "TimeoutError" ||
    error.killed ||
    error.signal === "SIGTERM" ||
    /timed out/i.test(error.message);
  return timedOut
    ? `Command timed out: ${command} ${args.join(" ")}`
    : `${stderr || stdout || error.message}`.trim() || "Command failed.";
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
) {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        env: options.env,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(commandFailureDetail(command, args, error, stdout, stderr)));
      },
    );
  });
}

export function runCommandCapture(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
) {
  return new Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error: string | null;
  }>((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: options.env,
        timeout: options.timeoutMs ?? 5_000,
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            ok: true,
            stdout,
            stderr,
            error: null,
          });
          return;
        }
        resolve({
          ok: false,
          stdout,
          stderr,
          error: `${stderr || stdout || error.message}`.trim() || error.message,
        });
      },
    );
  });
}

export async function runGit(repoRoot: string, args: string[]) {
  return await runCommand("git", args, repoRoot);
}

function gitCommitTimeoutMs() {
  const raw = Number(process.env.CODEX_MONITOR_GIT_COMMIT_TIMEOUT_MS ?? "120000");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 120_000;
  }
  return Math.round(raw);
}

export async function runGitCommit(repoRoot: string, message: string) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
  };
  return await runCommand("git", ["commit", "-m", message], repoRoot, {
    env,
    timeoutMs: gitCommitTimeoutMs(),
  });
}

export async function runGh(repoRoot: string, args: string[]) {
  return await runCommand("gh", args, repoRoot);
}

export async function tryRunGit(repoRoot: string, args: string[]) {
  try {
    return await runGit(repoRoot, args);
  } catch {
    return null;
  }
}

export async function resolveGitRootFromPath(workspacePath: string) {
  const result = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  return result.stdout.trim();
}

function nullDevicePath() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function resolveNoIndexDiff(
  resolve: (value: string | PromiseLike<string>) => void,
  reject: (reason?: unknown) => void,
  error: import("node:child_process").ExecFileException | null,
  stdout: string,
  stderr: string,
) {
  const message = `${stderr || stdout || error?.message || ""}`.trim();
  if (!error) {
    resolve(stdout);
    return;
  }
  const code =
    typeof error.code === "number" ? error.code : Number(error.code);
  if (code === 1) {
    resolve(stdout);
    return;
  }
  reject(new Error(message || "Git diff failed."));
}

export async function runGitNoIndexDiff(repoRoot: string, relativePath: string) {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--binary", "--no-color", "--no-index", "--", nullDevicePath(), relativePath],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: EXEC_MAX_BUFFER_BYTES },
      resolveNoIndexDiff.bind(null, resolve, reject),
    );
  });
}

async function writeTemporaryPatchFile(patch: string) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-patch-"));
  const patchPath = path.join(tempDir, "apply.patch");
  await fs.writeFile(patchPath, patch, "utf8");
  return { tempDir, patchPath };
}

function normalizePatchApplyFailure(error: unknown) {
  const detail = (error instanceof Error ? error.message : String(error)).trim() || "Git apply failed.";
  if (!detail.includes("Applied patch to")) {
    return detail;
  }
  if (detail.includes("with conflicts")) {
    return "Applied with conflicts. Resolve conflicts in the parent repo before retrying.";
  }
  return "Patch applied partially. Resolve changes in the parent repo before retrying.";
}

export async function applyGitPatch(repoRoot: string, patch: string) {
  const { tempDir, patchPath } = await writeTemporaryPatchFile(patch);
  try {
    await runGit(repoRoot, ["apply", "--3way", "--whitespace=nowarn", patchPath]);
  } catch (error) {
    throw new Error(normalizePatchApplyFailure(error), { cause: error });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function cloneRepository(url: string, destinationPath: string) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", url, destinationPath], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git clone exited with code ${code ?? -1}`));
    });
  });
}
