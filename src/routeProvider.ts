/**
 * Fetches route definitions from Symfony's `debug:router` console command
 * and enriches them with Twig template associations.
 */
import { SymfonyRunner } from "./symfonyRunner";
import { TwigProvider, TwigDependency } from "./twigProvider";

export interface RouteTemplate {
  relativePath: string;
  absolutePath: string;
  /** Structural dependencies found inside this template (extends, include, etc.) */
  dependencies: TwigDependency[];
}

export interface RouteDefinition {
  name: string;
  path: string;
  method: string;
  controller: string;
  templates: RouteTemplate[];
}

interface DebugRouterEntry {
  method?: string;
  path?: string;
  defaults?: { _controller?: string };
}

export class RouteProvider {
  constructor(
    private readonly runner: SymfonyRunner,
    private readonly twigProvider: TwigProvider
  ) {}

  /** Run `debug:router` and return parsed route definitions sorted by path. */
  async fetchRoutes(): Promise<RouteDefinition[]> {
    const raw = await this.runner.runConsoleCommand("debug:router --show-controllers --format=json");
    if (!raw) {
      return [];
    }

    try {
      const routes = this.parseJson(raw);
      this.attachTemplates(routes);
      return routes;
    } catch {
      return [];
    }
  }

  /** Parse the JSON output of `debug:router`, filtering out internal routes. */
  private parseJson(raw: string): RouteDefinition[] {
    const obj: Record<string, DebugRouterEntry> = JSON.parse(raw);

    return Object.entries(obj)
      .filter(([name]) => !name.startsWith("_"))
      .map(([name, entry]) => ({
        name,
        path: entry.path ?? "",
        method: entry.method ?? "ANY",
        controller: entry.defaults?._controller ?? "",
        templates: [],
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Cross-reference each route's controller with the Twig template map.
   * Tries multiple matching strategies:
   *   1. Exact "ClassName::method" match
   *   2. __invoke controllers matched against "ClassName::__invoke"
   *   3. Partial class name match (for namespaced controllers)
   */
  private attachTemplates(routes: RouteDefinition[]): void {
    const templateMap = this.twigProvider.getControllerToTemplateMap();

    for (const route of routes) {
      if (!route.controller) {
        continue;
      }

      const refs = this.findTemplates(route.controller, templateMap);
      if (refs) {
        route.templates = refs.map((ref) => ({
          ...ref,
          dependencies: this.twigProvider.parseTwigDependencies(ref.absolutePath),
        }));
      }
    }
  }

  /** Try multiple strategies to match a controller string to the template map. */
  private findTemplates(
    controller: string,
    templateMap: Map<string, { relativePath: string; absolutePath: string }[]>
  ): { relativePath: string; absolutePath: string }[] | undefined {
    // "FQCN::method" -> "ClassName::method"
    const normalized = controller.replace(/^.*\\/, "");
    const found = templateMap.get(normalized);
    if (found) {
      return found;
    }

    // __invoke controllers: "FQCN" (no ::method) -> try "ClassName::__invoke"
    if (!controller.includes("::")) {
      const className = controller.replace(/^.*\\/, "");
      const invokeResult = templateMap.get(`${className}::__invoke`);
      if (invokeResult) {
        return invokeResult;
      }
    }

    // Partial match: iterate all keys looking for matching class::method
    const classAndMethod = normalized;
    for (const [key, refs] of templateMap) {
      if (key === classAndMethod || key.endsWith(`\\${classAndMethod}`)) {
        return refs;
      }
    }

    return undefined;
  }
}
