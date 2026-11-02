import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { app } from "electron";

import { createLogger } from "../../../common/marshal-logger";
import { authErrors, makeAuthError } from "../../../common/telemetry/errors/marshal-auth";
import { getBundledCliPath } from "../../cli-path";
import { secureWriteFileSync } from "../../platform-security";
import { sendErrorTelemetry } from "../../telemetry-errors";
import { dynamicProp, RUNTIME_RULE_DENY_PERMISSION_RESULT } from "../local/internal";
import type { LocalRuntimeAuthStrategy } from "../local/strategy";
import type { RuntimeClient, RuntimeClientSession } from "../runtime-contract";
import type { AuthStatus, LoginResult } from "../types";
import { parseCopilotConfigDocument } from "./config/config-document";

const log = createLogger("CopilotAuth");
const execFileAsync = promisify(execFile);

export class CopilotAuthStrategy implements LocalRuntimeAuthStrategy {
  private activeLoginCancel: (() => void) | null = null;
  private cachedCopilotPlan: string | null = null;

  async augmentStatus(client: RuntimeClient, status: AuthStatus): Promise<AuthStatus> {
    if (!status.authenticated) return status;
    return {
      ...status,
      copilotPlan: await this.getCopilotPlan(client),
    };
  }

  async login(_credentials?: unknown): Promise<LoginResult> {
    this.activeLoginCancel?.();
    const cliPath = getBundledCliPath();
    return new Promise((resolve, reject) => {
      const proc = spawn(cliPath, ["login"], { stdio: ["pipe", "pipe", "pipe"] });
      let muted = false;
      const cancel = () => {
        muted = true;
        try {
          proc.kill();
        } catch {
          // Process already exited.
        }
      };
      this.activeLoginCancel = cancel;
      const clearCancel = () => {
        if (this.activeLoginCancel === cancel) this.activeLoginCancel = null;
      };
      const maxOutputBytes = 64 * 1024;
      const loginTimeoutMs = 30_000;
      const browserFlowTimeoutMs = 120_000;
      let output = "";
      let outputBytes = 0;
      let resolved = false;
      let capWarned = false;
      let browserFlowDetected = false;
      let completionResolve!: () => void;
      let completionReject!: (err: Error) => void;
      const completion = new Promise<void>((res, rej) => {
        completionResolve = res;
        completionReject = rej;
      });

      const rejectOnTimeout = () => {
        if (resolved) return;
        resolved = true;
        proc.kill();
        const err = new Error(
          `copilot login: no device code received within ${
            browserFlowDetected ? browserFlowTimeoutMs / 1000 : loginTimeoutMs / 1000
          }s${browserFlowDetected ? " (browser flow detected)" : ""}. CLI output so far: ${
            output.slice(0, 500) || "(empty)"
          }`,
        );
        sendErrorTelemetry(makeAuthError(authErrors.GITHUB_TOKEN_FAILED), err);
        reject(err);
      };
      let timer = setTimeout(() => {
        if (!muted) rejectOnTimeout();
      }, loginTimeoutMs);

      const onData = (data: Buffer) => {
        const remaining = maxOutputBytes - outputBytes;
        if (remaining <= 0) {
          if (!capWarned) {
            capWarned = true;
            log.warn(`copilot login: output exceeded ${maxOutputBytes} bytes; discarding the rest`);
          }
          return;
        }
        const chunk = data.length > remaining ? data.subarray(0, remaining) : data;
        const text = chunk.toString();
        outputBytes += chunk.length;
        output += text;
        log.info("copilot login output:", text.trim());

        const codeMatch = output.match(/code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
        const uriMatch = output.match(/(https:\/\/github\.com\/login\/device)/i);
        if (codeMatch && !resolved) {
          resolved = true;
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (muted) return;
            log.warn("copilot login: process still running after 2 min; killing it");
            proc.kill();
            const err = new Error("copilot login: process timed out after 2 min");
            sendErrorTelemetry(makeAuthError(authErrors.GITHUB_TOKEN_FAILED), err);
            completionReject(err);
          }, 120_000);
          resolve({
            deviceCode: codeMatch[1],
            verificationUri: uriMatch?.[1] || "https://github.com/login/device",
            completion,
          });
        }

        if (
          !browserFlowDetected &&
          /(?:opening\s+browser|localhost:\d+|oauth\s+callback)/i.test(output)
        ) {
          browserFlowDetected = true;
          clearTimeout(timer);
          timer = setTimeout(rejectOnTimeout, browserFlowTimeoutMs);
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("error", (err) => {
        clearTimeout(timer);
        clearCancel();
        if (!resolved) reject(err);
        else if (!muted) completionReject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        clearCancel();
        if (!resolved) {
          if (code === 0) resolve({});
          else {
            const err = new Error(`copilot login exited with code ${code}: ${output}`);
            sendErrorTelemetry(makeAuthError(authErrors.GITHUB_TOKEN_FAILED), err);
            reject(err);
          }
        } else if (!muted) {
          if (code === 0) completionResolve();
          else {
            const err = new Error(`copilot login exited with code ${code}`);
            sendErrorTelemetry(makeAuthError(authErrors.GITHUB_TOKEN_FAILED), err);
            completionReject(err);
          }
        }
      });
    });
  }

  async logout(): Promise<void> {
    this.activeLoginCancel?.();
    this.activeLoginCancel = null;
    this.cachedCopilotPlan = null;

    const configPath = path.join(app.getPath("home"), ".copilot", "config.json");
    try {
      if (fs.existsSync(configPath)) {
        const config = parseCopilotConfigDocument(fs.readFileSync(configPath, "utf-8"));
        delete config.logged_in_users;
        delete config.last_logged_in_user;
        secureWriteFileSync(configPath, JSON.stringify(config, null, 4), {
          encoding: "utf-8",
          mode: 0o600,
        });
        log.info("Cleared cached auth from config.json");
      }
    } catch (err) {
      log.error("Failed to clear config.json auth:", err);
    }

    for (const service of ["copilot-cli"]) {
      try {
        if (process.platform === "darwin") {
          // eslint-disable-next-line no-await-in-loop -- one credential service, kept sequential
          await execFileAsync("security", ["delete-generic-password", "-s", service], {
            windowsHide: true,
            timeout: 5_000,
          });
        } else if (process.platform === "win32") {
          try {
            // eslint-disable-next-line no-await-in-loop -- one credential service, kept sequential
            await execFileAsync("cmdkey", [`/delete:${service}`], {
              windowsHide: true,
              timeout: 5_000,
            });
          } catch {
            try {
              // eslint-disable-next-line no-await-in-loop -- one credential service, kept sequential
              const { stdout } = await execFileAsync("cmdkey", ["/list"], {
                windowsHide: true,
                timeout: 5_000,
              });
              const targets = stdout
                .split(/\r?\n/)
                .map((line) => line.match(/Target:\s*(.*)/)?.[1]?.trim())
                .filter(
                  (target): target is string =>
                    !!target && target.toLowerCase().includes(service.toLowerCase()),
                );
              for (const target of targets) {
                // eslint-disable-next-line no-await-in-loop -- credential deletion is intentionally sequential
                await execFileAsync("cmdkey", [`/delete:${target}`], {
                  windowsHide: true,
                  timeout: 5_000,
                });
              }
            } catch {
              // Missing credential is non-fatal.
            }
          }
        }
      } catch {
        // Missing credential is non-fatal.
      }
    }
  }

  cancelPendingLogin(): void {
    this.activeLoginCancel?.();
    this.activeLoginCancel = null;
  }

  clearCachedState(): void {
    this.cachedCopilotPlan = null;
  }

  private async getCopilotPlan(client: RuntimeClient): Promise<string | undefined> {
    if (this.cachedCopilotPlan) return this.cachedCopilotPlan;
    let session: RuntimeClientSession | null = null;
    try {
      session = await client.createSession({
        cwd: os.tmpdir(),
        onPermissionRequest: () => RUNTIME_RULE_DENY_PERMISSION_RESULT,
      });
      const getStatus = dynamicProp(session.rpc?.auth, "getStatus");
      const status = typeof getStatus === "function" ? await getStatus() : undefined;
      const plan = dynamicProp(status, "copilotPlan");
      if (plan !== undefined && typeof plan !== "string") return undefined;
      if (plan) this.cachedCopilotPlan = plan;
      return plan;
    } catch (err) {
      log.warn("Copilot plan probe failed:", err);
      return undefined;
    } finally {
      if (session) {
        try {
          await session.destroy();
          await client.deleteSession(session.sessionId);
        } catch (err) {
          log.warn("Failed to clean up plan-probe session:", err);
        }
      }
    }
  }
}
