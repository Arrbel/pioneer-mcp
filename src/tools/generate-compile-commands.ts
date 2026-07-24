/**
 * generate_compile_commands — produce compile_commands.json for IDE/clangd.
 *
 * Wraps `pio run -t compiledb`, which writes a clang-compatible compilation
 * database to the project root. This is what gives editors accurate include
 * paths, defines, and diagnostics for a PlatformIO project.
 *
 * NOTE: on a cold project this triggers a full platform + toolchain install
 * (a real compile is required to record the flags), so the first run can take
 * minutes and needs network access. Subsequent runs are fast.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
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

export const generateCompileCommandsInputSchema = z.object({
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
      'Environment to generate the database for. If omitted, resolved from platformio.ini; ambiguous projects are refused.'
    ),
});
export type GenerateCompileCommandsInput = z.infer<
  typeof generateCompileCommandsInputSchema
>;

export interface GenerateCompileCommandsData {
  environment: string;
  environmentSource: string;
  succeeded: boolean;
  /** Absolute path to compile_commands.json, when it was produced. */
  outputPath?: string;
  meta: ExecutionResultMeta;
}

/** Generates a clang compilation database via `pio run -t compiledb`. */
export async function runGenerateCompileCommands(
  input: GenerateCompileCommandsInput
): Promise<ToolResponse<GenerateCompileCommandsData | null>> {
  const startedAt = Date.now();

  const target = await resolveTargetEnvironment(
    input.projectDir,
    input.environment
  );
  if (!target.ok || !target.environment) {
    return errorResponse(
      target.refusalReason ??
        'Could not resolve an environment for the compilation database.',
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
      target: 'compiledb',
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
      error instanceof Error
        ? error.message
        : 'compiledb generation failed to start.'
    );
  }

  const succeeded = result.exitCode === 0;

  // compile_commands.json is written to the project root by PlatformIO.
  let outputPath: string | undefined;
  if (succeeded) {
    const candidate = join(input.projectDir, 'compile_commands.json');
    try {
      await access(candidate);
      outputPath = candidate;
    } catch {
      outputPath = undefined;
    }
  }

  const warnings: string[] = [];
  if (!succeeded) {
    warnings.push(result.stderr.trim() || 'compiledb did not complete.');
  } else if (!outputPath) {
    warnings.push(
      'compiledb reported success but compile_commands.json was not found at the project root.'
    );
  }

  return buildResponse({
    status: succeeded ? (outputPath ? 'ok' : 'warning') : 'error',
    summary: succeeded
      ? outputPath
        ? `Generated compile_commands.json for '${target.environment}'.`
        : `compiledb ran for '${target.environment}' but no database was found.`
      : `compiledb failed for '${target.environment}' (exit ${result.exitCode}).`,
    data: {
      environment: target.environment,
      environmentSource: target.source ?? 'explicit',
      succeeded,
      outputPath,
      meta: {
        operationType: 'build',
        executionStatus: succeeded ? 'succeeded' : 'failed',
        failureCategory: succeeded ? undefined : 'compiledb_failed',
        durationMs: Date.now() - startedAt,
      },
    },
    warnings,
    nextActions: outputPath
      ? ['Point your editor/clangd at the generated compile_commands.json.']
      : [],
  });
}
