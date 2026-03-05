/**
 * Shell command execution utilities.
 * Provides cross-platform helpers for running CLI commands synchronously and asynchronously.
 */
import { execSync, exec, ExecSyncOptions } from "child_process";

export const IS_WINDOWS = process.platform === "win32";

const SHELL = IS_WINDOWS ? "cmd.exe" : "/bin/sh";

/** Wrap an argument in quotes if it contains spaces (platform-aware). */
export function quoteArg(arg: string): string {
  if (!arg.includes(" ")) {
    return arg;
  }
  return IS_WINDOWS ? `"${arg}"` : `'${arg}'`;
}

/** Execute a command synchronously and return stdout as a string. */
export function execCmd(cmd: string, options: ExecSyncOptions = {}): string {
  return execSync(cmd, {
    ...options,
    shell: SHELL,
    encoding: "utf-8",
  });
}

/** Execute a command asynchronously. Resolves with stdout or rejects on error. */
export function execCmdAsync(
  cmd: string,
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { ...options, shell: SHELL, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout as string);
        }
      }
    );
  });
}

/** Check whether a CLI command is available by running it with a short timeout. */
export function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(cmd, { timeout: 5000, stdio: "pipe", shell: SHELL });
    return true;
  } catch {
    return false;
  }
}

let cachedDockerComposeCmd: string | undefined;

/**
 * Detect and return the Docker Compose command.
 * Prefers the newer `docker compose` plugin syntax; falls back to the legacy `docker-compose`.
 */
export function getDockerComposeCmd(): string {
  if (!cachedDockerComposeCmd) {
    cachedDockerComposeCmd = isCommandAvailable("docker compose version")
      ? "docker compose"
      : "docker-compose";
  }
  return cachedDockerComposeCmd;
}
