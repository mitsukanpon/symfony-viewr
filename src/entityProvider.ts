/**
 * Discovers Doctrine entity classes and parses their ORM-annotated properties.
 *
 * Two strategies are used:
 *   1. `doctrine:mapping:info` console command — requires a running Symfony app
 *   2. Direct filesystem scan of well-known entity directories:
 *      src/Entity, src/Eccube/Entity, app/Customize/Entity, app/Plugin/&lt;name&gt;/Entity, etc.
 *
 * Both PHP 8 attributes (`#[ORM\Column(...)]`) and legacy annotations (`@ORM\Column(...)`)
 * are supported.
 */
import * as fs from "fs";
import * as path from "path";
import { SymfonyRunner } from "./symfonyRunner";

export interface EntityProperty {
  name: string;
  type: string;
  nullable: boolean;
}

export interface EntityDefinition {
  className: string;
  shortName: string;
  tableName: string | undefined;
  filePath: string | undefined;
  properties: EntityProperty[];
}

// --- Regex patterns for PHP 8 attributes ---

const PHP8_ATTR_COLUMN = /#\[ORM\\Column\s*\([^)]*type:\s*['"](\w+)['"]/;
const PHP8_ATTR_ID = /#\[ORM\\Id[\](]/;
const PHP8_ATTR_RELATION =
  /#\[ORM\\(ManyToOne|OneToMany|ManyToMany|OneToOne)\s*\([^)]*targetEntity:\s*(\w+)(?:::class)?/;

// --- Regex patterns for legacy docblock annotations ---

const ANNOTATION_COLUMN = /@ORM\\Column\s*\([^)]*type\s*=\s*"(\w+)"/;
const ANNOTATION_ID = /@ORM\\Id/;
const ANNOTATION_RELATION =
  /@ORM\\(ManyToOne|OneToMany|ManyToMany|OneToOne)\s*\([^)]*targetEntity\s*=\s*"([\w\\]+)"/;

