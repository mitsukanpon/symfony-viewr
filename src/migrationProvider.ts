/**
 * Discovers Doctrine migration files and their execution status.
 *
 * Supports two console commands:
 *   - `doctrine:migrations:list` (tabular output)
 *   - `doctrine:migrations:status --show-versions` (legacy format)
 *
 * Also provides a helper to generate new migration skeleton files
 * following the project's existing namespace convention.
 */
import * as path from "path";
import * as fs from "fs";
import { SymfonyRunner } from "./symfonyRunner";

export type MigrationStatus = "migrated" | "not-migrated" | "unknown";

export interface MigrationDefinition {
  version: string;
  status: MigrationStatus;
  description: string;
  filePath: string | undefined;
  tables: string[];
}

export class MigrationProvider {
  constructor(private readonly runner: SymfonyRunner) {}

  /**
   * Generate a new migration skeleton file with a timestamped version name.
   * The namespace is auto-detected from existing migration files.
   */
  generateMigration(): string | undefined {
    const root = this.runner.projectRoot;
    if (!root) {
      return undefined;
    }

    const migrationDir = this.findMigrationDir(root);
    if (!migrationDir) {
      return undefined;
    }

    const ns = this.detectNamespace(migrationDir);
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");

    const className = `Version${stamp}`;
    const filePath = path.join(migrationDir, `${className}.php`);

    const content = [
      "<?php",
      "",
      "declare(strict_types=1);",
      "",
      `namespace ${ns};`,
      "",
      "use Doctrine\\DBAL\\Schema\\Schema;",
      "use Doctrine\\Migrations\\AbstractMigration;",
      "",
      "final class " + className + " extends AbstractMigration",
      "{",
      "    public function up(Schema $schema): void",
      "    {",
      "        // this up() migration is auto-generated, please modify it to your needs",
      "    }",
      "",
      "    public function down(Schema $schema): void",
      "    {",
      "        // this down() migration is auto-generated, please modify it to your needs",
      "    }",
      "}",
      "",
    ].join("\n");

    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /**
   * Locate the migration directory by checking well-known paths.
   * Supports both EC-CUBE (`app/DoctrineMigrations`) and standard Symfony (`migrations`).
   */
  private findMigrationDir(root: string): string | undefined {
    const candidateDirs = [
      "app/DoctrineMigrations",
      "migrations",
      "src/Migrations",
      "src/DoctrineMigrations",
    ];
    for (const dir of candidateDirs) {
      const fullPath = path.join(root, dir);
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          return fullPath;
        }
      } catch { /* not found */ }
    }
    return undefined;
  }

  /** Infer the PHP namespace from existing migration files in the directory. */
  private detectNamespace(migrationDir: string): string {
    try {
      const files = fs.readdirSync(migrationDir).filter((f) => f.endsWith(".php"));
      for (const file of files) {
        const content = fs.readFileSync(path.join(migrationDir, file), "utf-8");
        const nsMatch = content.match(/^namespace\s+([\w\\]+)\s*;/m);
        if (nsMatch) {
          return nsMatch[1];
        }
      }
    } catch { /* ignore */ }
    return "DoctrineMigrations";
  }

  /** Fetch migration list and resolve file paths. Sorted newest-first. */
  async fetchMigrations(): Promise<MigrationDefinition[]> {
    const migrations = (await this.tryMigrationsList()) ?? (await this.tryMigrationsStatus());
    if (!migrations) {
      return [];
    }

    this.resolveFilePaths(migrations);
    migrations.sort((a, b) => b.version.localeCompare(a.version));
    return migrations;
  }

  /** Parse the tabular output of `doctrine:migrations:list`. */
  private async tryMigrationsList(): Promise<MigrationDefinition[] | undefined> {
    const raw = await this.runner.runConsoleCommand(
      "doctrine:migrations:list --no-interaction",
      30000
    );
    if (!raw) {
      return undefined;
    }

    const migrations: MigrationDefinition[] = [];

    for (const line of raw.split("\n")) {
      const tableMatch = line.match(
        /\|\s*([\w\\]+Version\w+)\s*\|\s*(migrated|not migrated)\s*\|\s*(.*?)\s*\|/i
      );
      if (tableMatch) {
        migrations.push({
          version: this.extractVersionName(tableMatch[1]),
          status: tableMatch[2].toLowerCase().includes("not") ? "not-migrated" : "migrated",
          description: tableMatch[3].trim(),
          filePath: undefined,
          tables: [],
        });
        continue;
      }

      const plainMatch = line.match(
        /(Version\d{14})\s.*?(migrated|not migrated)/i
      );
      if (plainMatch) {
        migrations.push({
          version: plainMatch[1],
          status: plainMatch[2].toLowerCase().includes("not") ? "not-migrated" : "migrated",
          description: "",
          filePath: undefined,
          tables: [],
        });
      }
    }

    return migrations.length > 0 ? migrations : undefined;
  }

  /** Parse the legacy `doctrine:migrations:status --show-versions` output. */
  private async tryMigrationsStatus(): Promise<MigrationDefinition[] | undefined> {
    const raw = await this.runner.runConsoleCommand(
      "doctrine:migrations:status --show-versions --no-interaction",
      30000
    );
    if (!raw) {
      return undefined;
    }

    const migrations: MigrationDefinition[] = [];

    for (const line of raw.split("\n")) {
      const match = line.match(
        />>\s+[\d-]+\s[\d:]+\s+\(([^)]+)\)\s+(not migrated|migrated)\s*(.*)/i
      );
      if (match) {
        migrations.push({
          version: this.extractVersionName(match[1]),
          status: match[2].toLowerCase().includes("not") ? "not-migrated" : "migrated",
          description: match[3].trim(),
          filePath: undefined,
          tables: [],
        });
      }
    }

    return migrations.length > 0 ? migrations : undefined;
  }

  /** Extract description and table names from a migration PHP file. */
  private extractFileDetails(filePath: string): { description: string; tables: string[] } {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return { description: "", tables: [] };
    }

    const descMatch = content.match(
      /function\s+getDescription\s*\(\)[^{]*\{[^}]*return\s+['"]([^'"]*)['"]\s*;/s
    );
    const description = descMatch?.[1] ?? "";

    const tables = new Set<string>();

    const sqlPattern = /\$this->addSql\(\s*['"](.+?)['"]\s*[,)]/gs;
    let sqlMatch: RegExpExecArray | null;
    while ((sqlMatch = sqlPattern.exec(content)) !== null) {
      const sql = sqlMatch[1];
      const tablePatterns = [
        /(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+[`"']?(\w+)[`"']?/gi,
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"']?(\w+)[`"']?/gi,
        /RENAME\s+TABLE\s+[`"']?(\w+)[`"']?/gi,
        /(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+\S+\s+ON\s+[`"']?(\w+)[`"']?/gi,
      ];
      for (const pattern of tablePatterns) {
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(sql)) !== null) {
          tables.add(m[1]);
        }
      }
    }

    return { description, tables: [...tables] };
  }

  /** Extract the short version name (e.g. `Version20240101120000`) from an FQCN. */
  private extractVersionName(fqcn: string): string {
    return fqcn.split("\\").pop()!;
  }

  /** Match each migration's version name to a PHP file in the migration directory. */
  private resolveFilePaths(migrations: MigrationDefinition[]): void {
    const root = this.runner.projectRoot;
    if (!root) {
      return;
    }

    const migrationDir = this.findMigrationDir(root);
    if (!migrationDir) {
      return;
    }

    let files: string[];
    try {
      files = fs.readdirSync(migrationDir).filter((f) => f.endsWith(".php"));
    } catch {
      return;
    }

    for (const migration of migrations) {
      const matchingFile = files.find((f) => f.includes(migration.version));
      if (matchingFile) {
        migration.filePath = path.join(migrationDir, matchingFile);
        const details = this.extractFileDetails(migration.filePath);
        migration.tables = details.tables;
        if (details.description) {
          migration.description = details.description;
        }
      }
    }
  }
}
