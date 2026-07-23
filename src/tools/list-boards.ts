/**
 * list_boards — search the PlatformIO board catalog.
 *
 * Read-only. Wraps `pio boards [query] --json-output`. The full catalog is
 * thousands of entries, so a query filter is strongly recommended; results are
 * capped to keep responses agent-friendly.
 */

import { z } from 'zod';
import {
  buildResponse,
  errorResponse,
  type ExecutionResultMeta,
  type ToolResponse,
} from '../result.js';
import { execPio, PioNotFoundError, type CommandResult } from '../pio/exec.js';

const DEFAULT_LIMIT = 50;

export const listBoardsInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Filter text matched against board id, name, platform, or MCU (e.g. "esp32", "nano", "rp2040"). Strongly recommended.'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe(`Maximum boards to return (default ${DEFAULT_LIMIT}, max 200).`),
});
export type ListBoardsInput = z.infer<typeof listBoardsInputSchema>;

export interface BoardSummary {
  id: string;
  name?: string;
  platform?: string;
  mcu?: string;
  frameworks?: string[];
}

export interface ListBoardsData {
  boards: BoardSummary[];
  totalMatched: number;
  truncated: boolean;
  query?: string;
  meta: ExecutionResultMeta;
}

interface RawBoard {
  id?: string;
  name?: string;
  platform?: string;
  mcu?: string;
  frameworks?: string[];
}

/** Parses `pio boards --json-output` into normalized board summaries. */
export function parseBoards(stdout: string): BoardSummary[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is RawBoard => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      id: entry.id ?? '',
      name: entry.name,
      platform: entry.platform,
      mcu: entry.mcu,
      frameworks: Array.isArray(entry.frameworks) ? entry.frameworks : undefined,
    }))
    .filter((board) => board.id.length > 0);
}

/** Searches the PlatformIO board catalog. */
export async function runListBoards(
  input: ListBoardsInput
): Promise<ToolResponse<ListBoardsData | null>> {
  const startedAt = Date.now();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const args = ['boards', '--json-output'];
  if (input.query) args.splice(1, 0, input.query);

  let result: CommandResult;
  try {
    // Catalog reads can be slow on a cold platform index.
    result = await execPio(args, { timeoutMs: 60_000 });
  } catch (error) {
    if (error instanceof PioNotFoundError) {
      return errorResponse(error.message, [], [
        'Install PlatformIO Core CLI, then run doctor.',
      ]);
    }
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to list boards.'
    );
  }

  if (result.exitCode !== 0) {
    return errorResponse(
      result.stderr.trim() || 'pio boards failed.',
      [],
      ['Run doctor to confirm the PlatformIO CLI is healthy.']
    );
  }

  const allBoards = parseBoards(result.stdout);
  const boards = allBoards.slice(0, limit);
  const truncated = allBoards.length > boards.length;

  const warnings: string[] = [];
  if (allBoards.length === 0) {
    warnings.push(
      input.query
        ? `No boards matched "${input.query}".`
        : 'No boards returned by the catalog.'
    );
  }
  if (truncated) {
    warnings.push(
      `Showing ${boards.length} of ${allBoards.length} matches; narrow the query or raise limit.`
    );
  }

  const nextActions = !input.query && allBoards.length > limit
    ? ['Provide a query to narrow the catalog to the board you need.']
    : [];

  return buildResponse({
    status: warnings.length > 0 ? 'warning' : 'ok',
    summary: `Matched ${allBoards.length} board(s)${
      input.query ? ` for "${input.query}"` : ''
    }; returning ${boards.length}.`,
    data: {
      boards,
      totalMatched: allBoards.length,
      truncated,
      query: input.query,
      meta: {
        operationType: 'read',
        executionStatus: 'succeeded',
        durationMs: Date.now() - startedAt,
      },
    },
    warnings,
    nextActions,
  });
}
