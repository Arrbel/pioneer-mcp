/**
 * clean_project — remove build artifacts for an environment (`pio run -t clean`).
 *
 * Only touches the project's own `.pio` build output; no hardware interaction.
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

export const cleanProjectInputSchema = z.object({
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
      'Environment to clean. If omitted, resolved from platformio.ini; ambiguous projects are refused.'
    ),
});
export type CleanProjectInput = z.infer<typeof cleanProjectInputSchema>;

export interface CleanProjectData {
  environment: string;
  environmentSource: string;
  succeeded: boolean;
  meta: ExecutionResultMeta;
}

/** Cleans build artifacts for a PlatformIO environment. */
export async function runCleanProject(
  input: CleanProjectInput
): Promise<ToolResponse<CleanProjectData | null>> {
  const startedAt = Date.now();

  const target = await resolveTargetEnvironment(input.projectDir, input.environment);
  if (!target.ok || !target.environment) {
    return errorResponse(
      target.refusalReason ?? 'Could not resolve an environment to clean.',
      target.refusalWarnings ?? [],
      ['Call inspect_project to see available environments, then pass one explicitly.']
    );
  }

  let result;
  try {
    result = await runPioTarget({
      projectDir: input.projectDir,
      environment: target.environment,
      target: 'clean',
    });
  } catch (error) {
    if (error instanceof PioNotFoundError) {
      return errorResponse(error.message, [], ['Install PlatformIO Core CLI, then run doctor.']);
    }
    return errorResponse(error instanceof Error ? error.message : 'Clean failed to start.');
  }

  const succeeded = result.exitCode === 0;
  return buildResponse({
    status: succeeded ? 'ok' : 'error',
    summary: succeeded
      ? `Cleaned build artifacts for '${target.environment}'.`
      : `Clean failed for '${target.environment}' (exit ${result.exitCode}).`,
    data: {
      environment: target.environment,
      environmentSource: target.source ?? 'explicit',
      succeeded,
      meta: {
        operationType: 'build',
        executionStatus: succeeded ? 'succeeded' : 'failed',
        failureCategory: succeeded ? undefined : 'clean_failed',
        durationMs: Date.now() - startedAt,
      },
    },
    warnings: succeeded ? [] : [result.stderr.trim() || 'Clean did not complete.'],
  });
}
