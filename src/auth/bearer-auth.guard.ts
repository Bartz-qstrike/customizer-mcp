import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

// Hashing first gives equal-length buffers, which timingSafeEqual requires,
// so tokens of any length compare in constant time.
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// Requires `Authorization: Bearer <MCP_AUTH_TOKEN>`. With no token
// configured it lets everything through and warns once at startup.
@Injectable()
export class BearerAuthGuard implements CanActivate {
  private readonly logger = new Logger(BearerAuthGuard.name);
  private readonly expected: Buffer | null;

  constructor(config: ConfigService) {
    const token = config.get<string>('MCP_AUTH_TOKEN')?.trim();
    this.expected = token ? sha256(token) : null;
    if (!this.expected) {
      this.logger.warn(
        'MCP_AUTH_TOKEN is not set — /mcp accepts unauthenticated requests',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) {
      return true;
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const presented = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (presented && timingSafeEqual(sha256(presented), this.expected)) {
      return true;
    }
    http
      .getResponse<Response>()
      .setHeader('WWW-Authenticate', 'Bearer realm="customizer-mcp"');
    throw new UnauthorizedException({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  }
}
