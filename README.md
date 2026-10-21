# customizer-mcp

An MCP (Model Context Protocol) server built with NestJS, Prisma 7, and MySQL (`QX7`). It is exposed over Streamable HTTP at `POST /mcp`.

## Configuration

Connection settings are separate variables, not a `DATABASE_URL` (see `.env.example`):

| Variable            | Default     |
| ------------------- | ----------- |
| `DATABASE_HOST`     | `127.0.0.1` |
| `DATABASE_PORT`     | `3306`      |
| `DATABASE_USER`     | `root`      |
| `DATABASE_PASSWORD` | _(empty)_   |
| `DATABASE_NAME`     | required    |
| `PORT`              | `3000`      |
| `MCP_AUTH_TOKEN`    | _(empty)_ — see [Authentication](#authentication) |
| `BRAND_ID`          | _(empty)_ — limits the brand style tools to one `master_brands.id`; empty = all brands (warning at startup) |

- The app connects through `@prisma/adapter-mariadb` using these values directly (`src/prisma/prisma.service.ts`).
- The Prisma CLI gets a connection string that `prisma.config.ts` builds from the same values (`src/database.config.ts`).

## Run locally

```bash
npm install
npm run prisma:generate
npm run start:dev
```

## Run in Docker

```bash
npm run docker:up     # docker compose up -d --build
npm run docker:down
```

The container connects to the MySQL server running on your host through `host.docker.internal`.

## MCP tools

| Tool | Description |
| ---- | ----------- |
| `get_brand_style` | Fetches one brand style by id, with its brand item codes, QStrike item ids and sizes |
| `search_brand_styles` | Finds brand styles by `sport`, `uniform_type`, `color` and/or `block_name` (combined with AND); returns the 5 most relevant as `id - style_name - front thumbnail` |
| `list_tables` | Lists tables with approximate row counts. Debugging only: registered only when `ENABLE_RAW_SQL_TOOLS=true` |
| `describe_table` | Shows a table's columns, types, nullability and keys. Debugging only (`ENABLE_RAW_SQL_TOOLS=true`) |
| `query` | Runs one read-only SQL statement, at most 500 rows. Debugging only (`ENABLE_RAW_SQL_TOOLS=true`) |

- **Brand:** `get_brand_style` and `search_brand_styles` only return styles of the brand in `BRAND_ID`. `query` is not brand-filtered.
- **Failures:** if a tool can't answer (invalid input, nothing found or a database error), it returns only `We are not able to process this request.` The real error is logged on the server, never returned to the client.
- **Raw SQL tools:** with `ENABLE_RAW_SQL_TOOLS` off (the default), clients only see the two brand style tools and can't query the database directly. When it's on, `query` runs inside a `START TRANSACTION READ ONLY` transaction that is always rolled back, so MySQL rejects any write.

## Authentication

`/mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>`. Missing or wrong tokens get `401` with a `WWW-Authenticate: Bearer` header. Generate a token with `openssl rand -hex 32` and put it in `.env`.

If `MCP_AUTH_TOKEN` is empty, `/mcp` accepts unauthenticated requests and the server logs a warning at startup. `GET /health` is always public.

To connect from Claude Code:

```bash
claude mcp add --transport http customizer http://localhost:3000/mcp \
  --header "Authorization: Bearer <token>"
```

To connect from Claude Desktop, add this to `claude_desktop_config.json`. `mcp-remote` bridges Claude Desktop to the HTTP endpoint.

```json
{
  "mcpServers": {
    "customizer-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

In Postman, open the **Authorization** tab, choose **Bearer Token**, and paste the token.

## Schema

`prisma/schema.prisma` was introspected from `QX7`. Run `npm run prisma:pull` to refresh it, then run `npm run prisma:generate`. Prisma skipped five tables that have no primary key: `brand_item_code_master_sizes`, `master_price_item_brand_item_codes`, `team_dealer_user`, `telescope_entries_tags` and `telescope_monitoring`. The raw-SQL tools can still query them.

`GET /health` checks that the database connection works.
