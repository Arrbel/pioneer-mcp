/**
 * list_environments — the environments declared in platformio.ini.
 *
 * Read-only, config-truth only (no CLI round-trip). This is a lightweight
 * alternative to inspect_project for when an agent only needs the environment
 * names and the resolved default. For execution-truth reconciliation and
 * discrepancy detection, use inspect_project instead.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  buildResponse,
  errorResponse,
  type ExecutionResultMeta,
  type ToolResponse,
} from '../result.js';
import {
  parsePlatformIOIni,
  resolveEnvironment,
  type EnvironmentResolution,
  type EnvironmentSummary,
} from '../pio/ini.js';

export const listEnvironmentsInputSchema = z.object({
  projectDir: z
    .string()
    .min(1)
    .describe('Absolute path to the PlatformIO project root.'),
});
export type ListEnvironmentsInput = z.infer<typeof listEnvironmentsInputSchema>;

export interface ListEnvironmentsData {
  environments: EnvironmentSummary[];
  defaultEnvironments: string[];
  resolvedEnvironment?: string;
  environmentResolution: EnvironmentResolution;
  meta: ExecutionResultMeta;
}

/** Lists PlatformIO environments from static config. */
export async function runListEnvironments(
  input: ListEnvironmentsInput
): Promise<ToolResponse<ListEnvironmentsData | null>> {
  const startedAt = Date.now();
  const iniPath = join(input.projectDir, 'platformio.ini');

  let contents: string;
  try {
    contents = await readFile(iniPath, 'utf8');
  } catch (error) {
    const reason =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? `No platformio.ini found at ${iniPath}.`
        : error instanceof Error
          ? error.message
          : 'Unknown error reading platformio.ini.';
    return errorResponse(reason, ['The target directory is not a PlatformIO project root.']);
  }

  const config = parsePlatformIOIni(contents);
  const resolution = resolveEnvironment(config);

  return buildResponse({
    status: config.warnings.length > 0 ? 'warning' : 'ok',
    summary: `${config.environments.length} environment(s) declared; resolution=${resolution.environmentResolution}.`,
    data: {
      environments: config.environments,
      defaultEnvironments: config.defaultEnvironments,
      resolvedEnvironment: resolution.resolvedEnvironment,
      environmentResolution: resolution.environmentResolution,
      meta: {
        operationType: 'read',
        executionStatus: 'succeeded',
        durationMs: Date.now() - startedAt,
      },
    },
    warnings: [...config.warnings, ...resolution.resolutionWarnings],
  });
}
