import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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

export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
