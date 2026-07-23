#!/usr/bin/env node

/**
 * Pioneer MCP — entry point.
 *
 * A board-agnostic Model Context Protocol server that turns the PlatformIO
 * Core CLI into a structured execution layer for AI agents.
 */

import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { resolvePioBinary } from './pio/exec.js';
import { closeAllSessions } from './pio/monitor.js';

async function main(): Promise<void> {
  const cliPath = await resolvePioBinary();
  if (!cliPath) {
    console.error(
      'Warning: PlatformIO CLI not found. Install from https://platformio.org/install/cli'
    );
    console.error(
      'The server will start, but commands will fail until it is available.\n'
    );
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Release any open serial ports if the process is asked to stop.
  const shutdown = (): void => {
    closeAllSessions();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.error('Pioneer MCP server running on stdio');
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
