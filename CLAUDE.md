# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NestJS MCP server (Streamable HTTP, `POST /mcp`) exposing read-only tools over the QX7 MySQL database.

## Commands
- Run `npm run prisma:generate` before `build`/`start*` on a fresh checkout — the client is generated into `src/generated/prisma` (gitignored) and the build fails without it. Every Prisma CLI command needs `DATABASE_NAME` set (`prisma.config.ts` → `src/database.config.ts`).
- `npm run prisma:pull` overwrites `prisma/schema.prisma` from the live DB; regenerate afterwards. There are no migrations — never run `prisma migrate`/`db push`.
- Lint is **oxlint** (`npm run lint`), not ESLint; `typescript/no-floating-promises` is an error, so fire-and-forget promises need `void`.
- Tests are **Vitest**, not Jest. There are no unit specs (`npm test` finds nothing); the only test is `npm run test:e2e`, which needs a reachable DB.
- Verify changes with `/verify-mcp`: always `docker compose down --rmi local` before `npm run docker:up` so the old containers and image are removed before rebuilding. Disk space on this machine is tight — if a build fails with "no space left on device", stop and tell the user rather than deleting Docker data.

## Code conventions
- ESM (`"type": "module"`, `nodenext`): relative imports must end in `.js`, including SDK subpaths (`@modelcontextprotocol/sdk/server/mcp.js`).
- Build with `nest build` (uses `tsconfig.build.json`); plain `tsc` emits to the wrong place.

## Architecture gotchas
- **Clients only get the brand style tools by default.** `list_tables`, `describe_table` and `query` are registered only when `ENABLE_RAW_SQL_TOOLS=true`, which is for debugging; `McpService.registerRawSqlTools`.
- **Tool failures return only `UNABLE_TO_PROCESS`** (`src/mcp/tool-result.ts`), never error details: wrap handlers in `guarded()`, which logs the real error on the server.
  - Invalid input is mapped with zod `.catch(INVALID_INPUT)`, or `.catch(NaN)` for numbers, so the handler can answer generically. A plain zod failure would return the SDK's own validation message.
  - Pair every `.catch()` with `.meta(advertised(description))`. Otherwise zod advertises the sentinel as the field's JSON Schema `default`.
  - Not found and no results also return `UNABLE_TO_PROCESS`.
- **SQL safety is enforced only in the app — the DB user can write.** The `query` tool's regex guard in `src/mcp/mcp.service.ts` plus `START TRANSACTION READ ONLY`/`ROLLBACK` in `src/mcp/read-only-sql.service.ts` are the only protection. Never add a code path that runs user-supplied SQL outside that guard.
- Domain tool groups live in their own folder, not `src/mcp/`. Example: `src/styles/`, where `StyleToolsService.register(server)` is exported by `StylesModule`. Import the module into `McpModule` and call `register(server)` from `McpService.createServer()`. Shared result helpers (`text`, `toolError`) are in `src/mcp/tool-result.ts`.
- Brand style lookups use these join paths (`search_brand_styles`):
  - Style name: `brand_styles.brand_style_name` (partial match; exact names rank first).
  - Sport: `master_sports.id` = `brand_style_sport_product_info_view.sport`, and the view's `id` = `brand_styles.id`.
  - Uniform type: the view's `style_category_name`.
  - Color: `default_color` names inside `brand_styles.body_part_color_groups` / `body_part_group_default_colors` (JSON arrays).
  - Block: `brand_styles.brand_block_id` → `block_pattern_brand_rules.product_name`, then `.block_pattern_rule_id` → `block_pattern_rules.block_pattern_name`.
  - Gender: `block_pattern_rules.spec_sheet_id` → `spec_sheet_list.gender_id` (a JSON array of `master_genders.id` strings) → `master_genders`. See `GENDER_CONDITIONS`:
    - `youth` / `adult` match on `gender_category`.
    - The specific values also match their category's unisex row.
    - Don't alias `spec_sheet_list` as `ssl`; it's a reserved word.
- Both style tools filter on `BRAND_ID`, read once in the `StyleToolsService` constructor:
  - Empty → all brands, plus a startup warning.
  - Not a positive integer → startup error.
  - The raw `query` tool is **not** brand-filtered.
- `search_brand_styles` output is deliberately just `id - name - front thumbnail` lines. The rule that clients shouldn't add other data lives in its tool description and in `SERVER_INSTRUCTIONS` (`src/mcp/mcp.service.ts`); keep the two in sync.
- DB access is mostly raw SQL (`$queryRaw` / `ReadOnlySqlService`). Fixed lookups like `get_brand_style` use the typed Prisma models (`this.prisma.<table>`). Prisma doesn't filter soft deletes, so add `deleted_at: null` yourself.
- `src/main.ts` disables Nest's body parser. `src/mcp/mcp.controller.ts` reads the raw body itself, rewrites `Accept`/`Content-Type` (in both `req.headers` and `rawHeaders`) so Postman/curl work, and treats an empty body or `{}` as `tools/list`. Any new controller that needs a request body must parse it itself.
- `/mcp` is protected by `BearerAuthGuard` (`src/auth/bearer-auth.guard.ts`, applied with `@UseGuards` on `McpController`) against `MCP_AUTH_TOKEN`. If that is unset, it allows all requests and warns at startup. `/health` is intentionally public. Guards run before the handler, so an unauthenticated `GET /mcp` returns 401, not 405.
- There are two transports, sharing the tools (`McpService.createServer()`), the bearer auth and the body helpers (`src/mcp/http-request.ts`):
  - **Streamable HTTP**, `src/mcp/mcp.controller.ts`, at `POST /mcp`. Stateless: a new server per request, with `enableJsonResponse: true`. GET `/mcp` returns 405 by design.
  - **Legacy HTTP+SSE**, `src/mcp/sse.controller.ts`. `GET /sse` opens a stream (with a 25 s heartbeat) and announces `POST /messages?sessionId=…`; that POST returns 202, and the reply goes out on the stream. Sessions live in an in-memory map, so run one instance (no load balancing without sticky sessions). The SDK marks `SSEServerTransport` deprecated.
- In Docker, MySQL runs on the host: compose overrides `DATABASE_HOST` to `host.docker.internal`. The container always listens on 3000; `PORT` only changes the host port.