const ANNOTATION_TABLE = /@ORM\\Table\s*\(\s*name\s*=\s*"(\w+)"/;
const PHP8_ATTR_TABLE = /#\[ORM\\Table\s*\(\s*name:\s*['"](\w+)['"]/;

const DOCBLOCK_VAR = /@var\s+([\w\\|?]+)/;

/** Matches a property declaration with an explicit type hint. */
const PROP_WITH_TYPE =
  /(?:private|protected|public)\s+(\??)((?!function\b)[\w\\]+(?:\|[\w\\]+)*)\s+\$(\w+)/;
/** Matches a property declaration without a type hint. */
const PROP_WITHOUT_TYPE =
  /(?:private|protected|public)\s+\$(\w+)\s*[;=]/;

/** Any ORM annotation/attribute that marks a property as persistent. */
const ORM_PROPERTY_RE = /(?:@ORM\\|#\[ORM\\)(?:Column|Id|ManyToOne|OneToMany|ManyToMany|OneToOne|GeneratedValue|JoinColumn|OrderBy)/;

export class EntityProvider {
  constructor(private readonly runner: SymfonyRunner) {}

  /**
   * Fetch entity definitions — tries the console command first,
   * falls back to filesystem scanning.
   */
  async fetchEntities(): Promise<EntityDefinition[]> {
    const entities = await this.tryConsoleCommand();
    if (entities && entities.length > 0) {
      return entities;
    }

    return this.scanEntityFiles();
  }

  /** Attempt to discover entities via `doctrine:mapping:info`. */
  private async tryConsoleCommand(): Promise<EntityDefinition[] | undefined> {
    const raw = await this.runner.runConsoleCommand("doctrine:mapping:info --no-interaction", 30000);
    if (!raw) {
      return undefined;
    }

    const classNames = this.parseMappingInfo(raw);
    if (classNames.length === 0) {
      return undefined;
    }

    const psr4Map = await this.runner.getPsr4Map();
    const entities: EntityDefinition[] = [];

    for (const className of classNames) {
      const shortName = className.split("\\").pop() ?? className;
      const filePath = this.runner.resolveClassToFile(className, psr4Map);

      let properties: EntityProperty[] = [];
      let tableName: string | undefined;
      if (filePath) {
        const content = this.readFile(filePath);
        if (content) {
          properties = this.parseEntityContent(content);
          tableName = this.extractTableName(content);
        }
      }

      entities.push({ className, shortName, tableName, filePath, properties });
    }

    return entities.sort((a, b) => a.shortName.localeCompare(b.shortName));
  }

  /**
   * Walk well-known directories for PHP files containing ORM annotations.
   * Covers both standard Symfony and EC-CUBE layouts.
   */
  private scanEntityFiles(): EntityDefinition[] {
    const root = this.runner.projectRoot;
    if (!root) {
      return [];
    }

    const candidateDirs = [
      "src/Eccube/Entity",
      "src/Entity",
      "app/Entity",
      "src/Customize/Entity",
      "app/Customize/Entity",
      "app/proxy/entity",
    ];

    const phpFiles: string[] = [];
    for (const dir of candidateDirs) {
      this.collectPhpFiles(path.join(root, dir), phpFiles);
    }

    this.collectPluginEntityFiles(root, phpFiles);

    const entities: EntityDefinition[] = [];
    for (const filePath of phpFiles) {
      const entity = this.parseEntityFromFile(filePath);
      if (entity) {
        entities.push(entity);
      }
    }

    return entities.sort((a, b) => a.shortName.localeCompare(b.shortName));
  }

  /** Scan EC-CUBE plugin directories for entity files. */
  private collectPluginEntityFiles(root: string, out: string[]): void {
    try {
      for (const plugin of fs.readdirSync(path.join(root, "app/Plugin"), { withFileTypes: true })) {
        if (plugin.isDirectory()) {
          this.collectPhpFiles(path.join(root, "app/Plugin", plugin.name, "Entity"), out);
        }
      }
    } catch { /* no plugins dir */ }
  }

  /** Recursively collect all `.php` files under a directory. */
  private collectPhpFiles(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.collectPhpFiles(full, out);
      } else if (entry.name.endsWith(".php")) {
        out.push(full);
      }
    }
  }

  private readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return undefined;
    }
  }

  /** Parse a PHP file and return an EntityDefinition if it contains ORM mappings. */
  private parseEntityFromFile(filePath: string): EntityDefinition | undefined {
    const content = this.readFile(filePath);
    if (!content || !content.includes("ORM\\")) {
      return undefined;
    }

    const classMatch = content.match(/namespace\s+([\w\\]+)\s*;[\s\S]*?class\s+(\w+)/);
    if (!classMatch) {
      return undefined;
    }

    return {
      className: `${classMatch[1]}\\${classMatch[2]}`,
      shortName: classMatch[2],
      tableName: this.extractTableName(content),
      filePath,
      properties: this.parseEntityContent(content),
    };
  }

  /** Extract the table name from `@ORM\Table` or `#[ORM\Table]`. */
  private extractTableName(content: string): string | undefined {
    return content.match(ANNOTATION_TABLE)?.[1] ?? content.match(PHP8_ATTR_TABLE)?.[1];
  }

  /** Parse the output of `doctrine:mapping:info` to extract FQCN class names. */
  private parseMappingInfo(raw: string): string[] {
    const classNames: string[] = [];
    for (const line of raw.split("\n")) {
      const okMatch = line.match(/\[OK\]\s+(.+)/);
      if (okMatch) {
        classNames.push(okMatch[1].trim());
        continue;
      }

      const fqcnMatch = line.match(/^\s+([\w\\]+\\Entity\\[\w\\]+)\s*$/);
      if (fqcnMatch) {
        classNames.push(fqcnMatch[1].trim());
      }
    }
    return classNames;
  }

  /** Parse ORM-annotated properties from a PHP class body. */
  private parseEntityContent(content: string): EntityProperty[] {
    const properties: EntityProperty[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const typedMatch = line.match(PROP_WITH_TYPE);
      if (typedMatch) {
        const context = this.getContext(lines, i);
        if (!ORM_PROPERTY_RE.test(context)) {
          continue;
        }

        properties.push({
          name: typedMatch[3],
          type: this.resolveType(context, typedMatch[2]),
          nullable: typedMatch[1] === "?",
        });
        continue;
      }

      const untypedMatch = line.match(PROP_WITHOUT_TYPE);
      if (untypedMatch) {
        const context = this.getContext(lines, i);
        if (!ORM_PROPERTY_RE.test(context)) {
          continue;
        }

        const docType = this.extractDocBlockType(context);
        properties.push({
          name: untypedMatch[1],
          type: this.resolveType(context, docType),
          nullable: context.includes("nullable=true") || context.includes("nullable: true") || docType.startsWith("?"),
        });
      }
    }

    return properties;
  }

  /**
   * Collect the lines above a property declaration (up to 15 lines) that
   * contain annotations/attributes relevant to that property.
   */
  private getContext(lines: string[], lineIndex: number): string {
    let start = lineIndex;
    for (let j = lineIndex - 1; j >= Math.max(0, lineIndex - 15); j--) {
      const trimmed = lines[j].trim();
      start = j;
      if (trimmed === "" || trimmed.startsWith("private") || trimmed.startsWith("protected") || trimmed.startsWith("public")) {
        start = j + 1;
        break;
      }
    }
    return lines.slice(start, lineIndex + 1).join("\n");
  }

  /** Extract a type hint from a `@var` docblock tag. */
  private extractDocBlockType(context: string): string {
    const match = context.match(DOCBLOCK_VAR);
    if (match) {
      return match[1].replace(/^\\/, "").replace(/\|null$/, "").replace(/^null\|/, "");
    }
    return "mixed";
  }

  /**
   * Determine the effective column type for a property by inspecting
   * annotations/attributes in priority order: Id > Relation > Column > fallback.
   */
  private resolveType(context: string, fallbackType: string): string {
    if (ANNOTATION_ID.test(context) || PHP8_ATTR_ID.test(context)) {
      const colType = context.match(ANNOTATION_COLUMN) ?? context.match(PHP8_ATTR_COLUMN);
      return colType ? colType[1] : "id";
    }

    const relationMatch = context.match(ANNOTATION_RELATION) ?? context.match(PHP8_ATTR_RELATION);
    if (relationMatch) {
      const target = relationMatch[2].split("\\").pop() ?? relationMatch[2];
      return `${relationMatch[1]}(${target})`;
    }

    const colType = context.match(ANNOTATION_COLUMN) ?? context.match(PHP8_ATTR_COLUMN);
    if (colType) {
      return colType[1];
    }

    return fallbackType;
  }
}
