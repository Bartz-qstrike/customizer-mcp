import { All, Controller, Logger, Req, Res, UseGuards } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { BearerAuthGuard } from '../auth/bearer-auth.guard.js';
import {
  forceJsonContentType,
  PARSE_ERROR,
  PARSE_ERROR_BODY,
  readBody,
  setHeader,
} from './http-request.js';
import { McpService } from './mcp.service.js';

const REQUIRED_ACCEPT = 'application/json, text/event-stream';

// The SDK rejects POSTs whose Accept header doesn't list both
// application/json and text/event-stream (406). Real MCP clients send it;
// Postman, browsers and plain curl don't. Fill it in so those work too.
function acceptJsonAndEventStream(req: Request) {
  const accept = req.headers.accept ?? '';
  if (
    accept.includes('application/json') &&
    accept.includes('text/event-stream')
  ) {
    return;
  }
  setHeader(req, 'accept', REQUIRED_ACCEPT);
}

@Controller('mcp')
@UseGuards(BearerAuthGuard)
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcp: McpService) {}

  // Streamable HTTP, stateless: every request gets its own server + transport.
  @All()
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.method !== 'POST') {
      res
        .status(405)
        .set('Allow', 'POST')
        .json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        });
      return;
    }

    acceptJsonAndEventStream(req);
    forceJsonContentType(req);
    const body = await readBody(req);
    if (body === PARSE_ERROR) {
      res.status(400).json(PARSE_ERROR_BODY);
      return;
    }

    const server = this.mcp.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Reply with plain application/json rather than an SSE stream.
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      this.logger.error(error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }
}
