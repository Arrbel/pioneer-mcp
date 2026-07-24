/**
 * get_board_info — full details for a single board by id.
 *
 * Read-only. Wraps `pio boards <id> --json-output`, which is a *substring*
 * search (e.g. `uno` returns uno, uno_mini, uno_r4_minima, …), so this tool
 * selects the exact-id match and reports the near-misses as alternatives.
 *
 * Where list_boards returns a trimmed summary for browsing, get_board_info
 * returns the complete record (memory sizes, clock, debug tooling) an agent
 * needs to reason about a specific target.
 */

import { z } from 'zod';
import {
  buildResponse,
  errorResponse,
  type ExecutionResultMeta,
  type ToolResponse,
} from '../result.js';
import { execPio, PioNotFoundError, type CommandResult } from '../pio/exec.js';

export const getBoardInfoInputSchema = z.object({
  boardId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Exact PlatformIO board id (e.g. "uno", "esp32dev", "nanorp2040connect"). Use list_boards to discover ids.'
    ),
});
export type GetBoardInfoInput = z.infer<typeof getBoardInfoInputSchema>;

/** Full board record as reported by the PlatformIO catalog. */
export interface BoardInfo {
  id: string;
  name?: string;
  platform?: string;
  mcu?: string;
  fcpu?: number;
  ram?: number;
  rom?: number;
  frameworks?: string[];
  vendor?: string;
  url?: string;
  /** Names of debug tools the board supports, if any. */
  debugTools?: string[];
}

export interface GetBoardInfoData {
  board: BoardInfo;
  /** Other ids returned by the substring search but not selected. */
  alternatives: string[];
  meta: ExecutionResultMeta;
}

interface RawBoard {
  id?: string;
  name?: string;
  platform?: string;
  mcu?: string;
  fcpu?: number;
  ram?: number;
  rom?: number;
  frameworks?: string[];
  vendor?: string;
  url?: string;
  debug?: { tools?: Record<string, unknown> };
}

function toBoardInfo(raw: RawBoard): BoardInfo {
  const debugTools = raw.debug?.tools
    ? Object.keys(raw.debug.tools)
    : undefined;
  return {
    id: raw.id ?? '',
    name: raw.name,
    platform: raw.platform,
    mcu: raw.mcu,
    fcpu: typeof raw.fcpu === 'number' ? raw.fcpu : undefined,
    ram: typeof raw.ram === 'number' ? raw.ram : undefined,
    rom: typeof raw.rom === 'number' ? raw.rom : undefined,
    frameworks: Array.isArray(raw.frameworks) ? raw.frameworks : undefined,
    vendor: raw.vendor,
    url: raw.url,
    debugTools: debugTools && debugTools.length > 0 ? debugTools : undefined,
  };
}

/** Parses `pio boards <query> --json-output` into raw board records. */
export function parseRawBoards(stdout: string): RawBoard[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is RawBoard => typeof entry === 'object' && entry !== null
  );
}

/** Returns the full record for one board id. */
export async function runGetBoardInfo(
  input: GetBoardInfoInput
): Promise<ToolResponse<GetBoardInfoData | null>> {
  const startedAt = Date.now();

  let result: CommandResult;
  try {
    result = await execPio(['boards', input.boardId, '--json-output'], {
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (error instanceof PioNotFoundError) {
      return errorResponse(
        error.message,
        [],
        ['Install PlatformIO Core CLI, then run doctor.']
      );
    }
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to query board.'
    );
  }

  if (result.exitCode !== 0) {
    return errorResponse(
      result.stderr.trim() || `pio boards ${input.boardId} failed.`,
      [],
      ['Run doctor to confirm the PlatformIO CLI is healthy.']
    );
  }

  const raws = parseRawBoards(result.stdout);
  if (raws.length === 0) {
    return errorResponse(
      `No board matched "${input.boardId}".`,
      [],
      ['Use list_boards with a broader query to find the correct board id.']
    );
  }

  // The query is a substring match; require the exact id to avoid returning a
  // near-neighbor as if it were the requested board.
  const exact = raws.find((raw) => raw.id === input.boardId);
  const alternatives = raws
    .map((raw) => raw.id ?? '')
    .filter((id) => id.length > 0 && id !== input.boardId);

  if (!exact) {
    return errorResponse(
      `No board has the exact id "${input.boardId}"; ${raws.length} similar id(s) exist.`,
      alternatives.length > 0
        ? [`Closest ids: ${alternatives.slice(0, 10).join(', ')}.`]
        : [],
      ['Call get_board_info again with one of the exact ids listed.']
    );
  }

  const board = toBoardInfo(exact);
  return buildResponse({
    status: 'ok',
    summary:
      `${board.id}${board.name ? ` (${board.name})` : ''}: ` +
      `${board.platform ?? 'unknown platform'}, ${board.mcu ?? 'unknown MCU'}.`,
    data: {
      board,
      alternatives,
      meta: {
        operationType: 'read',
        executionStatus: 'succeeded',
        durationMs: Date.now() - startedAt,
      },
    },
    warnings:
      alternatives.length > 0
        ? [`${alternatives.length} other id(s) also matched the substring.`]
        : [],
  });
}
