# customizer-mcp

An MCP (Model Context Protocol) server built with NestJS, Prisma 7, and MySQL (`QX7`). It's served over two MCP transports, with the same tools and auth on both:

| Transport | Endpoint(s) | Notes |
| --- | --- | --- |
| Streamable HTTP (recommended) | `POST /mcp` | Stateless, plain JSON replies |
| HTTP+SSE (legacy) | `GET /sse` opens the stream; the client then POSTs to `/messages?sessionId=…` | For clients that only speak SSE. Responses arrive on the stream, sessions are held in memory, and it's deprecated in the MCP spec |

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
| `search_brand_styles` | Finds brand styles by `style_name`, `sport`, `uniform_type`, `gender` (`men`, `women`, `boys`, `girls`, `youth`, `adult`), `color`, `body_part` and/or `block_name` (combined with AND). `color` matches the default color of `body_part`, or of the **Body** when no body part is given (`Body` or `Body - <fabric>`, not stripes or graphics); returns the single most relevant style as `id - style_name - front thumbnail`, followed by its body parts and their default colors. Filters are never loosened: if no style meets every condition, it says so and returns a `BLANK` style of the requested uniform type (and sport, when one exists; any `BLANK` if no uniform type was given) |
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

To connect over SSE instead, point the client at `/sse` with the same header. For example, in Claude Code:

```bash
claude mcp add --transport sse customizer-sse http://localhost:3000/sse \
  --header "Authorization: Bearer <token>"
```

## Claude Desktop from GitHub (stdio, no Docker)

Claude Desktop can install and run the server straight from this repo. It launches the `style-mcp` command as a local process and talks to it over stdio, so there's no HTTP server and no bearer token. Add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "style-mcp": {
      "command": "npx",
      "args": ["-y", "--package=git+https://github.com/Bartz-qstrike/customizer-mcp", "style-mcp"],
      "env": {
        "DATABASE_HOST": "127.0.0.1",
        "DATABASE_PORT": "3306",
        "DATABASE_USER": "<user>",
        "DATABASE_PASSWORD": "<password>",
        "DATABASE_NAME": "QX7",
        "BRAND_ID": "3"
      }
    }
  }
}
```

- npx installs the repo's **default branch** (`main`). Append `#<branch>` to the URL to use another one.
- **The first launch is slow.** npm clones the repo, installs dependencies, and runs `prepare` (`prisma generate` + `nest build`).
- **npx caches the install,** so later launches are fast. To pick up new commits, clear the cache with `rm -rf ~/.npm/_npx` and restart Claude Desktop.
- If Claude Desktop can't find `npx` (e.g. Node from nvm/Herd), set `"command"` to the full path from `which npx`.
- Logs go to stderr, which Claude Desktop writes to `~/Library/Logs/Claude/mcp-server-style-mcp.log`.

## Schema

`prisma/schema.prisma` was introspected from `QX7`. Run `npm run prisma:pull` to refresh it, then run `npm run prisma:generate`. Prisma skipped five tables that have no primary key: `brand_item_code_master_sizes`, `master_price_item_brand_item_codes`, `team_dealer_user`, `telescope_entries_tags` and `telescope_monitoring`. The raw-SQL tools can still query them.

`GET /health` checks that the database connection works.
