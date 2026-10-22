import type { Request } from 'express';

// Request helpers shared by the Streamable HTTP (/mcp) and legacy SSE
// (/sse + /messages) transports. Nest's body parser is off (see main.ts).

// The SDK reads rawHeaders, so both views must be updated.
export function setHeader(req: Request, name: string, value: string) {
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

// The SDK rejects bodies not labelled application/json, e.g. Postman's
// "raw → Text" (text/plain) or a missing Content-Type. Relabel them;
// readBody parses the body regardless of its label.
export function forceJsonContentType(req: Request) {
  if (!req.is('application/json')) {
    setHeader(req, 'content-type', 'application/json');
  }
}

// An empty body (or {}) is answered as tools/list, so the endpoint can be
// hit with a bare POST to see what it offers.
const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
export const PARSE_ERROR = Symbol('parse error');

export const PARSE_ERROR_BODY = {
  jsonrpc: '2.0',
  error: { code: -32700, message: 'Parse error: Invalid JSON' },
  id: null,
};

export async function readBody(req: Request): Promise<unknown> {
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
