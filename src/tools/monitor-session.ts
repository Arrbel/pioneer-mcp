/**
 * open/read/close_monitor_session — persistent serial monitor tools.
 *
 * These wrap the session manager in src/pio/monitor.ts. The persistence model
 * is the point: open once, read repeatedly over time, close when done — so the
 * board is reset only on open, not on every read.
 */

import { z } from 'zod';
import {
  buildResponse,
  errorResponse,
  type ExecutionResultMeta,
  type ToolResponse,
} from '../result.js';
import {
  openSession,
  readSession,
  closeSession,
  type SessionStatus,
} from '../pio/monitor.js';
import { PioNotFoundError } from '../pio/exec.js';

function readMeta(): ExecutionResultMeta {
  return { operationType: 'monitor', executionStatus: 'succeeded' };
}

/* -------------------------------------------------------------------------- */
/* open_monitor_session                                                       */
/* -------------------------------------------------------------------------- */

export const openMonitorSessionInputSchema = z.object({
  port: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Serial port to open (e.g. COM5, /dev/ttyUSB0). Discover with list_devices.'
    ),
  baud: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Baud rate. If omitted, platformio.ini monitor_speed is used.'),
});
export type OpenMonitorSessionInput = z.infer<
  typeof openMonitorSessionInputSchema
>;

export interface OpenMonitorSessionData {
  sessionId: string;
  port: string;
  baud?: number;
  meta: ExecutionResultMeta;
}

/** Opens a persistent monitor session. */
export async function runOpenMonitorSession(
  input: OpenMonitorSessionInput
): Promise<ToolResponse<OpenMonitorSessionData | null>> {
  try {
    const result = await openSession(input.port, input.baud);
    return buildResponse({
      status: 'ok',
      summary: `Opened monitor session on ${result.port}.`,
      data: {
        sessionId: result.sessionId,
        port: result.port,
        baud: result.baud,
        meta: readMeta(),
      },
      warnings: [
        'Opening the port typically resets the board; the first reads may include boot output.',
      ],
      nextActions: [
        'Call read_monitor_session with this sessionId to collect output.',
        'Call close_monitor_session when finished to release the port.',
      ],
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
      error instanceof Error ? error.message : 'Failed to open session.'
    );
  }
}

/* -------------------------------------------------------------------------- */
/* read_monitor_session                                                       */
/* -------------------------------------------------------------------------- */

export const readMonitorSessionInputSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe('Session id returned by open_monitor_session.'),
  fromStart: z
    .boolean()
    .optional()
    .describe(
      'If true, return the full retained buffer instead of only new lines.'
    ),
});
export type ReadMonitorSessionInput = z.infer<
  typeof readMonitorSessionInputSchema
>;

export interface ReadMonitorSessionData {
  sessionId: string;
  status: SessionStatus;
  exitCode?: number | null;
  lines: string[];
  droppedLines: number;
  meta: ExecutionResultMeta;
}

/** Reads new (or full) output from a monitor session. */
export async function runReadMonitorSession(
  input: ReadMonitorSessionInput
): Promise<ToolResponse<ReadMonitorSessionData | null>> {
  const result = readSession(input.sessionId, input.fromStart);
  if (!result.found) {
    return errorResponse(
      `No monitor session found with id ${input.sessionId}.`,
      ['The session may have been closed, or the id is incorrect.'],
      ['Open a new session with open_monitor_session.']
    );
  }

  const warnings: string[] = [];
  if (result.droppedLines > 0) {
    warnings.push(
      `${result.droppedLines} line(s) were dropped from the buffer before this read; poll more frequently to avoid loss.`
    );
  }
  if (result.status === 'exited') {
    warnings.push(
      `Monitor process has exited (code ${result.exitCode ?? 'unknown'}); no further output will arrive.`
    );
  }

  return buildResponse({
    status: warnings.length > 0 ? 'warning' : 'ok',
    summary: `Read ${result.lines.length} line(s) from session (${result.status}).`,
    data: {
      sessionId: input.sessionId,
      status: result.status ?? 'running',
      exitCode: result.exitCode,
      lines: result.lines,
      droppedLines: result.droppedLines,
      meta: readMeta(),
    },
    warnings,
  });
}

/* -------------------------------------------------------------------------- */
/* close_monitor_session                                                      */
/* -------------------------------------------------------------------------- */

export const closeMonitorSessionInputSchema = z.object({
  sessionId: z.string().min(1).describe('Session id to close.'),
});
export type CloseMonitorSessionInput = z.infer<
  typeof closeMonitorSessionInputSchema
>;

export interface CloseMonitorSessionData {
  sessionId: string;
  port?: string;
  totalLines?: number;
  meta: ExecutionResultMeta;
}

/** Closes a monitor session and releases the port. */
export async function runCloseMonitorSession(
  input: CloseMonitorSessionInput
): Promise<ToolResponse<CloseMonitorSessionData | null>> {
  const result = closeSession(input.sessionId);
  if (!result.found) {
    return errorResponse(
      `No monitor session found with id ${input.sessionId}.`,
      ['It may already be closed.']
    );
  }
  return buildResponse({
    status: 'ok',
    summary: `Closed monitor session on ${result.port} (${result.totalLines} total lines).`,
    data: {
      sessionId: input.sessionId,
      port: result.port,
      totalLines: result.totalLines,
      meta: readMeta(),
    },
  });
}
