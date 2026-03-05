/**
 * Tree item definitions for the Routes sidebar view.
 * Provides category grouping (Admin / Front / Other), path-based sub-grouping,
 * individual route items with method-coloured icons, and Twig template
 * structure display (extends, include, embed, use).
 */
import * as vscode from "vscode";
import { RouteDefinition, RouteTemplate } from "./routeProvider";
import { TwigDependency } from "./twigProvider";

/** Icon mapping for HTTP methods. */
const METHOD_ICONS: Record<string, vscode.ThemeIcon> = {
  GET: new vscode.ThemeIcon("arrow-down", new vscode.ThemeColor("charts.green")),
  POST: new vscode.ThemeIcon("arrow-up", new vscode.ThemeColor("charts.blue")),
  PUT: new vscode.ThemeIcon("arrow-swap", new vscode.ThemeColor("charts.orange")),
  PATCH: new vscode.ThemeIcon("arrow-swap", new vscode.ThemeColor("charts.yellow")),
  DELETE: new vscode.ThemeIcon("trash", new vscode.ThemeColor("charts.red")),
  ANY: new vscode.ThemeIcon("globe"),
};

const CATEGORY_META = {
  admin: { label: "Admin", icon: new vscode.ThemeIcon("shield") },
  front: { label: "Front", icon: new vscode.ThemeIcon("browser") },
  other: { label: "Other", icon: new vscode.ThemeIcon("ellipsis") },
} as const;

export type RouteCategory = keyof typeof CATEGORY_META;

/** Icon mapping for Twig dependency types. */
const DEP_ICONS: Record<TwigDependency["type"], vscode.ThemeIcon> = {
  extends: new vscode.ThemeIcon("type-hierarchy-sub", new vscode.ThemeColor("charts.purple")),
  include: new vscode.ThemeIcon("file-symlink-file", new vscode.ThemeColor("charts.blue")),
  embed: new vscode.ThemeIcon("file-submodule", new vscode.ThemeColor("charts.orange")),
  use: new vscode.ThemeIcon("references", new vscode.ThemeColor("charts.green")),
};

/** Top-level category node (Admin / Front / Other) that groups routes. */
export class RouteCategoryItem extends vscode.TreeItem {
  constructor(
    public readonly category: RouteCategory,
    public readonly children: (RouteGroupItem | RouteTreeItem)[]
  ) {
    const total = children.reduce(
      (n, c) => n + (c instanceof RouteGroupItem ? c.routes.length : 1),
      0
    );
    const meta = CATEGORY_META[category];
    super(`${meta.label} (${total})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = meta.icon;
    this.contextValue = "category";
  }
}

/** A single route item showing HTTP method, path, and route name. */
export class RouteTreeItem extends vscode.TreeItem {
  constructor(public readonly route: RouteDefinition) {
    const methods = route.method || "ANY";
    super(`[${methods}] ${route.path}`, vscode.TreeItemCollapsibleState.Collapsed);

    this.description = route.name;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${route.name}**\n\n`);
    md.appendMarkdown(`- Path: \`${route.path}\`\n`);
    md.appendMarkdown(`- Method: \`${methods}\`\n`);
    md.appendMarkdown(`- Controller: \`${route.controller || "N/A"}\`\n`);
    if (route.templates.length > 0) {
      md.appendMarkdown(`- Template: ${route.templates.map((t) => `\`${t.relativePath}\``).join(", ")}\n`);
    }
    this.tooltip = md;

    this.contextValue = "route";

    const primaryMethod = methods.split("|")[0];
    this.iconPath = METHOD_ICONS[primaryMethod] ?? METHOD_ICONS["ANY"];
  }
}

/** A folder-like group node that clusters routes sharing a common path prefix. */
export class RouteGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupKey: string,
    public readonly routes: RouteTreeItem[]
  ) {
    super(
      `/${groupKey}`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    this.description = `(${routes.length})`;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.contextValue = "routeGroup";
  }
}

/** Child item showing the controller class::method for a route. */
export class RouteControllerItem extends vscode.TreeItem {
  constructor(controller: string) {
    const short = controller.includes("\\")
      ? controller.replace(/^.*\\/, "")
      : controller;
    super(short, vscode.TreeItemCollapsibleState.None);
    this.description = "Controller";
    this.iconPath = new vscode.ThemeIcon("symbol-method");
    this.tooltip = controller;
    this.contextValue = "routeController";

    if (controller) {
      this.command = {
        command: "symfony-routes.openController",
        title: "Open Controller",
        arguments: [{ controller }],
      };
    }
  }
}

/** Child item showing a Twig template rendered by a route's controller. Expandable if it has dependencies. */
export class RouteTemplateItem extends vscode.TreeItem {
  public readonly dependencies: TwigDependency[];

  constructor(public readonly template: RouteTemplate) {
    const hasDeps = template.dependencies.length > 0;
    super(
      template.relativePath,
      hasDeps ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.description = "Template";
    this.iconPath = new vscode.ThemeIcon("file-code");
    this.tooltip = template.relativePath;
    this.contextValue = "routeTemplate";
    this.dependencies = template.dependencies;

    this.command = {
      command: "symfony-routes.openTwig",
      title: "Open Template",
      arguments: [template],
    };
  }
}

/** Leaf item showing a Twig structural dependency (extends / include / embed / use). */
export class TwigDependencyItem extends vscode.TreeItem {
  constructor(dep: TwigDependency) {
    super(dep.templateName, vscode.TreeItemCollapsibleState.None);
    this.description = dep.type;
    this.iconPath = DEP_ICONS[dep.type];
    this.tooltip = `${dep.type}: ${dep.templateName}`;
    this.contextValue = "twigDependency";

    if (dep.absolutePath) {
      this.command = {
        command: "symfony-routes.openTwig",
        title: "Open Template",
        arguments: [{ absolutePath: dep.absolutePath }],
      };
    }
  }
}
