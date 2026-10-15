---
name: verify-mcp
description: Rebuild the Docker container from scratch and smoke-test the MCP endpoint and health check. Use after changing server code, Docker config, or Prisma setup, or when the user asks to verify, rebuild, or rerun Docker.
---

Verify the running server end to end. Run steps in order and stop at the first failure.

1. **Check disk space**: `df -h /System/Volumes/Data`. If under ~3 GB is free, stop and tell the user. Do not prune Docker data yourself.
2. **Remove old containers and image**: `docker compose down --rmi local`. Always do this before building. It removes this project's containers, network and the `customizer-mcp` image, so each rebuild doesn't leave an untagged image behind. Don't use `docker image prune` or `docker system prune`; they affect other projects' images too.
3. **Rebuild and start**: `npm run docker:up` (timeout 600000). If it fails, show the last ~30 lines of output.
4. **Wait** about 5 seconds, then confirm `docker ps --filter name=customizer-mcp` shows it Up on 3000.
5. **Smoke test** against `http://localhost:3000`. Show only the HTTP status and the tail of each body.

   Load the token in the same shell command as the requests, without printing it: `TOKEN=$(grep '^MCP_AUTH_TOKEN=' .env | cut -d= -f2-)`. "Auth" below means `-H "Authorization: Bearer $TOKEN"`. If `TOKEN` is empty, auth is off: say so, and skip rows 7–8.

   | # | Request | Expect |
   |---|---|---|
   | 1 | `GET /health` (no auth) | 200 `{"status":"ok","database":"up"}` |
   | 2 | `POST /mcp` with auth, no body | 200, `result.tools` |
   | 3 | `POST /mcp` with auth, `Content-Type: text/plain` and body `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query","arguments":{"sql":"SELECT 1 AS one"}}}` | 200, rows contain `one` |
   | 4 | `POST /mcp` with auth, `Content-Type: application/json`, `Accept: application/json, text/event-stream` and an `initialize` request (`protocolVersion` `2025-06-18`) | 200, `serverInfo.name` = `customizer-mcp` |
   | 5 | `POST /mcp` with auth and `-d 'not json'` | 400, code `-32700` |
   | 6 | `GET /mcp` with auth | 405 |
   | 7 | `POST /mcp` with no auth header | 401, code `-32001`, `WWW-Authenticate: Bearer` header |
   | 8 | `POST /mcp` with `Authorization: Bearer wrong` | 401 |

   If $ARGUMENTS names a tool or a change, add one request that exercises it.
6. **Report** a pass/fail table. For any failure, include `docker compose logs --tail 50 mcp`.
