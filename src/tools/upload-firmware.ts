/**
 * upload_firmware — build and flash firmware to a connected board
 * (`pio run -t upload`).
 *
 * This is the one tool in the read/build family that mutates external
 * hardware: it writes to a physical device. It performs no confirmation itself
 * — the MCP host's permission layer is responsible for gating the call — but it
 * is described and categorized as a hardware-mutating operation so hosts and
 * agents treat it accordingly.
 */

import { z } from 'zod';
import {
  buildResponse,
  errorResponse,
  type ExecutionResultMeta,
  type ToolResponse,
} from '../result.js';
import {
  resolveTargetEnvironment,
  runPioTarget,
  PioNotFoundError,
} from '../pio/run.js';

export const uploadFirmwareInputSchema = z.object({
  projectDir: z
    .string()
    .min(1)
    .describe('Absolute path to the PlatformIO project root.'),
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Environment to upload. If omitted, resolved from platformio.ini; ambiguous projects are refused.'
    ),
  uploadPort: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Serial port to flash (e.g. COM5, /dev/ttyUSB0). If omitted, PlatformIO auto-detects. Use list_devices to discover ports.'
    ),
});
export type UploadFirmwareInput = z.infer<typeof uploadFirmwareInputSchema>;

export interface UploadFirmwareData {
  environment: string;
  environmentSource: string;
  uploadPort?: string;
  succeeded: boolean;
  outputTail: string;
  meta: ExecutionResultMeta;
}

function tail(text: string, lines = 40): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

/** Builds and flashes firmware to a connected board. */
export async function runUploadFirmware(
  input: UploadFirmwareInput
): Promise<ToolResponse<UploadFirmwareData | null>> {
  const startedAt = Date.now();

  const target = await resolveTargetEnvironment(
    input.projectDir,
    input.environment
  );
  if (!target.ok || !target.environment) {
    return errorResponse(
      target.refusalReason ?? 'Could not resolve an environment to upload.',
      target.refusalWarnings ?? [],
      [
        'Call inspect_project to see available environments, then pass one explicitly.',
      ]
    );
  }

  let result;
  try {
    result = await runPioTarget({
      projectDir: input.projectDir,
      environment: target.environment,
      target: 'upload',
      uploadPort: input.uploadPort,
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
      error instanceof Error ? error.message : 'Upload failed to start.'
    );
  }

  const succeeded = result.exitCode === 0;
  const outputTail = tail(
    succeeded ? result.stdout : result.stderr || result.stdout
  );

  const data: UploadFirmwareData = {
    environment: target.environment,
    environmentSource: target.source ?? 'explicit',
    uploadPort: input.uploadPort,
    succeeded,
    outputTail,
    meta: {
      operationType: 'upload',
      executionStatus: succeeded ? 'succeeded' : 'failed',
      failureCategory: succeeded ? undefined : 'upload_failed',
      retryHint: succeeded
        ? undefined
        : 'Confirm the board is connected and the port is correct (list_devices); check the board is not held in reset or busy.',
      durationMs: Date.now() - startedAt,
    },
  };

  return buildResponse({
    status: succeeded ? 'ok' : 'error',
    summary: succeeded
      ? `Uploaded firmware to '${target.environment}'${input.uploadPort ? ` on ${input.uploadPort}` : ''}.`
      : `Upload failed for '${target.environment}' (exit ${result.exitCode}).`,
    data,
    warnings: succeeded
      ? []
      : ['Firmware upload did not complete successfully.'],
    nextActions: succeeded
      ? ['Open a monitor session to observe device output after reset.']
      : [
          'Run list_devices to confirm the port.',
          'Verify the board is powered, connected, and not held in bootloader/reset.',
        ],
  });
}
