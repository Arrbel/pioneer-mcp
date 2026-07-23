/**
 * Execution-truth layer: what PlatformIO itself reports after resolving a
 * project, via `pio project metadata --json-output`.
 *
 * This is authoritative where our static ini parse is only a best guess. When
 * the two disagree (e.g. because of `extends`, `extra_configs`, or ${sysenv.*}
 * interpolation), inspect_project should trust this.
 */

import { execPio, PioNotFoundError, type CommandResult } from './exec.js';

export interface EnvironmentMetadata {
  name: string;
  board?: string;
  platform?: string;
  framework?: string[];
}

export interface MetadataResult {
  /** True if the CLI produced usable metadata. */
  available: boolean;
  environments: EnvironmentMetadata[];
  /** Reason metadata is unavailable, when available === false. */
  unavailableReason?: string;
}

interface RawEnvMetadata {
  board_config?: { name?: string };
  board?: string;
  platform?: { name?: string } | string;
  frameworks?: string[];
}

function coercePlatform(value: RawEnvMetadata['platform']): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return value.name;
}

/**
 * Parses `pio project metadata --json-output`. The CLI emits an object keyed
 * by environment name; each value carries the resolved board/platform/frameworks.
 */
export function parseMetadata(stdout: string): EnvironmentMetadata[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (parsed === null || typeof parsed !== 'object') return [];

  return Object.entries(parsed as Record<string, RawEnvMetadata>).map(
    ([name, raw]) => ({
      name,
      board: raw.board_config?.name ?? raw.board,
      platform: coercePlatform(raw.platform),
      framework: Array.isArray(raw.frameworks) ? raw.frameworks : undefined,
    })
  );
}

/** Loads resolved project metadata from the PlatformIO CLI. */
export async function loadProjectMetadata(
  projectDir: string
): Promise<MetadataResult> {
  let result: CommandResult;
  try {
    result = await execPio(
      ['project', 'metadata', '--json-output'],
      { cwd: projectDir }
    );
  } catch (error) {
    if (error instanceof PioNotFoundError) {
      return {
        available: false,
        environments: [],
        unavailableReason: 'PlatformIO CLI not found.',
      };
    }
    return {
      available: false,
      environments: [],
      unavailableReason:
        error instanceof Error ? error.message : 'Unknown error running CLI.',
    };
  }

  if (result.exitCode !== 0) {
    return {
      available: false,
      environments: [],
      unavailableReason:
        result.stderr.trim() ||
        `pio project metadata exited with code ${result.exitCode}.`,
    };
  }

  const environments = parseMetadata(result.stdout);
  if (environments.length === 0) {
    return {
      available: false,
      environments: [],
      unavailableReason:
        'PlatformIO returned no environment metadata (project may be uninitialized).',
    };
  }

  return { available: true, environments };
}
