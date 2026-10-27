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

// Case-insensitive substring pattern with LIKE wildcards in the input escaped.
function contains(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

// Matches a whole `"default_color": "<name>"` entry, case-insensitively.
function colorElement(value: string): string {
  return `%"${value.toLowerCase().replace(/[\\%_"]/g, '\\$&')}"%`;
}

// Body part a color filter applies to when the caller doesn't name one.
const DEFAULT_BODY_PART = 'Body';

// Rows of one body part JSON column as (part, color); `nameKey` is the field
// holding the part's display name. JSON_TABLE paths must be literals, so the
// column and key are fixed constants, never user input.
function bodyPartRows(
  column: 'body_part_group_default_colors' | 'body_part_color_groups',
  nameKey: 'body_part_group' | 'body_part_group_name',
): Prisma.Sql {
  return Prisma.sql`JSON_TABLE(COALESCE(${Prisma.raw(`bs.${column}`)}, '[]'), '$[*]' COLUMNS(
    part VARCHAR(255) PATH ${Prisma.raw(`'$.${nameKey}'`)},
    color VARCHAR(255) PATH '$.default_color')) p`;
}

// A style has `part` (case-insensitive), optionally in `color`. "Body" matches
// "Body" and fabric variants like "Body - LTX", not "Body Stripe 1" or
// "Front Body".
function hasBodyPart(part: string, color: string | undefined): Prisma.Sql {
  const name = part.toLowerCase();
  const fabricVariant = `${name.replace(/[\\%_]/g, '\\$&')} - %`;
  const conditions = [
    Prisma.sql`(LOWER(TRIM(p.part)) = ${name} OR LOWER(TRIM(p.part)) LIKE ${fabricVariant})`,
  ];
  if (color) {
    conditions.push(
      Prisma.sql`LOWER(TRIM(p.color)) = ${color.toLowerCase()}`,
    );
  }
  const where = Prisma.join(conditions, ' AND ');
  return Prisma.sql`(
    EXISTS (SELECT 1 FROM ${bodyPartRows('body_part_group_default_colors', 'body_part_group')} WHERE ${where})
    OR EXISTS (SELECT 1 FROM ${bodyPartRows('body_part_color_groups', 'body_part_group_name')} WHERE ${where}))`;
}

interface BrandStyleMatch {
  id: bigint;
  brand_style_name: string | null;
  front_thumbnail: string | null;
  body_part_color_groups: unknown;
  body_part_group_default_colors: unknown;
}

type JsonEntry = Record<string, unknown>;
interface BodyPart {
  name: string;
  color: string;
  order: number;
}

// The driver may hand JSON columns back as text or already parsed.
function jsonArray(value: unknown): JsonEntry[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((e): e is JsonEntry => !!e && typeof e === 'object')
    : [];
}

function str(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

// Body parts from both columns, merged by sort_order: the main panels
// (body_part_group_default_colors) and trims/graphics (body_part_color_groups).
function bodyParts(style: BrandStyleMatch): BodyPart[] {
  const toPart = (name: string, e: JsonEntry): BodyPart => ({
    name,
    color: str(e.default_color),
    order: Number(str(e.sort_order)) || Number.MAX_SAFE_INTEGER,
  });
  const panels = jsonArray(style.body_part_group_default_colors).map((e) =>
    toPart(str(e.body_part_group), e),
  );
  const trims = jsonArray(style.body_part_color_groups).map((e) =>
    toPart(
      str(e.body_part_group_name) ||
        (Array.isArray(e.body_parts_name)
          ? e.body_parts_name.map(str).filter(Boolean).join(', ')
          : '') ||
        str(e.body_part_group),
      e,
    ),
  );
  return [...panels, ...trims]
    .filter((p) => p.name)
    .sort((a, b) => a.order - b.order);
}

function formatStyle(style: BrandStyleMatch): string {
  const name = style.brand_style_name?.trim() || '(no name)';
  const thumbnail = style.front_thumbnail?.trim() || '(no thumbnail)';
  const header = `${style.id} - ${name} - ${thumbnail}`;
  const parts = bodyParts(style);
  if (!parts.length) {
    return `${header}\nBody parts: none`;
  }
  const lines = parts.map(({ name: part, color }) =>
    color && color.toUpperCase() !== 'N/A'
      ? `- ${part}: ${color}`
      : `- ${part}`,
  );
  return [header, 'Body parts:', ...lines].join('\n');
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

// Gender filter values → conditions on master_genders (alias `mg`). Broad
// terms use gender_category; specific ones also take their category's unisex
// row (Men & Women / Boys & Girls). Constants only, no user input in the SQL.
const GENDER_CONDITIONS = {
  men: Prisma.sql`mg.gender = 'Men' OR (mg.unisex = 1 AND mg.gender_category = 'Adult')`,
  women: Prisma.sql`mg.gender = 'Women' OR (mg.unisex = 1 AND mg.gender_category = 'Adult')`,
  boys: Prisma.sql`mg.gender = 'Boys' OR (mg.unisex = 1 AND mg.gender_category = 'Youth')`,
  girls: Prisma.sql`mg.gender = 'Girls' OR (mg.unisex = 1 AND mg.gender_category = 'Youth')`,
  youth: Prisma.sql`mg.gender_category = 'Youth'`,
  adult: Prisma.sql`mg.gender_category = 'Adult'`,
};
type Gender = keyof typeof GENDER_CONDITIONS;
const GENDERS = Object.keys(GENDER_CONDITIONS) as [Gender, ...Gender[]];

// Name of the placeholder styles returned when nothing meets every condition.
const BLANK_STYLE_NAME = 'BLANK';

// Ranking terms every search starts with: +1 each for customizer-available
// and complete styles.
function baseScore(): Prisma.Sql[] {
  return [
    Prisma.sql`(bs.customizer_available = 1)`,
    Prisma.sql`(COALESCE(bs.complete, 0) > 0)`,
  ];
}

// Sport and uniform type filter, as a join on the sport/product view plus
// +2 score terms for exact names. Both must match on the same view row, so a
// style that's a Jersey for one sport and a Short for another isn't returned
// as a Jersey of the second. The view is JSON_TABLE over brand_styles and
// can't be indexed, so it's read in one grouped pass.
function viewFilter(
  sport: string | undefined,
  uniformType: string | undefined,
): { join: Prisma.Sql; score: Prisma.Sql[] } {
  const columns: Prisma.Sql[] = [];
  const conditions: Prisma.Sql[] = [];
  const score: Prisma.Sql[] = [];
  if (sport) {
    columns.push(Prisma.sql`MAX(ms.sport_name = ${sport}) AS sport_exact`);
    conditions.push(Prisma.sql`ms.sport_name LIKE ${contains(sport)}`);
    score.push(Prisma.sql`2 * IFNULL(vm.sport_exact, 0)`);
  }
  if (uniformType) {
    columns.push(
      Prisma.sql`MAX(v.style_category_name = ${uniformType}) AS uniform_exact`,
    );
    conditions.push(
      Prisma.sql`v.style_category_name LIKE ${contains(uniformType)}`,
    );
    score.push(Prisma.sql`2 * IFNULL(vm.uniform_exact, 0)`);
  }
  if (!conditions.length) return { join: Prisma.empty, score };
  return {
    join: Prisma.sql`JOIN (
      SELECT v.id, ${Prisma.join(columns, ', ')}
      FROM brand_style_sport_product_info_view v
      LEFT JOIN master_sports ms
        ON ms.id = v.sport AND ms.deleted_at IS NULL
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY v.id
    ) vm ON vm.id = bs.id`,
    score,
  };
}

interface SearchArgs {
  style_name?: string;
  sport?: string;
  uniform_type?: string;
  gender?: string;
  color?: string;
  body_part?: string;
  block_name?: string;
}

// First line of the fallback answer: which conditions couldn't all be met.
function noMatchNote(args: SearchArgs): string {
  const conditions: [string, string | undefined][] = [
    ['style name', args.style_name],
    ['sport', args.sport],
    ['uniform type', args.uniform_type],
    ['gender', args.gender],
    [
      'color',
      args.color &&
        `${args.color} (${args.body_part ?? DEFAULT_BODY_PART})`,
    ],
    ['body part', args.color ? undefined : args.body_part],
    ['block name', args.block_name],
  ];
  const given = conditions
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join(', ');
  const blank = args.uniform_type
    ? `a blank ${args.uniform_type} style`
    : 'a blank style';
  return `No style matches all the conditions (${given}). Here is ${blank} instead:`;
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
        description: `Find brand styles by style name, sport, uniform type, gender, color, body part and/or block name. Filters are optional but at least one is required; they combine with AND. Text filters are case-insensitive partial matches, except color, which must equal a default color name (e.g. "Black") of one body part: the body_part given, or "${DEFAULT_BODY_PART}" when body_part is omitted (so any color given alone is matched against the body's default color, never against trims or other parts). Only pass body_part when the user names one. Pass every condition from the user's request as a filter (e.g. "red basketball jersey" → color "Red", sport "Basketball", uniform_type "Jersey"), and never drop, loosen or change filters and search again to get a result. If no style meets every condition, the result starts with "No style matches all the conditions (…)" followed by a BLANK style of the requested uniform type (and sport, when one exists); tell the user that no style matched and show the blank style as given. Otherwise it returns only the single most relevant style: a first line "brand style id - brand style name - front thumbnail", then "Body parts:" with one "- <body part group>: <default color>" line per body part ("Body parts: none" if the style has none). Ranking: styles with body part data first, then exact name matches, then customizer-ready styles, then the most recently updated. Soft-deleted rows are excluded. Show the user the result exactly as given. Do not add other fields, summaries or extra details, and do not call other tools to enrich the result unless the user explicitly asks for more.${BRAND_NOTE}${FAILURE_NOTE}`,
        inputSchema: {
          style_name: textFilter(
            'Brand style name, matched against brand_styles.brand_style_name',
          ),
          sport: textFilter(
            'Sport name, matched against master_sports.sport_name',
          ),
          uniform_type: textFilter(
            'Uniform type, matched against the style category name',
          ),
          gender: z
            .enum(GENDERS)
            .optional()
            .catch(INVALID_INPUT as Gender)
            .meta(
              advertised(
                "Gender from the block's spec sheet (master_genders): men, women, boys, girls, youth or adult. youth/adult cover every gender in that category; men/women also match Men & Women, boys/girls also match Boys & Girls",
              ),
            ),
          color: textFilter(
            `Default color name of the body part given in body_part (${DEFAULT_BODY_PART} if body_part is omitted)`,
          ),
          body_part: textFilter(
            `Body part group name, e.g. "Body", "Sleeves" or "Collar". Matches the exact name or its fabric variants ("Body" matches "Body - LTX" but not "Body Stripe 1"). With color, the color must be on this body part; defaults to "${DEFAULT_BODY_PART}" when only color is given`,
          ),
          block_name: textFilter(
            'Block name, matched against the block product name or block pattern name',
          ),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(this.logger, 'search_brand_styles', async (args) => {
        const {
          style_name,
          sport,
          uniform_type,
          gender,
          color,
          body_part,
          block_name,
        } = args;
        const values = [
          style_name,
          sport,
          uniform_type,
          gender,
          color,
          body_part,
          block_name,
        ];
        if (values.includes(INVALID_INPUT) || values.every((v) => !v)) {
          return unableToProcess();
        }

        // Each filter is a parameterized fragment; unset filters add nothing.
        // Ranking: +2 per filter matched by exact name (not just a substring),
        // on top of baseScore().
        const filters = this.baseFilters();
        const view = viewFilter(sport, uniform_type);
        const score = [...baseScore(), ...view.score];
        if (style_name) {
          filters.push(
            Prisma.sql`bs.brand_style_name LIKE ${contains(style_name)}`,
          );
          score.push(
            Prisma.sql`2 * IFNULL(bs.brand_style_name = ${style_name}, 0)`,
          );
        }
        if (gender) {
          // spec_sheet_list.gender_id is a JSON array of master_genders ids as
          // strings, e.g. ["32","13"]. (`ssl` is reserved in MySQL, hence `sl`.)
          filters.push(Prisma.sql`EXISTS (
            SELECT 1 FROM spec_sheet_list sl
            JOIN master_genders mg
              ON mg.deleted_at IS NULL
             AND JSON_CONTAINS(sl.gender_id, JSON_QUOTE(CAST(mg.id AS CHAR)))
            WHERE sl.id = bpr.spec_sheet_id AND sl.deleted_at IS NULL
              AND (${GENDER_CONDITIONS[gender]}))`);
        }
        if (color) {
          // Cheap pre-check that the color appears anywhere, then require it
          // on the requested body part (Body by default).
          const pattern = colorElement(color);
          filters.push(Prisma.sql`(
            LOWER(JSON_EXTRACT(bs.body_part_color_groups, '$[*].default_color')) LIKE ${pattern}
            OR LOWER(JSON_EXTRACT(bs.body_part_group_default_colors, '$[*].default_color')) LIKE ${pattern})`);
          filters.push(hasBodyPart(body_part ?? DEFAULT_BODY_PART, color));
        } else if (body_part) {
          filters.push(hasBodyPart(body_part, undefined));
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

        const match = await this.findBest(filters, view.join, score);
        if (match) return plainText(formatStyle(match));

        // Nothing meets every condition: never loosen the filters, say so and
        // offer a BLANK style of the requested uniform type instead.
        const blank = await this.findBlank(sport, uniform_type);
        return blank
          ? plainText(`${noMatchNote(args)}\n${formatStyle(blank)}`)
          : unableToProcess();
      }),
    );
  }

  private baseFilters(): Prisma.Sql[] {
    const filters = [Prisma.sql`bs.deleted_at IS NULL`];
    if (this.brandId !== null) {
      filters.push(Prisma.sql`bs.brand_id = ${this.brandId}`);
    }
    return filters;
  }

  // The best style passing every filter: styles with body part data first,
  // then by score, then the most recently updated.
  private async findBest(
    filters: Prisma.Sql[],
    viewJoin: Prisma.Sql,
    score: Prisma.Sql[],
  ): Promise<BrandStyleMatch | undefined> {
    const rows = await this.prisma.$queryRaw<BrandStyleMatch[]>`
      SELECT bs.id, bs.brand_style_name, bs.front_thumbnail,
             bs.body_part_color_groups, bs.body_part_group_default_colors
      FROM brand_styles bs
      ${viewJoin}
      LEFT JOIN block_pattern_brand_rules bpbr
        ON bpbr.id = bs.brand_block_id AND bpbr.deleted_at IS NULL
      LEFT JOIN block_pattern_rules bpr
        ON bpr.id = bpbr.block_pattern_rule_id AND bpr.deleted_at IS NULL
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY (JSON_LENGTH(COALESCE(bs.body_part_group_default_colors, '[]')) > 0
                OR JSON_LENGTH(COALESCE(bs.body_part_color_groups, '[]')) > 0) DESC,
               (${Prisma.join(score, ' + ')}) DESC,
               bs.updated_at DESC, bs.id DESC
      LIMIT 1`;
    return rows[0];
  }

  // A BLANK style for the fallback: uniform type + sport, then uniform type
  // alone, or any BLANK when no uniform type was asked for.
  private async findBlank(
    sport: string | undefined,
    uniformType: string | undefined,
  ): Promise<BrandStyleMatch | undefined> {
    const tiers: [string | undefined, string | undefined][] = uniformType
      ? sport
        ? [
            [sport, uniformType],
            [undefined, uniformType],
          ]
        : [[undefined, uniformType]]
      : [[undefined, undefined]];
    for (const [tierSport, tierType] of tiers) {
      const view = viewFilter(tierSport, tierType);
      const blank = await this.findBest(
        [
          ...this.baseFilters(),
          Prisma.sql`bs.brand_style_name = ${BLANK_STYLE_NAME}`,
        ],
        view.join,
        [...baseScore(), ...view.score],
      );
      if (blank) return blank;
    }
    return undefined;
  }
}
