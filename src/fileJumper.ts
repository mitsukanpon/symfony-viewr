/**
 * Navigates from a route's controller reference to its source file,
 * opening the file at the matching method definition.
 * Supports both local PHP and Docker-based projects.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { RouteDefinition } from "./routeProvider";
import { SymfonyRunner, Psr4Map, resolveClassRelativePath } from "./symfonyRunner";

interface ControllerRef {
  className: string;
  methodName: string | undefined;
}

/** Parse a "Namespace\\Class::method" controller string into its parts. */
function parseController(controller: string): ControllerRef | undefined {
  if (!controller) {
    return undefined;
  }

  const [rawClass, rawMethod] = controller.split("::");
  const className = rawClass.trim();
  if (!className) {
    return undefined;
  }

  return { className, methodName: rawMethod?.trim() };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the line number of a PHP method definition within a file. Returns 0 if not found. */
async function findMethodLine(filePath: string, methodName: string): Promise<number> {
  const doc = await vscode.workspace.openTextDocument(filePath);
  const pattern = new RegExp(
    `(?:public|protected|private)?\\s+function\\s+${escapeRegExp(methodName)}\\s*\\(`,
    "m"
  );
  const match = pattern.exec(doc.getText());
  return match ? doc.positionAt(match.index).line : 0;
}

export class FileJumper {
  constructor(private readonly runner: SymfonyRunner) {}

  /** Jump to the controller file (and optionally the method) for a given route. */
  async jump(routeOrPartial: RouteDefinition | { controller: string }): Promise<void> {
    const { controller } = routeOrPartial;
    if (!controller) {
      vscode.window.showInformationMessage("No controller associated with this route.");
      return;
    }

    const ref = parseController(controller);
    if (!ref) {
      vscode.window.showWarningMessage(`Cannot parse controller: ${controller}`);
      return;
    }

    const projectRoot = this.runner.projectRoot;
    if (!projectRoot) {
      vscode.window.showWarningMessage("Project root not detected.");
      return;
    }

    const filePath = this.runner.useDocker
      ? await this.resolveViaDocker(ref, projectRoot)
      : await this.resolveLocal(ref, projectRoot);

    if (!filePath) {
      vscode.window.showWarningMessage(`Controller file not found: ${ref.className}`);
      return;
    }

    await this.openFileAtMethod(filePath, ref.methodName);
  }

  /** Open a file and scroll to the specified method. */
  private async openFileAtMethod(filePath: string, methodName?: string): Promise<void> {
    const line = methodName ? await findMethodLine(filePath, methodName) : 0;
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /** Resolve a controller class to a local file using the PSR-4 map, then fall back to filename search. */
  private async resolveLocal(
    ref: ControllerRef,
    projectRoot: string
  ): Promise<string | undefined> {
    const psr4Map = await this.runner.getPsr4Map();
    const resolved = resolveClassRelativePath(ref.className, psr4Map);

    if (resolved) {
      const filePath = path.join(projectRoot, resolved.dir, resolved.relativePath);
      const { existsSync } = await import("fs");
      if (existsSync(filePath)) {
        return filePath;
      }
    }

    return this.findByFileName(ref.className);
  }

  /** Fall-back: search the workspace for a PHP file matching the class name. */
  private async findByFileName(className: string): Promise<string | undefined> {
    const classFileName = className.split("\\").pop() + ".php";
    const results = await vscode.workspace.findFiles(
      `**/${classFileName}`,
      "**/vendor/**",
      5
    );

    if (results.length === 1) {
      return results[0].fsPath;
    }

    if (results.length > 1) {
      return vscode.window.showQuickPick(
        results.map((r) => r.fsPath),
        { placeHolder: "Multiple files found. Select one:" }
      );
    }

    return undefined;
  }

  /** Try local resolution first; if the file isn't mounted, copy it from the container. */
  private async resolveViaDocker(
    ref: ControllerRef,
    projectRoot: string
  ): Promise<string | undefined> {
    const localResult = await this.resolveLocal(ref, projectRoot);
    if (localResult) {
      return localResult;
    }

    const psr4Map = await this.runner.getPsr4Map();
    const resolved = resolveClassRelativePath(ref.className, psr4Map);
    if (!resolved) {
      return undefined;
    }

    const workdir = this.runner.dockerWorkdir;
    const containerPath = path.posix.join(workdir, resolved.dir, resolved.relativePath);

    const tmpDir = path.join(
      os.tmpdir(),
      "symfony-routes-viewer",
      ref.className.replace(/\\/g, "_")
    );

    return this.runner.copyFileFromDocker(containerPath, tmpDir);
  }
}
