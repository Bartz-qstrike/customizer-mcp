import { Injectable } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { text, toolError } from '../mcp/tool-result.js';
import { PrismaService } from '../prisma/prisma.service.js';

// MCP tools for brand styles. McpService calls register() on each new server.
@Injectable()
export class StyleToolsService {
  constructor(private readonly prisma: PrismaService) {}

  register(server: McpServer) {
    server.registerTool(
      'get_brand_style',
      {
        title: 'Get brand style',
        description:
          'Fetch one brand style (brand_styles) by its primary id, including its brand item codes, QStrike item ids and sizes. Soft-deleted styles are treated as not found.',
        inputSchema: {
          id: z.number().int().positive().describe('brand_styles.id'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const style = await this.prisma.brand_styles.findFirst({
          where: { id: BigInt(id), deleted_at: null },
          include: {
            brand_style_qstrike_item_id_and_sizes: {
              where: { deleted_at: null },
            },
          },
        });
        return style ? text(style) : toolError(`Brand style ${id} not found`);
      },
    );
  }
}
