/**
 * Scans controller files to build a mapping from controller methods to
 * the Twig templates they render. Also parses Twig files for structural
 * dependencies (extends, include, embed, use).
 *
 * Template directories searched:
 *   - app/template — EC-CUBE
 *   - templates — standard Symfony
 *   - src/Eccube/Resource/template — EC-CUBE core
 *   - app/Plugin/NAME/Resource/template — EC-CUBE plugins
 *
 * Controller directories searched:
 *   - src/Controller
 *   - src/Eccube/Controller
 *   - app/Customize/Controller — EC-CUBE customisation
 *   - app/Plugin/NAME/Controller — EC-CUBE plugins
 */
import * as fs from "fs";
import * as path from "path";
import { SymfonyRunner } from "./symfonyRunner";

export interface TemplateRef {
  relativePath: string;
  absolutePath: string;
}

/** A structural dependency found inside a Twig template. */
export interface TwigDependency {
  type: "extends" | "include" | "embed" | "use";
  templateName: string;
  absolutePath: string | undefined;
}

// --- Controller-side detection patterns ---

// Legacy docblock annotation: @Template("path/to/template.html.twig")
const TEMPLATE_ANNOTATION = /@Template\s*\(\s*["']([^"']+)["']\s*\)/;
// PHP 8 attribute: #[Template('path/to/template.html.twig')]
const PHP8_TEMPLATE_ATTR = /#\[Template\s*\(\s*["']([^"']+)["']\s*\)/;
// $this->render(...), $this->renderView(...), $this->renderForm(...)
const RENDER_CALL_RE = /->render(?:View|Form|Response)?\s*\(\s*['"]([^'"]+)['"]/;
// EC-CUBE: $app['twig']->render(...)
const ECCUBE_TWIG_RENDER = /\['twig'\]\s*->\s*render\s*\(\s*['"]([^'"]+)['"]/;
const METHOD_DEF_RE = /(?:public|protected)\s+function\s+(\w+)\s*\(/;

// --- Twig-side structural patterns ---

const TWIG_EXTENDS_RE = /\{%\s*extends\s+['"]([^'"]+)['"]/g;
const TWIG_INCLUDE_RE = /\{[%{]\s*include\s*\(?\s*['"]([^'"]+)['"]/g;
const TWIG_EMBED_RE = /\{%\s*embed\s+['"]([^'"]+)['"]/g;
const TWIG_USE_RE = /\{%\s*use\s+['"]([^'"]+)['"]/g;

export class TwigProvider {
  private ctrlToTplCache: Map<string, TemplateRef[]> | undefined;
  private templateDirsCache: string[] | undefined;

  constructor(private readonly runner: SymfonyRunner) {}

  /** Return the cached controller-to-template map, building it on first access. */
  getControllerToTemplateMap(): Map<string, TemplateRef[]> {
    if (this.ctrlToTplCache) {
      return this.ctrlToTplCache;
    }
    this.ctrlToTplCache = this.buildControllerToTemplateMap();
    return this.ctrlToTplCache;
  }

  clearCache(): void {
    this.ctrlToTplCache = undefined;
    this.templateDirsCache = undefined;
  }

  /**
   * Parse a Twig file for structural dependencies:
   * extends, include, embed, and use statements.
   */
  parseTwigDependencies(absolutePath: string): TwigDependency[] {
    const root = this.runner.projectRoot;
    if (!root) {
      return [];
    }

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      return [];
    }

    const templateDirs = this.getTemplateDirs(root);
    const deps: TwigDependency[] = [];

    const patterns: Array<{ re: RegExp; type: TwigDependency["type"] }> = [
      { re: TWIG_EXTENDS_RE, type: "extends" },
      { re: TWIG_INCLUDE_RE, type: "include" },
      { re: TWIG_EMBED_RE, type: "embed" },
      { re: TWIG_USE_RE, type: "use" },
    ];

    for (const { re, type } of patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const templateName = match[1];
        const resolved = this.resolveTemplate(templateName, root, templateDirs);
        deps.push({
          type,
          templateName,
          absolutePath: resolved?.absolutePath,
        });
      }
    }

    return deps;
  }

  /**
   * Build a map from "ControllerClass::method" to the Twig templates it renders.
   * Detects annotations, PHP 8 attributes, render calls, and EC-CUBE patterns.
   */
  private buildControllerToTemplateMap(): Map<string, TemplateRef[]> {
    const root = this.runner.projectRoot;
    if (!root) {
      return new Map();
    }

    const templateDirs = this.getTemplateDirs(root);
    const map = new Map<string, TemplateRef[]>();

    for (const dir of this.getControllerDirs(root)) {
      this.scanControllerDir(path.join(root, dir), root, templateDirs, map);
    }

    return map;
  }

  /** List controller directories to scan, including EC-CUBE plugin controllers. */
  private getControllerDirs(root: string): string[] {
    const dirs = [
      "src/Controller",
      "src/Eccube/Controller",
      "app/Customize/Controller",
    ];

    try {
      for (const p of fs.readdirSync(path.join(root, "app/Plugin"), { withFileTypes: true })) {
        if (p.isDirectory()) {
          dirs.push(`app/Plugin/${p.name}/Controller`);
        }
      }
    } catch { /* no plugins dir */ }

    return dirs;
  }

  /** Resolve and cache existing template directories from well-known candidates. */
  private getTemplateDirs(root: string): string[] {
    if (this.templateDirsCache) {
      return this.templateDirsCache;
    }
    this.templateDirsCache = this.resolveTemplateDirs(root);
    return this.templateDirsCache;
  }

  /** Resolve existing template directories from well-known candidates. */
  private resolveTemplateDirs(root: string): string[] {
    const candidates = [
      "app/template",
      "templates",
      "src/Eccube/Resource/template",
    ];

    return candidates
      .map((d) => path.join(root, d))
      .filter((d) => {
        try { return fs.statSync(d).isDirectory(); } catch { return false; }
      });
  }

  /** Recursively scan a controller directory for PHP files. */
  private scanControllerDir(
    dir: string,
    root: string,
    templateDirs: string[],
    map: Map<string, TemplateRef[]>
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.scanControllerDir(full, root, templateDirs, map);
      } else if (entry.name.endsWith(".php")) {
        this.parseControllerFile(full, root, templateDirs, map);
      }
    }
  }

  /**
   * Parse a PHP controller file to discover template references.
   * Handles:
   *   - @Template("...") docblock annotations
   *   - #[Template('...')] PHP 8 attributes
   *   - $this->render/renderView/renderForm/renderResponse("...")
   *   - $app['twig']->render("...") (EC-CUBE legacy)
   */
  private parseControllerFile(
    filePath: string,
    root: string,
    templateDirs: string[],
    map: Map<string, TemplateRef[]>
  ): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) {
      return;
    }
    const shortClass = classMatch[1];
    const lines = content.split("\n");

    let pendingTemplates: string[] = [];
    let currentMethod: string | undefined;

    for (const line of lines) {
      // Check for @Template annotation
      const tplMatch = line.match(TEMPLATE_ANNOTATION);
      if (tplMatch) {
        pendingTemplates.push(tplMatch[1]);
        continue;
      }

      // Check for #[Template(...)] PHP 8 attribute
      const attrMatch = line.match(PHP8_TEMPLATE_ATTR);
      if (attrMatch) {
        pendingTemplates.push(attrMatch[1]);
        continue;
      }

      // Method definition — flush any pending template annotations
      const methodMatch = line.match(METHOD_DEF_RE);
      if (methodMatch) {
        currentMethod = methodMatch[1];
        const key = `${shortClass}::${currentMethod}`;
        for (const tpl of pendingTemplates) {
          this.addTemplate(key, tpl, root, templateDirs, map);
        }
        pendingTemplates = [];
        continue;
      }

      if (currentMethod) {
        // $this->render/renderView/renderForm("...")
        const renderMatch = line.match(RENDER_CALL_RE);
        if (renderMatch) {
          this.addTemplate(`${shortClass}::${currentMethod}`, renderMatch[1], root, templateDirs, map);
        }

        // EC-CUBE legacy: $app['twig']->render("...")
        const eccubeMatch = line.match(ECCUBE_TWIG_RENDER);
        if (eccubeMatch) {
          this.addTemplate(`${shortClass}::${currentMethod}`, eccubeMatch[1], root, templateDirs, map);
        }
      }
    }
  }

  /** Add a resolved template reference to the controller map. */
  private addTemplate(
    key: string,
    rawName: string,
    root: string,
    templateDirs: string[],
    map: Map<string, TemplateRef[]>
  ): void {
    const resolved = this.resolveTemplate(rawName, root, templateDirs);
    if (!resolved) {
      return;
    }

    const existing = map.get(key);
    if (existing) {
      if (!existing.some((t) => t.absolutePath === resolved.absolutePath)) {
        existing.push(resolved);
      }
    } else {
      map.set(key, [resolved]);
    }
  }

  /**
   * Resolve a template name to an absolute file path.
   * Handles:
   *   - @admin/... -> admin/...
   *   - @PluginName/... -> app/Plugin/PluginName/Resource/template/...
   *   - default/... and other EC-CUBE subdirectory patterns
   *   - Standard Symfony template names
   */
  private resolveTemplate(rawName: string, root: string, templateDirs: string[]): TemplateRef | undefined {
    let name = rawName.replace(/^@admin\//, "admin/");

    // EC-CUBE plugin template: @PluginName/path/to/template.twig
    const pluginMatch = name.match(/^@(\w+)\/(.*)/);
    if (pluginMatch) {
      const absPath = path.join(root, "app/Plugin", pluginMatch[1], "Resource/template", pluginMatch[2]);
      if (fs.existsSync(absPath)) {
        return { relativePath: pluginMatch[2], absolutePath: absPath };
      }
      return undefined;
    }

    name = name.replace(/^@/, "");

    // Direct match in template directories
    for (const dir of templateDirs) {
      const absPath = path.join(dir, name);
      if (fs.existsSync(absPath)) {
        return { relativePath: name, absolutePath: absPath };
      }
    }

    // EC-CUBE: try under default/ subdirectory
    for (const dir of templateDirs) {
      const absPath = path.join(dir, "default", name);
      if (fs.existsSync(absPath)) {
        return { relativePath: `default/${name}`, absolutePath: absPath };
      }
    }

    return undefined;
  }
}
