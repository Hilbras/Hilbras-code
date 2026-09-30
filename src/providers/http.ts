import type { ChatRequest, ChatResponse, Provider, StreamEvent } from "../types.ts";

/**
 * Minimal dependency-free HTTP streaming reader.
 *
 * Every provider in this repo needs SSE (or newline-delimited JSON) parsing;
 * pulling in a streaming client would be more code than writing it.
 */

export interface SseRequestOptions {
  url: string;
  method?: "POST" | "GET";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Abort when the socket has been idle this long (ms). 0 disables. */
  idleTimeoutMs?: number;
}

export interface SseMessage {
  event?: string;
  data: string;
}

/** Streaming POST that yields parsed SSE messages as they arrive. */
export async function* sseStream(options: SseRequestOptions): AsyncGenerator<SseMessage> {
  const { url, method = "POST", headers = {}, body, signal } = options;

  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncate(text, 2000)}`);
  }
  if (!response.body) throw new Error("response had no body (stream not supported)");

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; \r\n tolerated.
      let boundary = findBoundary(buffer);
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary.start);
        buffer = buffer.slice(boundary.end);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        boundary = findBoundary(buffer);
      }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Streaming POST that yields raw lines of newline-delimited JSON (Ollama style). */
export async function* ndjsonStream(options: SseRequestOptions): AsyncGenerator<{ data: string }> {
  const { url, method = "POST", headers = {}, body, signal } = options;

  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncate(text, 2000)}`);
  }
  if (!response.body) throw new Error("response had no body");

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") yield { data: line };
        newline = buffer.indexOf("\n");
      }
    }
    const last = buffer.trim();
    if (last !== "") yield { data: last };
  } finally {
    reader.cancel().catch(() => {});
  }
}

function findBoundary(buffer: string): { start: number; end: number } | -1 {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { start: crlf, end: crlf + 4 };
  }
  return { start: lf, end: lf + 2 };
}

function parseFrame(frame: string): SseMessage | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** One-shot JSON request with a helpful error on failure. */
export async function jsonRequest<T>(options: SseRequestOptions): Promise<T> {
  const response = await fetch(options.url, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const text = await safeReadText(response);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncate(text, 2000)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON from ${options.url}, got: ${truncate(text, 200)}`);
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more chars)`;
}

/** Tool-call IDs are only unique per response; prefix keeps transcripts stable. */
export function normaliseToolCallId(id: string, index: number): string {
  return id === "" ? `call_${index}` : id;
}

/** Shared helper: assert a request is well formed before spending tokens. */
export function assertNonEmpty(request: ChatRequest): void {
  if (request.messages.length === 0) {
    throw new Error("request has no messages");
  }
}
