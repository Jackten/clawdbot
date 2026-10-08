import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost({});
});

describe("OpenAI ChatGPT Responses resource limits", () => {
  it("bounds non-OK response bodies before formatting API errors", async () => {
    const byteLimit = 16 * 1024;
    const totalChunks = 32;
    const prefix = "usage limit ";
    const chunk = new TextEncoder().encode(
      `${prefix}${"x".repeat(byteLimit - prefix.length - 2)}😀tail`,
    );
    let pullCount = 0;
    let canceled = false;
    const overflowing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount > totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(overflowing, { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("usage limit");
    expect(result.errorMessage).not.toContain("�");
    expect(result.errorMessage).not.toContain("tail");
    expect(result.errorMessage?.length).toBeLessThanOrEqual(byteLimit);
    expect(canceled).toBe(true);
    expect(pullCount).toBeGreaterThanOrEqual(1);
    expect(pullCount).toBeLessThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts well-framed success streams whose total size exceeds the pending-frame bound", async () => {
    // Long reasoning turns legitimately stream more than 16 MiB in total; only
    // a single unterminated frame should be bounded.
    const pad = "x".repeat(64 * 1024);
    const progressFrame = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "response.in_progress", pad })}\n\n`,
    );
    const completedFrame = new TextEncoder().encode(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_long",
          status: "completed",
          output: [],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      })}\n\n`,
    );
    const progressFrames = 320; // ~20 MiB total
    let sent = 0;
    const longStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < progressFrames) {
          sent += 1;
          controller.enqueue(progressFrame);
          return;
        }
        controller.enqueue(completedFrame);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(longStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "sse",
    }).result();

    expect(sent * progressFrame.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
  });

  it("bounds an unterminated streamed success frame without content-length", async () => {
    // 1 MiB chunks with no frame boundary; the pending-frame bound is 16 MiB so
    // the reader cancels well before draining the full 32 MiB body.
    const chunkBytes = 1024 * 1024;
    const totalChunks = 32;
    let pullCount = 0;
    let cancelReason: unknown;
    const overflowing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount > totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(overflowing, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /OpenAI ChatGPT Responses SSE response exceeded max pending buffer size \(16777216 chars\)/,
    );
    expect(cancelReason).toBeInstanceOf(Error);
    expect(pullCount).toBeGreaterThanOrEqual(17);
    expect(pullCount).toBeLessThanOrEqual(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
