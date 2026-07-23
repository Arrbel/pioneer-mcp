/**
 * Unified response envelope for all Pioneer MCP tools.
 *
 * Every tool returns the same top-level shape so that an AI agent can consume
 * results without bespoke per-tool parsing. Tool-specific payloads live under
 * `data`; cross-cutting execution metadata lives under `data.meta`.
 */

/** High-level outcome of a tool invocation. */
export type ToolStatus = 'ok' | 'warning' | 'error';

/** What kind of operation a tool performed. */
export type OperationType =
  'diagnostic' | 'read' | 'build' | 'upload' | 'monitor' | 'package';

/** Whether the underlying execution succeeded, partially succeeded, or failed. */
export type ExecutionStatus = 'succeeded' | 'partial' | 'failed' | 'skipped';

/**
 * Shared execution metadata attached to every tool payload as `data.meta`.
 * High-level consumers can rely on these fields regardless of the tool.
 */
export interface ExecutionResultMeta {
  operationType: OperationType;
  executionStatus: ExecutionStatus;
  /** Machine-readable failure bucket, when execution did not fully succeed. */
  failureCategory?: string;
  /** Short, actionable hint for what to try next on failure. */
  retryHint?: string;
  /** Wall-clock duration of the underlying operation in milliseconds. */
  durationMs?: number;
}

/** The canonical envelope returned by every Pioneer MCP tool. */
export interface ToolResponse<TData = unknown> {
  status: ToolStatus;
  summary: string;
  data: TData | null;
  warnings: string[];
  nextActions: string[];
}

/** Options for building a successful/partial tool response. */
export interface BuildResponseOptions<TData> {
  status: ToolStatus;
  summary: string;
  data: TData;
  warnings?: string[];
  nextActions?: string[];
}

/** Constructs a normalized tool response with defaulted optional arrays. */
export function buildResponse<TData>(
  options: BuildResponseOptions<TData>
): ToolResponse<TData> {
  return {
    status: options.status,
    summary: options.summary,
    data: options.data,
    warnings: options.warnings ?? [],
    nextActions: options.nextActions ?? [],
  };
}

/** Constructs a normalized error response with a null payload. */
export function errorResponse(
  summary: string,
  warnings: string[] = [],
  nextActions: string[] = []
): ToolResponse<null> {
  return {
    status: 'error',
    summary,
    data: null,
    warnings,
    nextActions,
  };
}

/**
 * Serializes a tool response into the MCP text content payload shape.
 * Centralized so every tool emits identical structure.
 */
export function toMcpContent(response: ToolResponse): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  const payload = {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
  return response.status === 'error' ? { ...payload, isError: true } : payload;
}
