# Symfony Explorer

A VS Code / Cursor extension for browsing **Symfony** and **EC-CUBE** projects from the sidebar.

Quickly navigate routes, entities, and migrations without leaving the editor.

## Features

### Routes

- Lists all routes from `bin/console debug:router`
- Categorises routes into **Admin**, **Front**, and **Other**
- Group routes by URL path depth (1st segment, 2nd segment, etc.)
- Click a route to jump to its controller method
- Shows associated Twig templates per route

### Entities

- Discovers Doctrine entity classes via `doctrine:mapping:info` or filesystem scanning
- Displays ORM-mapped properties with types and nullability
- Shows table names when available
- Click to open the entity source file

### Migrations

- Lists migration versions with execution status (migrated / not migrated)
- Generate new migration skeleton files with a single click
- Click to open migration source files

### Twig Template Integration

Each route shows associated Twig templates as child items. Templates are detected from:

- `$this->render()` / `renderView()` / `renderForm()` calls
- `@Template("...")` docblock annotations
- `#[Template('...')]` PHP 8 attributes
- `$app['twig']->render()` (EC-CUBE legacy)

Expanding a template item reveals its **structural dependencies**:

- **extends** — parent layout template
- **include** — included partials
- **embed** — embedded templates
- **use** — trait-like template reuse

### Search

Every view has a **search** button in the title bar. Filter by:

| View | Searchable fields |
|---|---|
| Routes | path, route name, controller |
| Entities | class name, table name, property name |
| Migrations | version, description |

A **clear** button appears when a filter is active.

## EC-CUBE Support

This extension fully supports EC-CUBE (4.x) projects. The following EC-CUBE-specific directories are automatically detected:

| Feature | Directories |
|---|---|
| Entities | `src/Eccube/Entity`, `app/Customize/Entity`, `app/Plugin/*/Entity`, `app/proxy/entity` |
| Controllers | `src/Eccube/Controller`, `app/Customize/Controller`, `app/Plugin/*/Controller` |
| Templates | `app/template`, `src/Eccube/Resource/template`, `app/Plugin/*/Resource/template` |
| Migrations | `app/DoctrineMigrations` |

**Plugin support:** Entity, controller, and template files inside `app/Plugin/*/` are automatically discovered.

### Standard Symfony

Standard Symfony projects are also supported:

| Feature | Directories |
|---|---|
| Entities | `src/Entity` |
| Controllers | `src/Controller` |
| Templates | `templates` |
| Migrations | `migrations`, `src/Migrations` |

Both layouts are auto-detected and can coexist in the same project.

## Requirements

- A Symfony or EC-CUBE project with `composer.json` in the workspace
- **PHP** available locally, **or** a running **Docker Compose** environment

## Docker Support

If PHP is not found locally, the extension will prompt you to use Docker Compose. This is useful for EC-CUBE projects that typically run inside Docker containers.

| Setting | Default | Description |
|---|---|---|
| `symfony-routes.useDocker` | `false` | Run `bin/console` via `docker compose exec` |
| `symfony-routes.dockerService` | `app` | Docker Compose service name |
| `symfony-routes.dockerWorkdir` | `/var/www/html` | Working directory inside the container |

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `symfony-routes.phpPath` | `php` | Path to the PHP executable |
| `symfony-routes.consolePath` | `bin/console` | Path to the Symfony console |
| `symfony-routes.useDocker` | `false` | Run commands via Docker Compose |
| `symfony-routes.dockerService` | `app` | Docker Compose service name |
| `symfony-routes.dockerWorkdir` | `/var/www/html` | Container working directory |
| `symfony-routes.routeGroupDepth` | `0` | Group routes by path depth (0 = off) |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Package as .vsix
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
```

## License

MIT
