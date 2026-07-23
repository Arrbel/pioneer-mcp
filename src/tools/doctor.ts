/**
 * `doctor` — diagnose host readiness for PlatformIO execution.
 *
 * This is the recommended first call in any Pioneer workflow. It reports what
 * is and is not ready, with machine-readable problem codes, without attempting
 * any repair. Repair is a separate, confirmation-gated concern.
 */

import { z } from 'zod';
import {
  buildResponse,
  type ToolResponse,
  type ExecutionResultMeta,
} from '../result.js';
import {
  resolvePioBinary,
  isShellCallable,
  candidatePaths,
  execPio,
} from '../pio/exec.js';

/** Stable, machine-readable problem codes surfaced by doctor. */
export type ProblemCode =
  'platformio_cli_missing' | 'platformio_cli_not_shell_callable';

export interface DoctorProblem {
  code: ProblemCode;
  message: string;
  /** Which capabilities this problem affects. */
  affects: ('build' | 'upload' | 'monitor')[];
}

export interface DoctorData {
  cliAvailable: boolean;
  cliPath?: string;
  cliVersion?: string;
  shellCallable: boolean;
  probedPaths: string[];
  detectedProblems: DoctorProblem[];
  readyForBuild: boolean;
  readyForUpload: boolean;
  readyForMonitor: boolean;
  meta: ExecutionResultMeta;
}

export const doctorInputSchema = z.object({});
export type DoctorInput = z.infer<typeof doctorInputSchema>;

/** Runs host readiness diagnostics. */
export async function runDoctor(): Promise<ToolResponse<DoctorData>> {
  const startedAt = Date.now();
  const probedPaths = candidatePaths();
  const cliPath = await resolvePioBinary();
  const cliAvailable = Boolean(cliPath);

  let cliVersion: string | undefined;
  let shellCallable = false;

  if (cliAvailable) {
    shellCallable = await isShellCallable();
    try {
      const versionResult = await execPio(['--version'], { timeoutMs: 5_000 });
      cliVersion =
        versionResult.stdout.trim() || versionResult.stderr.trim() || undefined;
    } catch {
      // resolvePioBinary already succeeded; a version read miss is non-fatal.
    }
  }

  const detectedProblems: DoctorProblem[] = [];

  if (!cliAvailable) {
    detectedProblems.push({
      code: 'platformio_cli_missing',
      message:
        'PlatformIO CLI could not be resolved from PATH, PLATFORMIO_CLI_PATH, or the default penv location.',
      affects: ['build', 'upload', 'monitor'],
    });
  } else if (!shellCallable) {
    detectedProblems.push({
      code: 'platformio_cli_not_shell_callable',
      message:
        'PlatformIO is installed at a known path but is not directly callable as `pio`/`platformio` from the shell.',
      affects: ['build', 'upload', 'monitor'],
    });
  }

  const ready = cliAvailable;
  const data: DoctorData = {
    cliAvailable,
    cliPath,
    cliVersion,
    shellCallable,
    probedPaths,
    detectedProblems,
    readyForBuild: ready,
    readyForUpload: ready,
    readyForMonitor: ready,
    meta: {
      operationType: 'diagnostic',
      executionStatus: cliAvailable ? 'succeeded' : 'failed',
      failureCategory: cliAvailable ? undefined : 'platformio_cli_missing',
      retryHint: cliAvailable
        ? undefined
        : 'Install PlatformIO Core CLI or set PLATFORMIO_CLI_PATH, then re-run doctor.',
      durationMs: Date.now() - startedAt,
    },
  };

  if (!cliAvailable) {
    return buildResponse({
      status: 'error',
      summary: 'PlatformIO CLI is not available on this host.',
      data,
      warnings: detectedProblems.map((p) => p.message),
      nextActions: [
        'Install PlatformIO Core CLI: https://platformio.org/install/cli',
        'Or set the PLATFORMIO_CLI_PATH environment variable to the pio executable.',
      ],
    });
  }

  const warnings = detectedProblems.map((p) => p.message);
  return buildResponse({
    status: detectedProblems.length > 0 ? 'warning' : 'ok',
    summary: cliVersion
      ? `PlatformIO is ready (${cliVersion}).`
      : 'PlatformIO CLI resolved and ready.',
    data,
    warnings,
    nextActions: [
      'Run inspect_project to resolve project truth before building.',
    ],
  });
}
