/**
 * inspect_project — the read-only truth layer.
 *
 * Combines two independent views of a PlatformIO project:
 *   1. Config truth  — what platformio.ini statically says (parsed here).
 *   2. Execution truth — what `pio project metadata` reports after PlatformIO
 *      resolves the project (authoritative).
 *
 * It reports both, flags where they disagree, and resolves which environment
 * a build/upload would target if none is specified. Agents use this before any
 * mutating operation so they act on a known, reconciled project state.
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
import {
  loadProjectMetadata,
  type EnvironmentMetadata,
} from '../pio/metadata.js';

export const inspectProjectInputSchema = z.object({
  projectDir: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the PlatformIO project root (the folder containing platformio.ini).'
    ),
});

export type InspectProjectInput = z.infer<typeof inspectProjectInputSchema>;

/** A per-environment disagreement between static config and CLI metadata. */
export interface ConfigDiscrepancy {
  environment: string;
  field: 'board' | 'platform' | 'framework';
  configValue?: string;
  executionValue?: string;
}

export interface InspectProjectData {
  projectDir: string;
  configPresent: boolean;
  defaultEnvironments: string[];
  environments: EnvironmentSummary[];
  resolvedEnvironment?: string;
  environmentResolution: EnvironmentResolution;
  resolutionReason: string;
  metadataAvailable: boolean;
  metadataUnavailableReason?: string;
  metadataEnvironments: EnvironmentMetadata[];
  /** Fields where static parse and CLI metadata disagree. Prefer metadata. */
  discrepancies: ConfigDiscrepancy[];
  /** Config features that reduce trust in the static parse. */
  complexitySignals: string[];
  meta: ExecutionResultMeta;
}

function compareViews(
  environments: EnvironmentSummary[],
  metadataEnvironments: EnvironmentMetadata[]
): ConfigDiscrepancy[] {
  const byName = new Map(metadataEnvironments.map((env) => [env.name, env]));
  const discrepancies: ConfigDiscrepancy[] = [];

  for (const env of environments) {
    const meta = byName.get(env.name);
    if (!meta) continue;

    if (env.board && meta.board && env.board !== meta.board) {
      discrepancies.push({
        environment: env.name,
        field: 'board',
        configValue: env.board,
        executionValue: meta.board,
      });
    }
    if (env.platform && meta.platform && env.platform !== meta.platform) {
      discrepancies.push({
        environment: env.name,
        field: 'platform',
        configValue: env.platform,
        executionValue: meta.platform,
      });
    }
    if (
      env.framework &&
      meta.framework &&
      meta.framework.length > 0 &&
      !meta.framework.includes(env.framework)
    ) {
      discrepancies.push({
        environment: env.name,
        field: 'framework',
        configValue: env.framework,
        executionValue: meta.framework.join(', '),
      });
    }
  }

  return discrepancies;
}

/** Reads platformio.ini, parses it, and reconciles with CLI metadata. */
export async function runInspectProject(
  input: InspectProjectInput
): Promise<ToolResponse<InspectProjectData | null>> {
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
    return errorResponse(
      reason,
      ['The target directory is not a PlatformIO project root.'],
      [
        'Verify the projectDir points at the folder containing platformio.ini.',
        'Run doctor to confirm the PlatformIO CLI is installed.',
      ]
    );
  }

  const config = parsePlatformIOIni(contents);
  const resolution = resolveEnvironment(config);
  const metadata = await loadProjectMetadata(input.projectDir);
  const discrepancies = metadata.available
    ? compareViews(config.environments, metadata.environments)
    : [];

  const warnings = [
    ...config.warnings,
    ...resolution.resolutionWarnings,
  ];
  if (!metadata.available && metadata.unavailableReason) {
    warnings.push(
      `Execution-truth metadata unavailable: ${metadata.unavailableReason} Reported values come from static parsing only.`
    );
  }
  if (discrepancies.length > 0) {
    warnings.push(
      `Static config disagrees with CLI metadata in ${discrepancies.length} field(s); trust the execution values.`
    );
  }

  const data: InspectProjectData = {
    projectDir: input.projectDir,
    configPresent: true,
    defaultEnvironments: config.defaultEnvironments,
    environments: config.environments,
    resolvedEnvironment: resolution.resolvedEnvironment,
    environmentResolution: resolution.environmentResolution,
    resolutionReason: resolution.resolutionReason,
    metadataAvailable: metadata.available,
    metadataUnavailableReason: metadata.unavailableReason,
    metadataEnvironments: metadata.environments,
    discrepancies,
    complexitySignals: config.complexitySignals,
    meta: {
      operationType: 'read',
      executionStatus: metadata.available ? 'succeeded' : 'partial',
      durationMs: Date.now() - startedAt,
    },
  };

  const nextActions: string[] = [];
  if (resolution.environmentResolution === 'ambiguous') {
    nextActions.push(
      'Specify an environment explicitly, or set default_envs in platformio.ini, before building or uploading.'
    );
  }
  if (!metadata.available) {
    nextActions.push(
      'Run doctor to diagnose why PlatformIO could not produce project metadata.'
    );
  }

  const status =
    warnings.length > 0 || !metadata.available ? 'warning' : 'ok';
  const envCount = config.environments.length;
  const summary =
    `Inspected ${input.projectDir}: ${envCount} environment(s), ` +
    `resolution=${resolution.environmentResolution}` +
    (resolution.resolvedEnvironment
      ? ` (${resolution.resolvedEnvironment}).`
      : '.');

  return buildResponse({ status, summary, data, warnings, nextActions });
}
