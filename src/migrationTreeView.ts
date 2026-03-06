/**
 * TreeDataProvider for the Migrations sidebar view.
 * Displays migration versions with status icons (migrated / not migrated)
 * and supports text-based filtering.
 */
import * as vscode from "vscode";
import { MigrationProvider, MigrationDefinition, MigrationStatus } from "./migrationProvider";

/** Status-to-icon mapping — green check for migrated, yellow circle for pending. */
const STATUS_ICONS: Record<MigrationStatus, vscode.ThemeIcon> = {
  "migrated": new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green")),
  "not-migrated": new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("charts.yellow")),
  "unknown": new vscode.ThemeIcon("question"),
};

const STATUS_LABELS: Record<MigrationStatus, string> = {
  "migrated": "Migrated",
  "not-migrated": "Not Migrated",
  "unknown": "Unknown",
};

/** A tree item representing a single migration version. */
export class MigrationTreeItem extends vscode.TreeItem {
  constructor(public readonly migration: MigrationDefinition) {
    const hasChildren = !!migration.description || migration.tables.length > 0;
    const state = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    super(migration.version, state);

    this.iconPath = STATUS_ICONS[migration.status];
    this.tooltip = `${migration.version}\nStatus: ${STATUS_LABELS[migration.status]}`;
    this.contextValue = "migration";

    if (migration.filePath) {
      this.command = {
        command: "symfony-routes.openMigration",
        title: "Open Migration",
        arguments: [migration],
      };
      this.resourceUri = vscode.Uri.file(migration.filePath);
    }
  }
}

/** A leaf item showing migration detail (description or table name) with jump-to-line support. */
export class MigrationDetailItem extends vscode.TreeItem {
  constructor(label: string, icon: vscode.ThemeIcon, filePath: string, searchKeyword: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = icon;
    this.command = {
      command: "symfony-routes.openMigrationDetail",
      title: "Jump to Detail",
      arguments: [filePath, searchKeyword],
    };
  }
}

export class MigrationTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedMigrations: MigrationDefinition[] = [];
  private items: MigrationTreeItem[] = [];
  private loading = false;
  private _filterText = "";

  constructor(private readonly migrationProvider: MigrationProvider) {}

  get filterText(): string {
    return this._filterText;
  }

  /** Apply a text filter. Pass an empty string to clear. */
  setFilter(text: string): void {
    this._filterText = text;
    vscode.commands.executeCommand("setContext", "symfonyMigrations.filterActive", text.length > 0);
    this.rebuildTree();
  }

  /** Rebuild displayed items from cached data, applying the active filter. */
  private rebuildTree(): void {
    const filtered = this._filterText
      ? this.cachedMigrations.filter((m) => {
          const lower = this._filterText.toLowerCase();
          return (
            m.version.toLowerCase().includes(lower) ||
            m.description.toLowerCase().includes(lower) ||
            m.tables.some((t) => t.toLowerCase().includes(lower))
          );
        })
      : this.cachedMigrations;
    this.items = filtered.map((m) => new MigrationTreeItem(m));
    this._onDidChangeTreeData.fire();
  }

  /** Fetch migrations from the provider and rebuild the tree. */
  async refresh(): Promise<void> {
    if (this.loading) {
      return;
    }

    this.loading = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Symfony Migrations: loading..." },
        async () => {
          this.cachedMigrations = await this.migrationProvider.fetchMigrations();
          this.rebuildTree();
        }
      );
    } finally {
      this.loading = false;
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!element) {
      if (this.items.length === 0) {
        const msg = this._filterText
          ? `"${this._filterText}" に一致するマイグレーションはありません`
          : "Click refresh to load migrations";
        return [new vscode.TreeItem(msg, vscode.TreeItemCollapsibleState.None)];
      }
      return this.items;
    }

    if (element instanceof MigrationTreeItem) {
      const items: vscode.TreeItem[] = [];
      const m = element.migration;
      if (m.description && m.filePath) {
        items.push(new MigrationDetailItem(
          m.description, new vscode.ThemeIcon("note"),
          m.filePath, "getDescription"
        ));
      }
      if (m.filePath) {
        for (const table of m.tables) {
          items.push(new MigrationDetailItem(
            table, new vscode.ThemeIcon("database"),
            m.filePath, table
          ));
        }
      }
      return items;
    }

    return [];
  }
}
