import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";

// Bound one unterminated SSE frame, not the whole stream: long reasoning turns
// legitimately stream far more than this in total across many small events.
const OPENAI_CHATGPT_RESPONSES_SSE_PENDING_BUFFER_MAX_CHARS = 16 * 1024 * 1024;

export class CodexProtocolError extends Error {
  readonly payload?: unknown;

  constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
    super(message);
    this.name = "CodexProtocolError";
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

export async function* parseOpenAIChatGptResponsesSse(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  let cancelled = false;
  const cancelReaderBestEffort = (reason?: unknown): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    // Upstream cancellation may never settle; cleanup cannot gate the primary outcome.
    void reader.cancel(reason).catch(() => undefined);
  };
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        buffer += decoder.decode();
      }

      while (true) {
        // Defer a possible CRLF only when CR does not already complete a blank line.
        const deferTrailingCr =
          !done && buffer.endsWith("\r") && !buffer.endsWith("\r\r") && !buffer.endsWith("\n\r");
        const searchable = deferTrailingCr ? buffer.slice(0, -1) : buffer;
        // A CRLF is one line ending: never backtrack its CR into a false blank line.
        const boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(searchable);
        if (!boundary && (!done || buffer.length === 0)) {
          break;
        }
        // EOF completes the remaining frame even without a blank-line delimiter.
        const chunk = boundary ? buffer.slice(0, boundary.index) : buffer;
        buffer = boundary ? buffer.slice(boundary.index + boundary[0].length) : "";

        const dataLines = chunk
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch (cause) {
              if (!(cause instanceof SyntaxError)) {
                throw cause;
              }
              throw new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause });
            }
            // Keep suspension outside the parse catch so consumer failures stay consumer-owned.
            yield event;
          }
        }
      }

      if (done) {
        break;
      }
      // Only an unterminated frame remains buffered; a hostile endpoint that never
      // emits a frame boundary cannot exhaust memory.
      if (buffer.length > OPENAI_CHATGPT_RESPONSES_SSE_PENDING_BUFFER_MAX_CHARS) {
        const error = new Error(
          `OpenAI ChatGPT Responses SSE response exceeded max pending buffer size (${OPENAI_CHATGPT_RESPONSES_SSE_PENDING_BUFFER_MAX_CHARS} chars) without event boundary`,
        );
        cancelReaderBestEffort(error);
        throw error;
      }
    }
  } finally {
    cancelReaderBestEffort();
    try {
      reader.releaseLock();
    } catch {}
  }
}

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}
