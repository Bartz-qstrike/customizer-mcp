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
- **SQL safety is enforced only in the app — the DB user can write.** The `query` tool's regex guard in `src/mcp/mcp.service.ts` plus `START TRANSACTION READ ONLY`/`ROLLBACK` in `src/mcp/read-only-sql.service.ts` are the only protection. Never add a code path that runs user-supplied SQL outside that guard.
- All DB access is raw SQL (`$queryRaw` / `ReadOnlySqlService`); the generated Prisma models are unused.
- `src/main.ts` disables Nest's body parser. `src/mcp/mcp.controller.ts` reads the raw body itself, rewrites `Accept`/`Content-Type` (in both `req.headers` and `rawHeaders`) so Postman/curl work, and treats an empty body or `{}` as `tools/list`. Any new controller that needs a request body must parse it itself.
- `/mcp` is protected by `BearerAuthGuard` (`src/auth/bearer-auth.guard.ts`, applied with `@UseGuards` on `McpController`) against `MCP_AUTH_TOKEN`. If that is unset, it allows all requests and warns at startup. `/health` is intentionally public. Guards run before the handler, so an unauthenticated `GET /mcp` returns 401, not 405.
- The MCP transport is stateless (new server per request, `enableJsonResponse: true`); GET `/mcp` returns 405 by design.
- In Docker, MySQL runs on the host: compose overrides `DATABASE_HOST` to `host.docker.internal`. The container always listens on 3000; `PORT` only changes the host port.
