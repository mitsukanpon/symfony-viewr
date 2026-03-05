/**
 * Core runner that detects the Symfony/EC-CUBE project root and
 * executes `bin/console` commands either locally or via Docker Compose.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { quoteArg, execCmd, execCmdAsync, getDockerComposeCmd } from "./shellUtils";

/** PSR-4 autoload map — namespace prefix to directory path(s). */
export interface Psr4Map {
  [prefix: string]: string | string[];
}

interface ComposerJson {
  autoload?: { "psr-4"?: Record<string, string | string[]> };
  "autoload-dev"?: { "psr-4"?: Record<string, string | string[]> };
}

export class SymfonyRunner {
  private _projectRoot: string | undefined;
  private _projectUri: vscode.Uri | undefined;
  private _psr4Cache: Psr4Map | undefined;

  /** Return the VS Code workspace configuration scoped to `symfony-routes`. */
  getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("symfony-routes", this._projectUri);
  }

  get useDocker(): boolean {
    return this.getConfig().get<boolean>("useDocker") ?? false;
  }

  get dockerService(): string {
    return this.getConfig().get<string>("dockerService") ?? "app";
  }

  get dockerWorkdir(): string {
    return this.getConfig().get<string>("dockerWorkdir") ?? "/var/www/html";
  }

  get projectRoot(): string | undefined {
    return this._projectRoot;
  }

  /**
   * Scan open workspace folders and pick the first one that looks like
   * a Symfony or EC-CUBE project (has a composer.json referencing symfony/ or ec-cube/).
   */
  async detectProjectRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      return undefined;
    }

    for (const folder of folders) {
      if (this.isSymfonyProject(folder.uri.fsPath)) {
        this._projectRoot = folder.uri.fsPath;
        this._projectUri = folder.uri;
        return this._projectRoot;
      }
    }
    return undefined;
  }

  /**
   * Run a Symfony console command (e.g. `debug:router --format=json`).
   * Automatically chooses local PHP or Docker execution based on settings.
   */
  async runConsoleCommand(args: string, timeout = 60000): Promise<string | undefined> {
    const root = this._projectRoot;
    if (!root) {
      return undefined;
    }

    const cmd = this.buildConsoleCommand(args);
    try {
      return await execCmdAsync(cmd, {
        cwd: root,
        timeout,
        env: { ...process.env, COLUMNS: "500" },
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Failed to run ${args.split(" ")[0]} — ${message}`);
      return undefined;
    }
  }

  /** Build and cache a PSR-4 autoload map from `composer.json`. */
  async getPsr4Map(): Promise<Psr4Map> {
    if (this._psr4Cache) {
      return this._psr4Cache;
    }

    const root = this._projectRoot;
    if (!root) {
      return {};
    }

    try {
      const raw = this.useDocker
        ? this.readComposerFromDocker(root)
        : this.readComposerFromLocal(root);

      if (!raw) {
        return {};
      }

      const composer: ComposerJson = JSON.parse(raw);
      this._psr4Cache = {
        ...composer.autoload?.["psr-4"],
        ...composer["autoload-dev"]?.["psr-4"],
      };
      return this._psr4Cache;
    } catch {
      return {};
    }
  }

  /** Copy a file from the Docker container to a local directory via `docker cp`. */
  copyFileFromDocker(containerPath: string, localDir: string): string | undefined {
    const root = this._projectRoot;
    if (!root) {
      return undefined;
    }

    try {
      fs.mkdirSync(localDir, { recursive: true });

      const dc = getDockerComposeCmd();
      const containerId = execCmd(
        `${dc} ps -q ${this.dockerService}`,
        { cwd: root, timeout: 10000 }
      ).trim();

      const normalizedPath = containerPath.replace(/\\/g, "/");
      const localPath = path.join(localDir, path.basename(containerPath));
      execCmd(
        `docker cp ${containerId}:${normalizedPath} ${quoteArg(localPath)}`,
        { cwd: root, timeout: 15000 }
      );

      return localPath;
    } catch {
      return undefined;
    }
  }

  /** Resolve a fully-qualified class name to a local file path using the PSR-4 map. */
  resolveClassToFile(className: string, psr4Map: Psr4Map): string | undefined {
    const root = this._projectRoot;
    if (!root) {
      return undefined;
    }

    const resolved = resolveClassRelativePath(className, psr4Map);
    if (!resolved) {
      return undefined;
    }

    const filePath = path.join(root, resolved.dir, resolved.relativePath);
    return fs.existsSync(filePath) ? filePath : undefined;
  }

  /** Heuristic: check if the folder contains a Symfony/EC-CUBE composer.json. */
  private isSymfonyProject(folderPath: string): boolean {
    const composerPath = path.join(folderPath, "composer.json");
    try {
      const raw = fs.readFileSync(composerPath, "utf-8");
      return raw.includes("symfony/") || raw.includes("ec-cube/");
    } catch {
      return false;
    }
  }

  /** Build the full shell command string for running bin/console. */
  private buildConsoleCommand(args: string): string {
    const config = this.getConfig();
    const phpPath = quoteArg(config.get<string>("phpPath") ?? "php");
    const consolePath = config.get<string>("consolePath") ?? "bin/console";

    if (this.useDocker) {
      const dc = getDockerComposeCmd();
      const containerConsole = consolePath.replace(/\\/g, "/");
      return `${dc} exec -T ${this.dockerService} ${phpPath} ${containerConsole} ${args}`;
    }

    const localConsole = quoteArg(consolePath.replace(/\//g, path.sep));
    return `${phpPath} ${localConsole} ${args}`;
  }

  private readComposerFromLocal(root: string): string | undefined {
    const composerPath = path.join(root, "composer.json");
    try {
      return fs.readFileSync(composerPath, "utf-8");
    } catch {
      return undefined;
    }
  }

  private readComposerFromDocker(root: string): string | undefined {
    try {
      const dc = getDockerComposeCmd();
      const containerPath = this.dockerWorkdir.replace(/\\/g, "/") + "/composer.json";
      return execCmd(
        `${dc} exec -T ${this.dockerService} cat ${containerPath}`,
        { cwd: root, timeout: 15000 }
      );
    } catch {
      return undefined;
    }
  }
}

/**
 * Convert a fully-qualified PHP class name to a relative file path
 * using the PSR-4 namespace-to-directory mapping from composer.json.
 */
export function resolveClassRelativePath(
  className: string,
  psr4Map: Psr4Map
): { dir: string; relativePath: string } | undefined {
  const normalized = className.replace(/\\\\/g, "\\");

  for (const [prefix, dirs] of Object.entries(psr4Map)) {
    const normalizedPrefix = prefix.replace(/\\\\/g, "\\");
    if (!normalized.startsWith(normalizedPrefix)) {
      continue;
    }

    const relative = normalized.slice(normalizedPrefix.length).replace(/\\/g, "/") + ".php";
    const dirList = Array.isArray(dirs) ? dirs : [dirs];

    for (const dir of dirList) {
      return { dir, relativePath: relative };
    }
  }

  return undefined;
}
