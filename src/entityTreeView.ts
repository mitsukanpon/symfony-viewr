/**
 * TreeDataProvider for the Entities sidebar view.
 * Each entity is shown with its class name and table name,
 * expandable to reveal ORM-mapped properties.
 * Supports text-based filtering by class name, table name, or property name.
 */
import * as vscode from "vscode";
import { EntityProvider, EntityDefinition, EntityProperty } from "./entityProvider";

/** A tree item representing a Doctrine entity class. */
export class EntityTreeItem extends vscode.TreeItem {
  constructor(public readonly entity: EntityDefinition) {
    const label = entity.tableName
      ? `${entity.shortName}（${entity.tableName}）`
      : entity.shortName;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entity.className}**`);
    if (entity.tableName) {
      md.appendMarkdown(`\n\nTable: \`${entity.tableName}\``);
    }
    md.appendMarkdown(`\n\n${entity.properties.length} properties`);
    this.tooltip = md;

    this.iconPath = new vscode.ThemeIcon("symbol-class");
    this.contextValue = "entity";

    if (entity.filePath) {
      this.command = {
        command: "symfony-routes.openEntity",
        title: "Open Entity",
        arguments: [entity],
      };
    }
  }
}

/** A leaf item showing a single ORM property with its type and nullability. */
export class EntityPropertyItem extends vscode.TreeItem {
  constructor(prop: EntityProperty) {
    const nullableMarker = prop.nullable ? "?" : "";
    super(`${prop.name}: ${nullableMarker}${prop.type}`, vscode.TreeItemCollapsibleState.None);

    this.iconPath = prop.name === "id"
      ? new vscode.ThemeIcon("key")
      : new vscode.ThemeIcon("symbol-field");
    this.tooltip = `${prop.name}: ${nullableMarker}${prop.type}`;
  }
}

export class EntityTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedEntities: EntityDefinition[] = [];
  private entities: EntityTreeItem[] = [];
  private loading = false;
  private _filterText = "";

  constructor(private readonly entityProvider: EntityProvider) {}

  get filterText(): string {
    return this._filterText;
  }

  /** Apply a text filter. Pass an empty string to clear. */
  setFilter(text: string): void {
    this._filterText = text;
    vscode.commands.executeCommand("setContext", "symfonyEntities.filterActive", text.length > 0);
    this.rebuildTree();
  }

  /** Rebuild the displayed items from cached data, applying the active filter. */
  private rebuildTree(): void {
    const filtered = this._filterText
      ? this.cachedEntities.filter((e) => {
          const lower = this._filterText.toLowerCase();
          return (
            e.shortName.toLowerCase().includes(lower) ||
            e.className.toLowerCase().includes(lower) ||
            (e.tableName?.toLowerCase().includes(lower) ?? false) ||
            e.properties.some((p) => p.name.toLowerCase().includes(lower))
          );
        })
      : this.cachedEntities;
    this.entities = filtered.map((e) => new EntityTreeItem(e));
    this._onDidChangeTreeData.fire();
  }

  /** Fetch entities from the provider and rebuild the tree. */
  async refresh(): Promise<void> {
    if (this.loading) {
      return;
    }

    this.loading = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Symfony Entities: loading..." },
        async () => {
          this.cachedEntities = await this.entityProvider.fetchEntities();
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
      if (this.entities.length === 0) {
        const msg = this._filterText
          ? `"${this._filterText}" に一致するエンティティはありません`
          : "Click refresh to load entities";
        return [new vscode.TreeItem(msg, vscode.TreeItemCollapsibleState.None)];
      }
      return this.entities;
    }

    if (element instanceof EntityTreeItem) {
      return element.entity.properties.map((p) => new EntityPropertyItem(p));
    }

    return [];
  }
}
