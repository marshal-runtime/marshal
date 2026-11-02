// Marshal-owned module.
import http from "node:http";

import { unlinkStaleSocket } from "./marshal-review-socket.ts";

export type Router = (
  method: string,
  path: string,
  body: unknown,
) => Promise<{ status: number; body: unknown }>;

export type StartOpts = {
  socketPath: string;
  router: Router;
  /** Called on router throws. Daemon wires this to `daemon.log`; tests omit it
   *  and the fallback writes to stderr. */
  onError?: (msg: string) => void;
};

export type RunningServer = {
  close(): Promise<void>;
};

export async function startHttpServer(opts: StartOpts): Promise<RunningServer> {
  await unlinkStaleSocket(opts.socketPath);

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }
      try {
        const out = await opts.router(req.method ?? "GET", req.url ?? "/", body);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      } catch (err: unknown) {
        // Generic message on the wire (CodeQL flagged the detailed shape as
        // info-exposure); detail goes to the daemon's log via onError.
        const detail = err instanceof Error ? err.message : String(err);
        const line = `[${new Date().toISOString()}] router error ${req.method} ${req.url}: ${detail}`;
        if (opts.onError) opts.onError(line);
        else process.stderr.write(line + "\n");
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => resolve());
  });

  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        await unlinkStaleSocket(opts.socketPath);
      }
    },
  };
}
