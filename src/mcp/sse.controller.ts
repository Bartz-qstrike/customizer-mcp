import {
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Request, Response } from 'express';
import { BearerAuthGuard } from '../auth/bearer-auth.guard.js';
import {
  forceJsonContentType,
  PARSE_ERROR,
  PARSE_ERROR_BODY,
  readBody,
} from './http-request.js';
import { McpService } from './mcp.service.js';

// SSE comment lines keep idle streams open through proxies and load balancers.
const HEARTBEAT_MS = 25_000;

// Legacy HTTP+SSE transport (deprecated in the MCP spec, kept for clients that
// only speak SSE). Unlike /mcp it is stateful: GET /sse opens a stream and
// announces POST /messages?sessionId=…; responses are sent on that stream.
// Sessions live in this process's memory, so run a single instance.
@Controller()
@UseGuards(BearerAuthGuard)
export class SseController {
  private readonly logger = new Logger(SseController.name);
  private readonly sessions = new Map<string, SSEServerTransport>();

  constructor(private readonly mcp: McpService) {}

  @Get('sse')
  async open(@Res() res: Response) {
    const transport = new SSEServerTransport('/messages', res);
    const server = this.mcp.createServer();
    const { sessionId } = transport;
    this.sessions.set(sessionId, transport);

    // Stop reverse proxies (e.g. nginx) from buffering the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.sessions.delete(sessionId);
      void server.close();
    });

    try {
      await server.connect(transport);
    } catch (error) {
      this.logger.error(error);
      clearInterval(heartbeat);
      this.sessions.delete(sessionId);
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
  }

  @Post('messages')
  async message(
    @Req() req: Request,
    @Res() res: Response,
    @Query('sessionId') sessionId?: string,
  ) {
    const transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return;
    }

    forceJsonContentType(req);
    const body = await readBody(req);
    if (body === PARSE_ERROR) {
      res.status(400).json(PARSE_ERROR_BODY);
      return;
    }

    // Replies 202 here; the JSON-RPC response goes out on the SSE stream.
    await transport.handlePostMessage(req, res, body);
  }
}
