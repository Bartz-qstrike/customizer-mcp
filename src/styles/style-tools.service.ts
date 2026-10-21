import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import {
  advertised,
  guarded,
  INVALID_INPUT,
  plainText,
  text,
  unableToProcess,
} from '../mcp/tool-result.js';
import { PrismaService } from '../prisma/prisma.service.js';

const TOP_N = 5;

// Case-insensitive substring pattern with LIKE wildcards in the input escaped.
function contains(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

// Matches a whole `"default_color": "<name>"` entry, case-insensitively.
function colorElement(value: string): string {
  return `%"${value.toLowerCase().replace(/[\\%_"]/g, '\\$&')}"%`;
}

interface BrandStyleMatch {
  id: bigint;
  brand_style_name: string | null;
  front_thumbnail: string | null;
}

function formatMatch(style: BrandStyleMatch): string {
  const name = style.brand_style_name?.trim() || '(no name)';
  const thumbnail = style.front_thumbnail?.trim() || '(no thumbnail)';
  return `${style.id} - ${name} - ${thumbnail}`;
}

const BRAND_NOTE = " Results are limited to the server's configured brand.";
const FAILURE_NOTE =
  " If the tool returns 'We are not able to process this request.', tell the user exactly that; do not retry with other tools or query the database.";

// Optional text filter; invalid values (wrong type, empty) become INVALID_INPUT.
function textFilter(description: string) {
  return z
    .string()
    .min(1)
    .optional()
    .catch(INVALID_INPUT)
    .meta(advertised(description));
}

// MCP tools for brand styles. McpService calls register() on each new server.
// BRAND_ID limits both tools to one brand (master_brands.id); empty = all.
@Injectable()
export class StyleToolsService {
  private readonly logger = new Logger(StyleToolsService.name);
  private readonly brandId: number | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const raw = config.get<string>('BRAND_ID')?.trim();
    if (!raw) {
      this.brandId = null;
      this.logger.warn(
        'BRAND_ID is not set — brand style tools search all brands',
      );
    } else if (/^[1-9]\d*$/.test(raw)) {
      this.brandId = Number(raw);
    } else {
      throw new Error('BRAND_ID must be a positive integer');
    }
  }

  register(server: McpServer) {
    server.registerTool(
      'get_brand_style',
      {
        title: 'Get brand style',
        description:
          "Fetch one brand style (brand_styles) by its primary id, including its brand item codes, QStrike item ids and sizes. Soft-deleted styles are treated as not found. Only use this when the user explicitly asks for a specific style's full details; don't use it to expand search_brand_styles results." +
          BRAND_NOTE +
          FAILURE_NOTE,
        inputSchema: {
          // Invalid or missing ids become NaN (see INVALID_INPUT).
          id: z
            .number()
            .int()
            .positive()
            .catch(NaN)
            .meta(advertised('brand_styles.id')),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(this.logger, 'get_brand_style', async ({ id }) => {
        if (Number.isNaN(id)) return unableToProcess();
        const style = await this.prisma.brand_styles.findFirst({
          where: {
            id: BigInt(id),
            deleted_at: null,
            ...(this.brandId !== null && { brand_id: this.brandId }),
          },
          include: {
            brand_style_qstrike_item_id_and_sizes: {
              where: { deleted_at: null },
            },
          },
        });
        return style ? text(style) : unableToProcess();
      }),
    );

    server.registerTool(
      'search_brand_styles',
      {
        title: 'Search brand styles',
        description: `Find brand styles by sport, uniform type, color and/or block name. Filters are optional but at least one is required; they combine with AND. Text filters are case-insensitive partial matches, except color, which must equal a default color name (e.g. "Black"). Returns the ${TOP_N} most relevant matches, one per line, as "id - style_name - front thumbnail": exact name matches rank first, then customizer-ready styles, then the most recently updated. Soft-deleted rows are excluded. Show the user the returned lines exactly as given, one per line, in the format "brand style id - brand style name - front thumbnail". Do not add other fields, summaries or extra details, and do not call other tools to enrich the results unless the user explicitly asks for more.${BRAND_NOTE}${FAILURE_NOTE}`,
        inputSchema: {
          sport: textFilter(
            'Sport name, matched against master_sports.sport_name',
          ),
          uniform_type: textFilter(
            'Uniform type, matched against the style category name',
          ),
          color: textFilter(
            'Default color name in body_part_color_groups or body_part_group_default_colors',
          ),
          block_name: textFilter(
            'Block name, matched against the block product name or block pattern name',
          ),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(this.logger, 'search_brand_styles', async (args) => {
        const { sport, uniform_type, color, block_name } = args;
        const values = [sport, uniform_type, color, block_name];
        if (values.includes(INVALID_INPUT) || values.every((v) => !v)) {
          return unableToProcess();
        }

        // Each filter is a parameterized fragment; unset filters add nothing.
        // Ranking: +2 per filter matched by exact name (not just a substring),
        // +1 each for customizer-available and complete styles.
        const filters: Prisma.Sql[] = [Prisma.sql`bs.deleted_at IS NULL`];
        if (this.brandId !== null) {
          filters.push(Prisma.sql`bs.brand_id = ${this.brandId}`);
        }
        const score: Prisma.Sql[] = [
          Prisma.sql`(bs.customizer_available = 1)`,
          Prisma.sql`(COALESCE(bs.complete, 0) > 0)`,
        ];

        // The view is JSON_TABLE over brand_styles and can't be indexed, so
        // sport and uniform type are resolved in one grouped pass over it
        // (match + exact-match flags per style) instead of one per condition.
        const viewColumns: Prisma.Sql[] = [];
        const viewHaving: Prisma.Sql[] = [];
        if (sport) {
          viewColumns.push(
            Prisma.sql`MAX(ms.sport_name LIKE ${contains(sport)}) AS sport_hit`,
            Prisma.sql`MAX(ms.sport_name = ${sport}) AS sport_exact`,
          );
          viewHaving.push(Prisma.sql`sport_hit = 1`);
          score.push(Prisma.sql`2 * IFNULL(vm.sport_exact, 0)`);
        }
        if (uniform_type) {
          viewColumns.push(
            Prisma.sql`MAX(v.style_category_name LIKE ${contains(uniform_type)}) AS uniform_hit`,
            Prisma.sql`MAX(v.style_category_name = ${uniform_type}) AS uniform_exact`,
          );
          viewHaving.push(Prisma.sql`uniform_hit = 1`);
          score.push(Prisma.sql`2 * IFNULL(vm.uniform_exact, 0)`);
        }
        const viewJoin = viewColumns.length
          ? Prisma.sql`JOIN (
              SELECT v.id, ${Prisma.join(viewColumns, ', ')}
              FROM brand_style_sport_product_info_view v
              LEFT JOIN master_sports ms
                ON ms.id = v.sport AND ms.deleted_at IS NULL
              GROUP BY v.id
              HAVING ${Prisma.join(viewHaving, ' AND ')}
            ) vm ON vm.id = bs.id`
          : Prisma.empty;
        if (color) {
          const pattern = colorElement(color);
          filters.push(Prisma.sql`(
            LOWER(JSON_EXTRACT(bs.body_part_color_groups, '$[*].default_color')) LIKE ${pattern}
            OR LOWER(JSON_EXTRACT(bs.body_part_group_default_colors, '$[*].default_color')) LIKE ${pattern})`);
        }
        if (block_name) {
          const pattern = contains(block_name);
          filters.push(Prisma.sql`(
            bpbr.product_name LIKE ${pattern}
            OR bpr.block_pattern_name LIKE ${pattern})`);
          // IFNULL: either block may be missing, and NULL would void the sum.
          score.push(Prisma.sql`2 * IFNULL(
            bpbr.product_name = ${block_name}
            OR bpr.block_pattern_name = ${block_name}, 0)`);
        }

        const rows = await this.prisma.$queryRaw<BrandStyleMatch[]>`
          SELECT bs.id, bs.brand_style_name, bs.front_thumbnail
          FROM brand_styles bs
          ${viewJoin}
          LEFT JOIN block_pattern_brand_rules bpbr
            ON bpbr.id = bs.brand_block_id AND bpbr.deleted_at IS NULL
          LEFT JOIN block_pattern_rules bpr
            ON bpr.id = bpbr.block_pattern_rule_id AND bpr.deleted_at IS NULL
          WHERE ${Prisma.join(filters, ' AND ')}
          ORDER BY (${Prisma.join(score, ' + ')}) DESC,
                   bs.updated_at DESC, bs.id DESC
          LIMIT ${TOP_N}`;

        return rows.length
          ? plainText(rows.map(formatMatch).join('\n'))
          : unableToProcess();
      }),
    );
  }
}
