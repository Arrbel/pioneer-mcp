/**
 * Pioneer MCP server construction.
 *
 * Uses the modern @modelcontextprotocol/sdk (1.x) McpServer + registerTool
 * API. Each tool registers its own Zod input schema and returns the unified
 * response envelope, serialized through toMcpContent.
 */

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toMcpContent } from './result.js';
import { doctorInputSchema, runDoctor } from './tools/doctor.js';
import {
  inspectProjectInputSchema,
  runInspectProject,
} from './tools/inspect-project.js';

/** Reads the server version from package.json at runtime. */
export function readServerVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Builds and returns a fully configured (but not yet connected) server. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'pioneer-mcp',
    version: readServerVersion(),
  });

  server.registerTool(
    'doctor',
    {
      title: 'Diagnose host readiness',
      description:
        'Diagnose whether the host is ready to run PlatformIO (CLI resolution, shell callability). ' +
        'Recommended first call. Reports structured problem codes; performs no repairs.',
      inputSchema: doctorInputSchema.shape,
    },
    async () => toMcpContent(await runDoctor())
  );

  server.registerTool(
    'inspect_project',
    {
      title: 'Inspect a PlatformIO project',
      description:
        'Read-only. Parses platformio.ini and reconciles it with `pio project metadata` to report ' +
        'environments, the resolved default environment, config/execution discrepancies, and complexity ' +
        'signals. Call before any build/upload to act on a known project state. Performs no changes.',
      inputSchema: inspectProjectInputSchema.shape,
    },
    async (args) => toMcpContent(await runInspectProject(args))
  );

  return server;
}
