/**
 * build_project — compile a PlatformIO environment.
 *
 * Mutating only in the sense that it writes build artifacts to `.pio/`; it does
 * not touch hardware. Resolves the target environment (refusing ambiguous
 * cases) and reports compile success plus memory usage when available.
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
  parseMemoryUsage,
  PioNotFoundError,
  type MemoryUsage,
} from '../pio/run.js';

export const buildProjectInputSchema = z.object({
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
      'Environment to build. If omitted, resolved from platformio.ini; ambiguous projects are refused.'
    ),
});
export type BuildProjectInput = z.infer<typeof buildProjectInputSchema>;

export interface BuildProjectData {
  environment: string;
  environmentSource: string;
  succeeded: boolean;
  memoryUsage?: MemoryUsage;
  /** Tail of build output, for diagnosis. */
  outputTail: string;
  meta: ExecutionResultMeta;
}

/** Returns the last N lines of text, for compact diagnostics. */
function tail(text: string, lines = 40): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

/** Builds a PlatformIO environment. */
export async function runBuildProject(
  input: BuildProjectInput
): Promise<ToolResponse<BuildProjectData | null>> {
  const startedAt = Date.now();

  const target = await resolveTargetEnvironment(input.projectDir, input.environment);
  if (!target.ok || !target.environment) {
    return errorResponse(
      target.refusalReason ?? 'Could not resolve a build environment.',
      target.refusalWarnings ?? [],
      ['Call inspect_project to see available environments, then pass one explicitly.']
    );
  }

  let result;
  try {
    result = await runPioTarget({
      projectDir: input.projectDir,
      environment: target.environment,
    });
  } catch (error) {
    if (error instanceof PioNotFoundError) {
      return errorResponse(error.message, [], ['Install PlatformIO Core CLI, then run doctor.']);
    }
    return errorResponse(error instanceof Error ? error.message : 'Build failed to start.');
  }

  const succeeded = result.exitCode === 0;
  const memoryUsage = parseMemoryUsage(result.stdout);
  const outputTail = tail(succeeded ? result.stdout : result.stderr || result.stdout);

  const data: BuildProjectData = {
    environment: target.environment,
    environmentSource: target.source ?? 'explicit',
    succeeded,
    memoryUsage,
    outputTail,
    meta: {
      operationType: 'build',
      executionStatus: succeeded ? 'succeeded' : 'failed',
      failureCategory: succeeded ? undefined : 'build_failed',
      retryHint: succeeded
        ? undefined
        : 'Inspect the output tail for the first compiler error and fix it before rebuilding.',
      durationMs: Date.now() - startedAt,
    },
  };

  return buildResponse({
    status: succeeded ? 'ok' : 'error',
    summary: succeeded
      ? `Build succeeded for '${target.environment}'.`
      : `Build failed for '${target.environment}' (exit ${result.exitCode}).`,
    data,
    warnings: succeeded ? [] : ['Compilation did not complete successfully.'],
    nextActions: succeeded
      ? ['Run upload_firmware to flash the built environment to a connected board.']
      : ['Review outputTail for the first error; fix and rebuild.'],
  });
}
