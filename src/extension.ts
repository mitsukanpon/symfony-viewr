/**
 * Extension entry point.
 * Registers sidebar views, commands, and auto-detects the project
 * environment (local PHP vs Docker) on activation.
 */
import * as vscode from "vscode";
import { SymfonyRunner } from "./symfonyRunner";
import { RouteProvider } from "./routeProvider";
import { RouteTreeViewProvider } from "./routeTreeView";
import { EntityProvider } from "./entityProvider";
import { EntityTreeViewProvider } from "./entityTreeView";
import { MigrationProvider } from "./migrationProvider";
import { MigrationTreeViewProvider } from "./migrationTreeView";
import { TwigProvider } from "./twigProvider";
import { FileJumper } from "./fileJumper";
import { isCommandAvailable } from "./shellUtils";

export function activate(context: vscode.ExtensionContext) {
  const runner = new SymfonyRunner();

  // --- Data providers ---
  const twigProvider = new TwigProvider(runner);
  const routeProvider = new RouteProvider(runner, twigProvider);
  const entityProvider = new EntityProvider(runner);
  const migrationProvider = new MigrationProvider(runner);

  // --- Tree view providers ---
  const routeTreeView = new RouteTreeViewProvider(routeProvider);
  const entityTreeView = new EntityTreeViewProvider(entityProvider);
  const migrationTreeView = new MigrationTreeViewProvider(migrationProvider);

  const fileJumper = new FileJumper(runner);

  // --- Register tree views ---
  context.subscriptions.push(
    vscode.window.createTreeView("symfonyRoutesView", {
      treeDataProvider: routeTreeView,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView("symfonyEntitiesView", {
      treeDataProvider: entityTreeView,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView("symfonyMigrationsView", {
      treeDataProvider: migrationTreeView,
      showCollapseAll: true,
    }),

    // --- Route commands ---
    vscode.commands.registerCommand("symfony-routes.refresh", () =>
      routeTreeView.refresh()
    ),
    vscode.commands.registerCommand(
      "symfony-routes.openController",
      (route: { controller: string }) => fileJumper.jump(route)
    ),

    // --- Entity commands ---
    vscode.commands.registerCommand("symfony-routes.refreshEntities", () =>
      entityTreeView.refresh()
    ),
    vscode.commands.registerCommand(
      "symfony-routes.openEntity",
      (entity: { filePath?: string }) => {
        if (entity.filePath) {
          vscode.window.showTextDocument(vscode.Uri.file(entity.filePath));
        }
      }
    ),

    // --- Migration commands ---
    vscode.commands.registerCommand("symfony-routes.refreshMigrations", () =>
      migrationTreeView.refresh()
    ),
    vscode.commands.registerCommand(
      "symfony-routes.openMigration",
      (migration: { filePath?: string }) => {
        if (migration.filePath) {
          vscode.window.showTextDocument(vscode.Uri.file(migration.filePath));
        }
      }
    ),
    vscode.commands.registerCommand("symfony-routes.generateMigration", async () => {
      const filePath = migrationProvider.generateMigration();
      if (!filePath) {
        vscode.window.showWarningMessage("Migration directory not found.");
        return;
      }

      vscode.window.showInformationMessage("Migration file generated.");
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
      migrationTreeView.refresh();
    }),

    // --- Twig open command (used from Routes view) ---
    vscode.commands.registerCommand(
      "symfony-routes.openTwig",
      (template: { absolutePath?: string }) => {
        if (template.absolutePath) {
          vscode.window.showTextDocument(vscode.Uri.file(template.absolutePath));
        }
      }
    ),

    // --- Route grouping ---
    vscode.commands.registerCommand("symfony-routes.setRouteGroupDepth", async () => {
      const current = routeTreeView.groupDepth;
      const items = [
        { label: "No grouping", value: 0 },
        { label: "1st segment", description: "e.g. /order, /product", value: 1 },
        { label: "2nd segment", description: "e.g. /order/edit, /product/list", value: 2 },
        { label: "3rd segment", value: 3 },
      ].map((item) => ({
        ...item,
        description: (item.description ?? "") + (item.value === current ? " (current)" : ""),
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Group routes by path depth",
      });
      if (picked === undefined) {
        return;
      }

      routeTreeView.setGroupDepth(picked.value);
      await vscode.workspace
        .getConfiguration("symfony-routes")
        .update("routeGroupDepth", picked.value, vscode.ConfigurationTarget.WorkspaceFolder);
    }),

    // --- Search: Routes ---
    vscode.commands.registerCommand("symfony-routes.searchRoutes", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Search routes (path / name / controller)",
        value: routeTreeView.filterText,
        placeHolder: "e.g. /admin, product, Controller",
      });
      if (input !== undefined) {
        routeTreeView.setFilter(input);
      }
    }),
    vscode.commands.registerCommand("symfony-routes.clearSearchRoutes", () => {
      routeTreeView.setFilter("");
    }),

    // --- Search: Entities ---
    vscode.commands.registerCommand("symfony-routes.searchEntities", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Search entities (class / table / property name)",
        value: entityTreeView.filterText,
        placeHolder: "e.g. Product, dtb_product, name",
      });
      if (input !== undefined) {
        entityTreeView.setFilter(input);
      }
    }),
    vscode.commands.registerCommand("symfony-routes.clearSearchEntities", () => {
      entityTreeView.setFilter("");
    }),

    // --- Search: Migrations ---
    vscode.commands.registerCommand("symfony-routes.searchMigrations", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Search migrations (version / description)",
        value: migrationTreeView.filterText,
        placeHolder: "e.g. 20240101, Version",
      });
      if (input !== undefined) {
        migrationTreeView.setFilter(input);
      }
    }),
    vscode.commands.registerCommand("symfony-routes.clearSearchMigrations", () => {
      migrationTreeView.setFilter("");
    })
  );

  // Auto-detect project root and prompt for environment setup
  runner.detectProjectRoot().then((root) => {
    if (root) {
      promptEnvironmentAndRefresh(runner, twigProvider, routeTreeView, entityTreeView, migrationTreeView);
    }
  });
}

