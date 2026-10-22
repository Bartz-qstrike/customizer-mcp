import type { Logger } from '@nestjs/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// The only failure text clients ever see; details stay in the server log.
export const UNABLE_TO_PROCESS = 'We are not able to process this request.';

// Invalid tool input is mapped to this value with zod's `.catch()`, so the
// handler can answer UNABLE_TO_PROCESS instead of the SDK's validation error
// (which would echo zod's message). `.catch()` doesn't change the JSON Schema
// advertised in tools/list.
export const INVALID_INPUT = '\u0000invalid';

// JSON Schema metadata for a `.catch()` field: zod would otherwise advertise
// the catch value as `default`; `undefined` drops it when serialized.
export function advertised(description: string) {
  return { description, default: undefined };
}

export function unableToProcess(): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: UNABLE_TO_PROCESS }],
  };
}

// Wraps a tool handler: any thrown error is logged and answered generically.
export function guarded<A>(
  logger: Logger,
  tool: string,
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      logger.error(
        `${tool} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      return unableToProcess();
    }
  };
}

// BigInt/Decimal/Date/Buffer values from the driver are not JSON-safe.
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object' && 'type' in v && v.type === 'Buffer') {
        return '<binary>';
      }
      return v;
    },
    2,
  );
}

export function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: toJson(value) }] };
}

export function plainText(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}
