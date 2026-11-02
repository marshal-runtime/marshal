import http from "http";
import https from "https";
class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Uses only Node modules supported by the Runtime extension loader. No redirect forwarding. */
export class CloudClient {
  private readonly base: URL;
  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.base = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname);
    if (
      (this.base.protocol !== "https:" && !(local && this.base.protocol === "http:")) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/"
    )
      throw new Error("Service URL must be an HTTPS origin, or loopback HTTP for development");
  }
  request<T = unknown>(method: string, route: string, input?: unknown): Promise<T> {
    const url = new URL(route, this.base);
    if (url.origin !== this.base.origin) throw new Error("Cross-origin request refused");
    return new Promise((resolve, reject) => {
      const payload = input === undefined ? undefined : JSON.stringify(input);
      const request = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) {
              request.destroy(new Error("Response exceeds 32 MiB"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); // SF-4: response from the configured cloud API, failures are rejected in the catch below
              if ((response.statusCode ?? 500) >= 300) {
                reject(
                  new CloudError(
                    response.statusCode ?? 500,
                    value.error?.code ?? "request_failed",
                    value.error?.message ?? "Cloud request failed",
                  ),
                );
              } else resolve(value);
            } catch {
              reject(new Error("Invalid cloud response"));
            }
          });
        },
      );
      request.setTimeout(15_000, () =>
        request.destroy(
          new Error("Cloud request timed out; check status before retrying a mutation"),
        ),
      );
      request.on("error", reject);
      request.end(payload);
    });
  }
}