/**
 * Check whether PHP is available locally or via Docker,
 * prompt the user if needed, then refresh all views.
 */
async function promptEnvironmentAndRefresh(
  runner: SymfonyRunner,
  twigProvider: TwigProvider,
  routeTreeView: RouteTreeViewProvider,
  entityTreeView: EntityTreeViewProvider,
  migrationTreeView: MigrationTreeViewProvider
): Promise<void> {
  const config = runner.getConfig();

  if (config.get<boolean>("useDocker")) {
    refreshAll(twigProvider, routeTreeView, entityTreeView, migrationTreeView);
    return;
  }

  const phpPath = config.get<string>("phpPath") ?? "php";
  if (isCommandAvailable(`${phpPath} -v`)) {
    refreshAll(twigProvider, routeTreeView, entityTreeView, migrationTreeView);
    return;
  }

  if (!isCommandAvailable("docker --version")) {
    vscode.window.showWarningMessage(
      "Neither PHP nor Docker was found. Set symfony-routes.phpPath in settings."
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "PHP not found locally. Run commands via Docker?",
    "Use Docker",
    "Cancel"
  );
  if (choice !== "Use Docker") {
    return;
  }

  await config.update("useDocker", true, vscode.ConfigurationTarget.WorkspaceFolder);
  const service = await vscode.window.showInputBox({
    prompt: "Enter the Docker Compose service name",
    value: "app",
    placeHolder: "e.g. app, php, web",
  });
  if (service) {
    await config.update("dockerService", service, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  refreshAll(twigProvider, routeTreeView, entityTreeView, migrationTreeView);
}

/** Clear caches and refresh all sidebar views in parallel. */
function refreshAll(
  twigProvider: TwigProvider,
  routeTreeView: RouteTreeViewProvider,
  entityTreeView: EntityTreeViewProvider,
  migrationTreeView: MigrationTreeViewProvider
): void {
  twigProvider.clearCache();
  Promise.all([
    routeTreeView.refresh(),
    entityTreeView.refresh(),
    migrationTreeView.refresh(),
  ]);
}

export function deactivate() {}
