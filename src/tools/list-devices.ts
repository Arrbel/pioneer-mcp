/**
 * list_devices — enumerate serial/USB devices visible to PlatformIO.
 *
 * Read-only. Wraps `pio device list --json-output`. Agents use this to pick an
 * upload/monitor port and to confirm a board is actually connected before an
 * upload attempt.
 */

import { z } from 'zod';
import {
  buildResponse,
  errorResponse,
  type ExecutionResultMeta,
  type ToolResponse,
} from '../result.js';
import { execPio, PioNotFoundError, type CommandResult } from '../pio/exec.js';

export const listDevicesInputSchema = z.object({});
export type ListDevicesInput = z.infer<typeof listDevicesInputSchema>;

export interface SerialDevice {
  port: string;
  description?: string;
  hwid?: string;
}

export interface ListDevicesData {
  devices: SerialDevice[];
  meta: ExecutionResultMeta;
}

interface RawDevice {
  port?: string;
  description?: string;
  hwid?: string;
}

/** Parses `pio device list --json-output` into normalized device records. */
export function parseDevices(stdout: string): SerialDevice[] {
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
    .filter((entry): entry is RawDevice => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      port: entry.port ?? '',
      description: entry.description,
      hwid: entry.hwid,
    }))
    .filter((device) => device.port.length > 0);
}

/** Lists connected serial devices. */
export async function runListDevices(): Promise<
  ToolResponse<ListDevicesData | null>
> {
  const startedAt = Date.now();
  let result: CommandResult;
  try {
    result = await execPio(['device', 'list', '--json-output'], {
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (error instanceof PioNotFoundError) {
      return errorResponse(error.message, [], [
        'Install PlatformIO Core CLI, then run doctor.',
      ]);
    }
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to list devices.'
    );
  }

  if (result.exitCode !== 0) {
    return errorResponse(
      result.stderr.trim() || 'pio device list failed.',
      [],
      ['Run doctor to confirm the PlatformIO CLI is healthy.']
    );
  }

  const devices = parseDevices(result.stdout);
  const warnings =
    devices.length === 0
      ? ['No serial devices detected. Connect a board or check drivers/cables.']
      : [];

  return buildResponse({
    status: devices.length === 0 ? 'warning' : 'ok',
    summary: `Found ${devices.length} serial device(s).`,
    data: {
      devices,
      meta: {
        operationType: 'read',
        executionStatus: 'succeeded',
        durationMs: Date.now() - startedAt,
      },
    },
    warnings,
  });
}
