import { request as nodeRequest } from "https";

export const UPDATE_STREAM_URL = "https://api.skyplaceia.com/bugs/v1/updates/stream";

export type UpdatePulseEvent = {
  deliveryId: string;
  tag: string;
  prerelease: boolean;
  publishedAt?: string;
};

type PulseResponse = {
  statusCode?: number;
  setEncoding(encoding: string): void;
  on(event: "data", listener: (chunk: string) => void): PulseResponse;
  on(event: "end" | "error", listener: (error?: Error) => void): PulseResponse;
  resume(): void;
  destroy?: () => void;
};

type PulseRequest = {
  on(event: "error", listener: (error: Error) => void): PulseRequest;
  setTimeout(timeout: number, listener: () => void): PulseRequest;
  end(): void;
  destroy(error?: Error): void;
};

type RequestFn = (
  url: URL,
  options: { headers: Record<string, string> },
  callback: (response: PulseResponse) => void,
) => PulseRequest;

export type UpdatePulseOptions = {
  url?: string;
  onRelease: (event: UpdatePulseEvent) => void;
  request?: RequestFn;
  reconnectDelaysMs?: readonly number[];
  requestTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

const defaultRequest: RequestFn = (url, options, callback) =>
  nodeRequest(url, options, callback);

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 300_000] as const;

function parseReleaseEvent(block: string): UpdatePulseEvent | null {
  let eventName = "";
  let deliveryId = "";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";

    if (field === "event") eventName = value.trim();
    else if (field === "id") deliveryId = value.trim();
    else if (field === "data") data.push(value);
  }

  if (eventName !== "release" || data.length === 0 || deliveryId.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(data.join("\n")) as {
      tag?: unknown;
      prerelease?: unknown;
      published_at?: unknown;
    };

    if (typeof parsed.tag !== "string" || typeof parsed.prerelease !== "boolean") {
      return null;
    }

    return {
      deliveryId,
      tag: parsed.tag,
      prerelease: parsed.prerelease,
      ...(typeof parsed.published_at === "string" ? { publishedAt: parsed.published_at } : {}),
    };
  } catch {
    return null;
  }
}

export class UpdatePulseClient {
  private readonly url: string;
  private readonly onRelease: (event: UpdatePulseEvent) => void;
  private readonly requestFn: RequestFn;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly requestTimeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private requestHandle?: PulseRequest;
  private response?: PulseResponse;

  public constructor(options: UpdatePulseOptions) {
    this.url = options.url ?? UPDATE_STREAM_URL;
    this.onRelease = options.onRelease;
    this.requestFn = options.request ?? defaultRequest;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  public start(): void {
    if (!this.stopped) return;

    this.stopped = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.requestHandle?.destroy();
    this.response?.destroy?.();
    this.requestHandle = undefined;
    this.response = undefined;
  }

  private connect(): void {
    if (this.stopped) return;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const requestHandle = this.requestHandle;
      const response = this.response;
      this.requestHandle = undefined;
      this.response = undefined;
      requestHandle?.destroy();
      response?.destroy?.();
      this.scheduleReconnect();
    };

    try {
      const requestHandle = this.requestFn(
        new URL(this.url),
        {
          headers: {
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
            "User-Agent": "GoLiveBypass-updater",
          },
        },
        (response) => {
          if (this.stopped) {
            response.resume();
            return;
          }

          this.response = response;
          if (response.statusCode !== 200) {
            response.resume();
            finish();
            return;
          }

          this.reconnectAttempt = 0;
          let buffer = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            buffer += chunk;
            buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

            let separator = buffer.indexOf("\n\n");
            while (separator >= 0) {
              const block = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              const event = parseReleaseEvent(block);
              if (event) {
                try {
                  this.onRelease(event);
                } catch {
                  // A listener failure must not kill the long-lived stream.
                }
              }
              separator = buffer.indexOf("\n\n");
            }
          });
          response.on("end", finish);
          response.on("error", finish);
        },
      );

      this.requestHandle = requestHandle;
      if (finished) {
        requestHandle.destroy();
        return;
      }
      requestHandle.on("error", () => finish());
      requestHandle.setTimeout(this.requestTimeoutMs, () => finish());
      requestHandle.end();
    } catch {
      finish();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const delay =
      this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)] ?? 60_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}

export function createUpdatePulseClient(options: UpdatePulseOptions): UpdatePulseClient {
  return new UpdatePulseClient(options);
}
