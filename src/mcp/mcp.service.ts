import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReadOnlySqlService } from './read-only-sql.service.js';

const READ_ONLY_SQL = /^\s*(select|show|describe|desc|explain|with)\b/i;
const MAX_ROWS = 500;

// BigInt/Decimal/Date/Buffer values from the driver are not JSON-safe.
function toJson(value: unknown): string {
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

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: toJson(value) }] };
}

@Injectable()
export class McpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sql: ReadOnlySqlService,
  ) {}

  // A fresh server per request keeps the HTTP transport stateless.
  createServer(): McpServer {
    const server = new McpServer({ name: 'customizer-mcp', version: '0.0.1' });

    server.registerTool(
      'list_tables',
      {
        title: 'List tables',
        description: 'List tables in the QX7 database with approximate row counts.',
        inputSchema: {
          filter: z
            .string()
            .optional()
            .describe('Optional substring to match table names'),
        },
      },
      async ({ filter }) => {
        const rows = await this.prisma.$queryRaw<
          { table_name: string; table_rows: bigint | null }[]
        >`
          SELECT TABLE_NAME AS table_name, TABLE_ROWS AS table_rows
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME LIKE ${`%${filter ?? ''}%`}
          ORDER BY TABLE_NAME`;
        return text(rows);
      },
    );

    server.registerTool(
      'describe_table',
      {
        title: 'Describe table',
        description: 'Show columns, types, nullability and keys for a table.',
        inputSchema: { table: z.string().describe('Table name') },
      },
      async ({ table }) => {
        const columns = await this.prisma.$queryRaw`
          SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
                 IS_NULLABLE AS nullable, COLUMN_KEY AS \`key\`,
                 COLUMN_DEFAULT AS \`default\`, EXTRA AS extra
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
          ORDER BY ORDINAL_POSITION`;
        if (Array.isArray(columns) && columns.length === 0) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Table "${table}" not found` }],
          };
        }
        return text(columns);
      },
    );

    server.registerTool(
      'query',
      {
        title: 'Run read-only SQL',
        description: `Run a single read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) against QX7. Returns at most ${MAX_ROWS} rows.`,
        inputSchema: { sql: z.string().describe('The SQL statement') },
        annotations: { readOnlyHint: true },
      },
      async ({ sql }) => {
        const statement = sql.trim().replace(/;\s*$/, '');
        if (!READ_ONLY_SQL.test(statement) || statement.includes(';')) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Only a single SELECT/SHOW/DESCRIBE/EXPLAIN/WITH statement is allowed.',
              },
            ],
          };
        }
        const rows = await this.sql.query(statement);
        return text({
          rowCount: rows.length,
          truncated: rows.length > MAX_ROWS,
          rows: rows.slice(0, MAX_ROWS),
        });
      },
    );

    return server;
  }
}
