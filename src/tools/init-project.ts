/**
 * init_project — scaffold or extend a PlatformIO project.
 *
 * Filesystem-mutating. Wraps `pio project init`, which creates the standard
 * layout (src/, include/, lib/, test/, .gitignore, platformio.ini) and adds an
 * `[env:<board>]` section. It is non-destructive: run against a directory that
 * already has a platformio.ini, it MERGES a new environment rather than
 * clobbering the file — so this tool reports whether it created or extended.
 *
 * By default we pass --no-install-dependencies: init stays fast and offline,
 * and the platform/toolchain installs lazily on the first build_project. Set
 * installDependencies to eagerly install now (needs network, can take minutes).
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  buildResponse,
  errorResponse,
  type ExecutionResultMeta,
  type ToolResponse,
} from '../result.js';
import { execPio, PioNotFoundError, type CommandResult } from '../pio/exec.js';

/** Init can install a platform; keep the timeout generous for that path. */
const INIT_TIMEOUT_MS = 600_000;

export const initProjectInputSchema = z.object({
  projectDir: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the target directory. Created if it does not exist; an existing PlatformIO project is extended, not overwritten.'
    ),
  board: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Board id for the environment to add (e.g. "uno", "esp32dev"). Use list_boards / get_board_info to find ids.'
    ),
  sampleCode: z
    .boolean()
    .optional()
    .describe('Generate example source in src/ (pio --sample-code).'),
  installDependencies: z
    .boolean()
    .optional()
    .describe(
      'Install the platform/toolchain now (network, slow). Default false: install lazily on first build.'
    ),
});
export type InitProjectInput = z.infer<typeof initProjectInputSchema>;

export interface InitProjectData {
  projectDir: string;
  board: string;
  succeeded: boolean;
  /** Whether a platformio.ini already existed (extended vs created). */
  extendedExisting: boolean;
  /** True if the resulting platformio.ini contains an [env:<board>] section. */
  environmentPresent: boolean;
  meta: ExecutionResultMeta;
}

/** Whether platformio.ini exists in a directory. */
async function hasIni(dir: string): Promise<boolean> {
  try {
    await access(join(dir, 'platformio.ini'));
    return true;
  } catch {
    return false;
  }
}

/** Initializes or extends a PlatformIO project. */
export async function runInitProject(
  input: InitProjectInput
): Promise<ToolResponse<InitProjectData | null>> {
  const startedAt = Date.now();

  const extendedExisting = await hasIni(input.projectDir);

  const args = [
    'project',
    'init',
    '-d',
    input.projectDir,
    '-b',
    input.board,
    '-s',
  ];
  if (input.sampleCode) args.push('--sample-code');
  if (!input.installDependencies) args.push('--no-install-dependencies');

  let result: CommandResult;
  try {
    result = await execPio(args, {
      cwd: input.projectDir,
      timeoutMs: INIT_TIMEOUT_MS,
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
      error instanceof Error ? error.message : 'Project init failed to start.'
    );
  }

  const succeeded = result.exitCode === 0;
  if (!succeeded) {
    return errorResponse(
      result.stderr.trim() ||
        `pio project init failed (exit ${result.exitCode}).`,
      [],
      [
        'Verify the board id with get_board_info.',
        'Confirm the target directory is writable.',
      ]
    );
  }

  // Confirm the environment landed in the resulting config.
  let environmentPresent = false;
  try {
    const ini = await readFile(
      join(input.projectDir, 'platformio.ini'),
      'utf8'
    );
    environmentPresent = ini.includes(`[env:${input.board}]`);
  } catch {
    environmentPresent = false;
  }

  const warnings: string[] = [];
  if (!environmentPresent) {
    warnings.push(
      `init succeeded but no [env:${input.board}] section was found in platformio.ini.`
    );
  }

  return buildResponse({
    status: environmentPresent ? 'ok' : 'warning',
    summary: extendedExisting
      ? `Extended existing project at ${input.projectDir} with env '${input.board}'.`
      : `Initialized PlatformIO project at ${input.projectDir} for board '${input.board}'.`,
    data: {
      projectDir: input.projectDir,
      board: input.board,
      succeeded,
      extendedExisting,
      environmentPresent,
      meta: {
        operationType: 'package',
        executionStatus: 'succeeded',
        durationMs: Date.now() - startedAt,
      },
    },
    warnings,
    nextActions: [
      'Call inspect_project to confirm the resolved configuration.',
      'Call build_project to compile (installs the toolchain on first run).',
    ],
  });
}
