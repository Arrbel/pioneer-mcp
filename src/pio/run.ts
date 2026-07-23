/**
 * Shared execution helper for the mutating `pio run` family (build / clean /
 * upload). Centralizes two concerns every mutating tool shares:
 *
 *   1. Target-environment resolution — if the caller does not name an
 *      environment, we resolve it from platformio.ini and REFUSE to proceed
 *      when the choice is ambiguous, rather than silently guessing. Acting on
 *      the wrong environment is exactly the kind of mistake this layer exists
 *      to prevent.
 *   2. Uniform invocation + output capture through the injectable exec layer.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execPio, PioNotFoundError, type CommandResult } from './exec.js';
import { parsePlatformIOIni, resolveEnvironment } from './ini.js';

/** Long timeout: a cold toolchain build/upload can take minutes. */
export const RUN_TIMEOUT_MS = 600_000;

export interface ResolvedTarget {
  ok: boolean;
  environment?: string;
  /** How the environment was chosen, for transparency in the response. */
  source?: 'explicit' | 'default_envs' | 'single_environment_fallback';
  /** Present when ok === false: why we refused to pick an environment. */
  refusalReason?: string;
  refusalWarnings?: string[];
}

/**
 * Determines which environment a mutating command should target.
 * An explicit environment always wins. Otherwise we fall back to the config
 * resolution machine and refuse ambiguous/unresolved cases.
 */
export async function resolveTargetEnvironment(
  projectDir: string,
  explicit?: string
): Promise<ResolvedTarget> {
  if (explicit) {
    return { ok: true, environment: explicit, source: 'explicit' };
  }

  let contents: string;
  try {
    contents = await readFile(join(projectDir, 'platformio.ini'), 'utf8');
  } catch {
    return {
      ok: false,
      refusalReason: `No platformio.ini found in ${projectDir}.`,
      refusalWarnings: ['The target directory is not a PlatformIO project root.'],
    };
  }

  const config = parsePlatformIOIni(contents);
  const resolution = resolveEnvironment(config);

  if (
    resolution.environmentResolution === 'default_envs' ||
    resolution.environmentResolution === 'single_environment_fallback'
  ) {
    return {
      ok: true,
      environment: resolution.resolvedEnvironment,
      source: resolution.environmentResolution,
    };
  }

  return {
    ok: false,
    refusalReason:
      resolution.environmentResolution === 'ambiguous'
        ? 'Multiple environments are defined and none is a default; specify an environment explicitly.'
        : resolution.resolutionReason,
    refusalWarnings: resolution.resolutionWarnings,
  };
}

export interface PioRunOptions {
  projectDir: string;
  environment: string;
  /** Undefined = default build target; otherwise e.g. 'clean' or 'upload'. */
  target?: string;
  uploadPort?: string;
}

/** Invokes `pio run` with the given environment/target through the exec layer. */
export async function runPioTarget(
  options: PioRunOptions
): Promise<CommandResult> {
  const args = ['run', '-e', options.environment];
  if (options.target) args.push('-t', options.target);
  if (options.uploadPort) args.push('--upload-port', options.uploadPort);

  return execPio(args, {
    cwd: options.projectDir,
    timeoutMs: RUN_TIMEOUT_MS,
  });
}

export { PioNotFoundError };

/** Memory usage extracted from a build's stdout, when present. */
export interface MemoryUsage {
  ramPercent?: number;
  ramUsedBytes?: number;
  flashPercent?: number;
  flashUsedBytes?: number;
}

const RAM_RE = /RAM:\s*\[[^\]]*\]\s*([\d.]+)%\s*\(used\s+(\d+)\s+bytes/i;
const FLASH_RE = /Flash:\s*\[[^\]]*\]\s*([\d.]+)%\s*\(used\s+(\d+)\s+bytes/i;

/** Parses RAM/Flash usage lines from PlatformIO build output. */
export function parseMemoryUsage(stdout: string): MemoryUsage | undefined {
  const ram = RAM_RE.exec(stdout);
  const flash = FLASH_RE.exec(stdout);
  if (!ram && !flash) return undefined;
  const usage: MemoryUsage = {};
  if (ram) {
    usage.ramPercent = Number(ram[1]);
    usage.ramUsedBytes = Number(ram[2]);
  }
  if (flash) {
    usage.flashPercent = Number(flash[1]);
    usage.flashUsedBytes = Number(flash[2]);
  }
  return usage;
}
