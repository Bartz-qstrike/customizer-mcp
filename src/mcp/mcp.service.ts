import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { StyleToolsService } from '../styles/style-tools.service.js';
import { ReadOnlySqlService } from './read-only-sql.service.js';
import { guarded, text } from './tool-result.js';

const READ_ONLY_SQL = /^\s*(select|show|describe|desc|explain|with)\b/i;
const MAX_ROWS = 500;

// Sent to clients in `initialize`; Claude adds it to the model's context.
const SERVER_INSTRUCTIONS =
  'When showing brand style search results, list each style only as "brand style id - brand style name - front thumbnail", exactly as search_brand_styles returns them. Do not add other data or fetch details with other tools unless the user asks. If a tool answers \'We are not able to process this request.\', relay that message and do not look for the data any other way.';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  // list_tables/describe_table/query give direct DB access, so they're only
  // registered for debugging; clients otherwise can't bypass the style tools.
  private readonly rawSqlTools: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sql: ReadOnlySqlService,
    private readonly styleTools: StyleToolsService,
    config: ConfigService,
  ) {
    this.rawSqlTools = config.get<string>('ENABLE_RAW_SQL_TOOLS') === 'true';
  }

  // A fresh server per request keeps the HTTP transport stateless.
  createServer(): McpServer {
    const server = new McpServer(
      { name: 'customizer-mcp', version: '0.0.1' },
      { instructions: SERVER_INSTRUCTIONS },
    );

    this.styleTools.register(server);
    if (this.rawSqlTools) {
      this.registerRawSqlTools(server);
    }
    return server;
  }

  private registerRawSqlTools(server: McpServer) {
    server.registerTool(
      'list_tables',
      {
        title: 'List tables',
        description:
          'List tables in the QX7 database with approximate row counts.',
        inputSchema: {
          filter: z
            .string()
            .optional()
            .describe('Optional substring to match table names'),
        },
      },
      guarded(this.logger, 'list_tables', async ({ filter }) => {
        const rows = await this.prisma.$queryRaw<
          { table_name: string; table_rows: bigint | null }[]
        >`
          SELECT TABLE_NAME AS table_name, TABLE_ROWS AS table_rows
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME LIKE ${`%${filter ?? ''}%`}
          ORDER BY TABLE_NAME`;
        return text(rows);
      }),
    );

    server.registerTool(
      'describe_table',
      {
        title: 'Describe table',
        description: 'Show columns, types, nullability and keys for a table.',
        inputSchema: { table: z.string().describe('Table name') },
      },
      guarded(this.logger, 'describe_table', async ({ table }) => {
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
      }),
    );

    server.registerTool(
      'query',
      {
        title: 'Run read-only SQL',
        description: `Run a single read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) against QX7. Returns at most ${MAX_ROWS} rows.`,
        inputSchema: { sql: z.string().describe('The SQL statement') },
        annotations: { readOnlyHint: true },
      },
      guarded(this.logger, 'query', async ({ sql }) => {
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
      }),
    );
  }
}
