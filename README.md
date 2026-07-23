# Pioneer MCP

A board-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server that turns the [PlatformIO](https://platformio.org) Core CLI into a **structured execution layer** for AI agents.

Instead of making an agent parse raw CLI text, Pioneer inspects real PlatformIO projects, resolves environments, builds and uploads firmware, and monitors serial output — returning structured JSON with `status`, `summary`, `data`, `warnings`, and `nextActions`.

> **Status:** early development (`v0.1`). The tool surface and verification matrix are still growing. See [Scope](#scope) and [Verification boundary](#verification-boundary) for exactly what is and isn't claimed.

## Requirements

- **Node.js 18+**
- **[PlatformIO Core CLI](https://platformio.org/install/cli)** (`pip install platformio`, the official installer, or Homebrew)

Pioneer discovers the CLI from `PATH`, the `PLATFORMIO_CLI_PATH` environment variable, or the default `~/.platformio/penv` location — and works with both the `pio` and `platformio` command names.

## Quick start

```bash
npx -y pioneer-mcp
```

MCP client configuration (Claude Desktop, Cline, Cursor, etc.):

```json
{
  "mcpServers": {
    "pioneer": {
      "command": "npx",
      "args": ["-y", "pioneer-mcp"]
    }
  }
}
```

## Tools

Pioneer is being built up one vertical slice at a time. Currently available:

| Tool | Purpose |
|------|---------|
| `doctor` | Diagnose host readiness (CLI resolution, shell callability) with structured problem codes. No repairs. |
| `inspect_project` | Read-only. Parses `platformio.ini` and reconciles it with `pio project metadata` to report environments, the resolved default environment, config/execution discrepancies, and complexity signals. |
| `list_environments` | Read-only, config-only. Lists environments declared in `platformio.ini` plus the resolved default. Lightweight alternative to `inspect_project`. |
| `list_devices` | Read-only. Lists serial/USB devices visible to PlatformIO (port, description, hwid). |
| `list_boards` | Read-only. Searches the PlatformIO board catalog by query (id, name, platform, MCU); results capped with truncation reporting. |
| `build_project` | Compiles an environment (writes to `.pio/`, no hardware). Resolves the target environment and refuses ambiguous projects; reports RAM/Flash usage. |
| `clean_project` | Removes build artifacts for an environment (`pio run -t clean`). No hardware interaction. |
| `upload_firmware` | **Hardware-mutating.** Builds and flashes firmware to a connected board (`pio run -t upload`), optionally on a specific port. |
| `open_monitor_session` | Opens a persistent serial monitor and returns a `sessionId`. Persistence avoids re-resetting the board on every read. |
| `read_monitor_session` | Returns output from an open session — incremental (new lines) by default, or the full buffer with `fromStart`. Reports dropped lines and process exit. |
| `close_monitor_session` | Closes a session, kills its process, and releases the serial port. |

This completes the `v0.1` execution-layer tool set. Deferred to later releases: `get_board_info`, `init_project`, `generate_compile_commands`, library management, and MCP Apps inline UI for the monitor panel.

## Scope

Pioneer is intentionally an **execution layer**, not more:

- ✅ inspect project truth, build, upload, monitor
- ✅ structured, agent-consumable results
- ❌ not a workflow orchestrator
- ❌ not a generic terminal/shell
- ❌ not a remote-device platform

## Verification boundary

Honesty about what has actually been validated matters more than a long board list:

- Unit and in-memory end-to-end tests run with an injected process runner — **no real CLI or hardware required in CI**.
- Real-hardware closure is validated per board as physical devices become available; the README will state which boards have been directly validated versus CLI-only.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## License

[MIT](LICENSE) © Arrbel
