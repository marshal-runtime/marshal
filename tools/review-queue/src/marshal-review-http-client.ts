// Marshal-owned module.
import http from "node:http";

export type RequestOpts = {
  socketPath: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
};

export type Response = { status: number; body: string };

export function httpRequest(opts: RequestOpts): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        socketPath: opts.socketPath,
        path: opts.path,
        method: opts.method,
        headers: data
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
