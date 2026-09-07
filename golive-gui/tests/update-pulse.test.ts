import { describe, expect, it } from "vitest";
import { UPDATE_STREAM_URL, UpdatePulseClient } from "../electron/update-pulse";

class FakeResponse {
  public statusCode = 200;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  public setEncoding(): void {}

  public on(event: string, listener: (...args: any[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  public resume(): void {}

  public emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeRequest {
  public destroyed = false;
  public ended = false;
  private errorListener: ((error: Error) => void) | null = null;

  public on(event: "error", listener: (error: Error) => void): this {
    if (event === "error") this.errorListener = listener;
    return this;
  }

  public setTimeout(): this {
    return this;
  }

  public end(): void {
    this.ended = true;
  }

  public destroy(): void {
    this.destroyed = true;
  }

  public fail(): void {
    this.errorListener?.(new Error("offline"));
  }
}

function manualTimers() {
  const callbacks: Array<() => void> = [];
  const setTimeoutFn = ((callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as typeof clearTimeout;
  return { callbacks, setTimeoutFn, clearTimeoutFn };
}

describe("UpdatePulseClient", () => {
  it("envia headers SSE e interpreta releases mesmo quando o evento chega em pedaços", () => {
    const responses: FakeResponse[] = [];
    const requests: FakeRequest[] = [];
    const received: unknown[] = [];
    const timers = manualTimers();

    const client = new UpdatePulseClient({
      onRelease: (event) => received.push(event),
      request: ((url, options, callback) => {
        expect(url.toString()).toBe(UPDATE_STREAM_URL);
        expect(options.headers.Accept).toBe("text/event-stream");
        const request = new FakeRequest();
        const response = new FakeResponse();
        requests.push(request);
        responses.push(response);
        callback(response);
        return request;
      }) as never,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    client.start();
    expect(requests[0]?.ended).toBe(true);
    responses[0]?.emit("data", ": heartbeat\r\nevent: relea");
    responses[0]?.emit("data", "se\r\nid: delivery-42\r\ndata: {\"tag\":\"v2.0.6\",");
    responses[0]?.emit("data", "\"prerelease\":false,\"published_at\":\"2026-09-07T12:00:00Z\"}\r\n\r\n");

    expect(received).toEqual([
      {
        deliveryId: "delivery-42",
        tag: "v2.0.6",
        prerelease: false,
        publishedAt: "2026-09-07T12:00:00Z",
      },
    ]);
  });

  it("reconecta com backoff apos a queda e para sem abrir nova conexao", () => {
    const requests: FakeRequest[] = [];
    const timers = manualTimers();
    let requestCount = 0;

    const client = new UpdatePulseClient({
      onRelease: () => {},
      request: ((_, __, callback) => {
        requestCount += 1;
        const request = new FakeRequest();
        requests.push(request);
        callback(new FakeResponse());
        return request;
      }) as never,
      reconnectDelaysMs: [10, 20],
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    client.start();
    expect(requestCount).toBe(1);
    requests[0]?.fail();
    expect(timers.callbacks).toHaveLength(1);
    timers.callbacks.shift()?.();
    expect(requestCount).toBe(2);

    client.stop();
    expect(requests[1]?.destroyed).toBe(true);
    requests[1]?.fail();
    timers.callbacks.shift()?.();
    expect(requestCount).toBe(2);
  });

  it("ignora payload invalido e eventos que nao sao release", () => {
    const response = new FakeResponse();
    const received: unknown[] = [];
    const request = new FakeRequest();
    const timers = manualTimers();

    const client = new UpdatePulseClient({
      onRelease: (event) => received.push(event),
      request: ((_, __, callback) => {
        callback(response);
        return request;
      }) as never,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    client.start();
    response.emit("data", "event: ping\nid: ignored\ndata: {}\n\n");
    response.emit("data", "event: release\nid: malformed\ndata: nope\n\n");
    response.emit("data", "event: release\nid: missing-tag\ndata: {\"prerelease\":false}\n\n");
    expect(received).toEqual([]);
  });
});
