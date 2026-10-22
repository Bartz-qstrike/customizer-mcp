#!/usr/bin/env node
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppModule } from './app.module.js';
import { McpService } from './mcp/mcp.service.js';

// stdio entry point (the `style-mcp` bin). Claude Desktop launches it as a
// local process and speaks MCP over stdin/stdout, so stdout must carry only
// JSON-RPC: every log line goes to stderr instead.
class StderrLogger extends ConsoleLogger {
  protected printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    _writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    params?: Record<string, any>,
  ): void {
    super.printMessages(
      messages,
      context,
      logLevel,
      'stderr',
      errorStack,
      params,
    );
  }
}

// An application context starts the modules (DB pools, config, tools)
// without an HTTP server; the tools are the same ones /mcp and /sse serve.
const app = await NestFactory.createApplicationContext(AppModule, {
  logger: new StderrLogger(),
});
const server = app.get(McpService).createServer();
const transport = new StdioServerTransport();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
  await app.close();
  process.exit(0);
}
// Claude Desktop closes stdin (or signals) when it stops the server. The SDK
// transport doesn't watch for stdin ending, so do it here.
transport.onclose = () => void shutdown();
process.stdin.on('end', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await server.connect(transport);
