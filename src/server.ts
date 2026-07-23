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
import {
  listEnvironmentsInputSchema,
  runListEnvironments,
} from './tools/list-environments.js';
import { listDevicesInputSchema, runListDevices } from './tools/list-devices.js';
import { listBoardsInputSchema, runListBoards } from './tools/list-boards.js';
import { buildProjectInputSchema, runBuildProject } from './tools/build-project.js';
import { cleanProjectInputSchema, runCleanProject } from './tools/clean-project.js';
import {
  uploadFirmwareInputSchema,
  runUploadFirmware,
} from './tools/upload-firmware.js';
import {
  openMonitorSessionInputSchema,
  runOpenMonitorSession,
  readMonitorSessionInputSchema,
  runReadMonitorSession,
  closeMonitorSessionInputSchema,
  runCloseMonitorSession,
} from './tools/monitor-session.js';

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

  server.registerTool(
    'list_environments',
    {
      title: 'List PlatformIO environments',
      description:
        'Read-only, config-only. Lists environments declared in platformio.ini plus the resolved default. ' +
        'Lightweight alternative to inspect_project when execution-truth reconciliation is not needed.',
      inputSchema: listEnvironmentsInputSchema.shape,
    },
    async (args) => toMcpContent(await runListEnvironments(args))
  );

  server.registerTool(
    'list_devices',
    {
      title: 'List connected serial devices',
      description:
        'Read-only. Lists serial/USB devices visible to PlatformIO (port, description, hwid). ' +
        'Use to pick an upload/monitor port and confirm a board is connected.',
      inputSchema: listDevicesInputSchema.shape,
    },
    async () => toMcpContent(await runListDevices())
  );

  server.registerTool(
    'list_boards',
    {
      title: 'Search the PlatformIO board catalog',
      description:
        'Read-only. Searches the PlatformIO board catalog by query (board id, name, platform, or MCU). ' +
        'Provide a query to narrow the large catalog; results are capped and report truncation.',
      inputSchema: listBoardsInputSchema.shape,
    },
    async (args) => toMcpContent(await runListBoards(args))
  );

  server.registerTool(
    'build_project',
    {
      title: 'Build a PlatformIO environment',
      description:
        'Compiles an environment (writes artifacts to .pio/; no hardware interaction). Resolves the target ' +
        'environment from platformio.ini when not given and refuses ambiguous projects. Reports compile ' +
        'success and RAM/Flash usage.',
      inputSchema: buildProjectInputSchema.shape,
    },
    async (args) => toMcpContent(await runBuildProject(args))
  );

  server.registerTool(
    'clean_project',
    {
      title: 'Clean build artifacts',
      description:
        'Removes build artifacts for an environment (pio run -t clean). Touches only the project .pio output; ' +
        'no hardware interaction. Refuses ambiguous environment resolution.',
      inputSchema: cleanProjectInputSchema.shape,
    },
    async (args) => toMcpContent(await runCleanProject(args))
  );

  server.registerTool(
    'upload_firmware',
    {
      title: 'Upload firmware to a board',
      description:
        'HARDWARE-MUTATING: builds and flashes firmware to a connected board (pio run -t upload). Writes to a ' +
        'physical device. Resolves the environment (refusing ambiguous projects); optionally targets a specific ' +
        'upload port. Discover ports with list_devices.',
      inputSchema: uploadFirmwareInputSchema.shape,
    },
    async (args) => toMcpContent(await runUploadFirmware(args))
  );

  server.registerTool(
    'open_monitor_session',
    {
      title: 'Open a persistent serial monitor',
      description:
        'Opens a long-lived serial monitor on a port and returns a sessionId. Because opening the port resets ' +
        'most boards, a persistent session lets you read output over time without re-resetting on each read. ' +
        'Pair with read_monitor_session and close_monitor_session.',
      inputSchema: openMonitorSessionInputSchema.shape,
    },
    async (args) => toMcpContent(await runOpenMonitorSession(args))
  );

  server.registerTool(
    'read_monitor_session',
    {
      title: 'Read from a monitor session',
      description:
        'Returns output collected by an open monitor session. By default returns only lines since the last ' +
        'read; pass fromStart for the full retained buffer. Reports dropped lines and process exit.',
      inputSchema: readMonitorSessionInputSchema.shape,
    },
    async (args) => toMcpContent(await runReadMonitorSession(args))
  );

  server.registerTool(
    'close_monitor_session',
    {
      title: 'Close a monitor session',
      description:
        'Closes a monitor session, kills its process, and releases the serial port. Always call when finished ' +
        'so the port is free for upload or other tools.',
      inputSchema: closeMonitorSessionInputSchema.shape,
    },
    async (args) => toMcpContent(await runCloseMonitorSession(args))
  );

  return server;
}
