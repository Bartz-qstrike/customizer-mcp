import { All, Controller, Logger, Req, Res } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { McpService } from './mcp.service.js';

const REQUIRED_ACCEPT = 'application/json, text/event-stream';

// The SDK reads rawHeaders, so both views must be updated.
function setHeader(req: Request, name: string, value: string) {
  req.headers[name] = value;
  const raw = req.rawHeaders;
  const i = raw.findIndex(
    (h, idx) => idx % 2 === 0 && h.toLowerCase() === name,
  );
  if (i >= 0) {
    raw[i + 1] = value;
  } else {
    raw.push(name, value);
  }
}

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

// The SDK also rejects bodies not labelled application/json (415), e.g.
// Postman's "raw → Text" (text/plain) or a missing Content-Type. Relabel
// them; readBody parses the body regardless of its label.
function forceJsonContentType(req: Request) {
  if (!req.is('application/json')) {
    setHeader(req, 'content-type', 'application/json');
  }
}

// An empty body (or {}) is answered as tools/list, so the endpoint can be
// hit with a bare POST to see what it offers.
const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const PARSE_ERROR = Symbol('parse error');

// Nest's body parsing is off (see main.ts), so the raw stream is unread.
async function readBody(req: Request): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '' || raw === '{}') {
    return LIST_TOOLS;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return PARSE_ERROR;
  }
}

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcp: McpService) {}

  // Streamable HTTP, stateless: every request gets its own server + transport.
  @All()
  async handle(@Req() req: Request, @Res() res: Response) {
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').json({
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
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: Invalid JSON' },
        id: null,
      });
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
