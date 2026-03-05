/**
 * TreeDataProvider for the Routes sidebar view.
 * Supports categorisation (Admin / Front / Other), path-depth grouping,
 * and text-based filtering across path, name, and controller.
 */
import * as vscode from "vscode";
import { RouteProvider, RouteDefinition } from "./routeProvider";
import {
  RouteTreeItem,
  RouteControllerItem,
  RouteTemplateItem,
  TwigDependencyItem,
  RouteGroupItem,
  RouteCategoryItem,
  RouteCategory,
} from "./routeTreeItem";

const CATEGORY_ORDER: RouteCategory[] = ["front", "admin", "other"];

/** Path prefix to strip when computing group keys per category. */
const CATEGORY_PREFIX: Record<RouteCategory, string> = {
  admin: "admin",
  front: "",
  other: "",
};

/** Determine which category a route belongs to based on its path, name, and controller. */
function categorize(route: RouteDefinition): RouteCategory {
  const p = route.path.toLowerCase();
  const name = route.name.toLowerCase();
  const ctrl = route.controller.toLowerCase();

  if (p.startsWith("/admin") || name.startsWith("admin_") || ctrl.includes("\\admin\\")) {
    return "admin";
  }
  if (p.startsWith("/api/") || p.startsWith("/_")) {
    return "other";
  }
  return "front";
}

/**
 * Extract a group key from a route path at a given depth.
 * The category-specific prefix (e.g. "admin") is skipped so that
 * admin routes group by the segment *after* `/admin/`.
 */
function extractGroupKey(routePath: string, category: RouteCategory, depth: number): string {
  const stripped = routePath.replace(/^\//, "");
  const segments = stripped.split("/").filter(Boolean);

  const prefix = CATEGORY_PREFIX[category];
  const start = prefix && segments[0]?.toLowerCase() === prefix ? 1 : 0;

  const key = segments.slice(start, start + depth).join("/");
  return key || "(root)";
}

export class RouteTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedRoutes: RouteDefinition[] = [];
  private categories: RouteCategoryItem[] = [];
  private loading = false;
  private _groupDepth = 0;
  private _filterText = "";

  constructor(private readonly routeProvider: RouteProvider) {
    this._groupDepth = vscode.workspace
      .getConfiguration("symfony-routes")
      .get<number>("routeGroupDepth", 0);
  }

  get groupDepth(): number {
    return this._groupDepth;
  }

  get filterText(): string {
    return this._filterText;
  }

  setGroupDepth(depth: number): void {
    this._groupDepth = depth;
    this.rebuildTree();
  }

  /** Apply a text filter. Pass an empty string to clear. */
  setFilter(text: string): void {
    this._filterText = text;
    vscode.commands.executeCommand("setContext", "symfonyRoutes.filterActive", text.length > 0);
    this.rebuildTree();
  }

  /** Rebuild the tree from cached data (applies both filter and grouping). */
  private rebuildTree(): void {
    const filtered = this.applyFilter(this.cachedRoutes);
    this.categories = this.buildCategories(filtered);
    this._onDidChangeTreeData.fire();
  }

  /** Case-insensitive match against path, name, and controller. */
  private applyFilter(routes: RouteDefinition[]): RouteDefinition[] {
    if (!this._filterText) {
      return routes;
    }
    const lower = this._filterText.toLowerCase();
    return routes.filter(
      (r) =>
        r.path.toLowerCase().includes(lower) ||
        r.name.toLowerCase().includes(lower) ||
        r.controller.toLowerCase().includes(lower)
    );
  }

  /** Fetch routes from the Symfony console and rebuild the tree. */
  async refresh(): Promise<void> {
    if (this.loading) {
      return;
    }

    this.loading = true;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Symfony Routes: loading..." },
        async () => {
          this.cachedRoutes = await this.routeProvider.fetchRoutes();
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
      if (this.categories.length === 0) {
        const msg = this._filterText
          ? `"${this._filterText}" に一致するルートはありません`
          : "Click refresh to load routes";
        return [new vscode.TreeItem(msg, vscode.TreeItemCollapsibleState.None)];
      }
      return this.categories;
    }

    if (element instanceof RouteCategoryItem) {
      return element.children;
    }

    if (element instanceof RouteGroupItem) {
      return element.routes;
    }

    if (element instanceof RouteTreeItem) {
      const r = element.route;
      const children: vscode.TreeItem[] = [];
      if (r.controller) {
        children.push(new RouteControllerItem(r.controller));
      }
      for (const tpl of r.templates) {
        children.push(new RouteTemplateItem(tpl));
      }
      return children;
    }

    if (element instanceof RouteTemplateItem) {
      return element.dependencies.map((dep) => new TwigDependencyItem(dep));
    }

    return [];
  }

  /** Partition routes into Admin / Front / Other categories, applying grouping if enabled. */
  private buildCategories(routes: RouteDefinition[]): RouteCategoryItem[] {
    const groups: Record<RouteCategory, RouteDefinition[]> = {
      admin: [],
      front: [],
      other: [],
    };

    for (const route of routes) {
      groups[categorize(route)].push(route);
    }

    return CATEGORY_ORDER
      .filter((cat) => groups[cat].length > 0)
      .map((cat) => {
        const items = groups[cat].map((r) => new RouteTreeItem(r));
        const children = this._groupDepth > 0
          ? this.groupRoutes(items, cat)
          : items;
        return new RouteCategoryItem(cat, children);
      });
  }

  /** Group route items by shared path prefix at the configured depth. */
  private groupRoutes(
    items: RouteTreeItem[],
    category: RouteCategory
  ): (RouteGroupItem | RouteTreeItem)[] {
    const map = new Map<string, RouteTreeItem[]>();

    for (const item of items) {
      const key = extractGroupKey(item.route.path, category, this._groupDepth);
      const list = map.get(key);
      if (list) {
        list.push(item);
      } else {
        map.set(key, [item]);
      }
    }

    const result: (RouteGroupItem | RouteTreeItem)[] = [];
    for (const [key, groupItems] of map) {
      if (groupItems.length === 1) {
        result.push(groupItems[0]);
      } else {
        result.push(new RouteGroupItem(key, groupItems));
      }
    }
    return result;
  }
}
