import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexEnvironment,
  defaultCodexHome,
  resolveCodexExecutable,
  resolveCodexInstallation,
  spawnCodexAppServer,
  type CodexSpawnFunction,
} from "./process";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter();
  Reflect.set(child, "stdin", new PassThrough());
  Reflect.set(child, "stdout", new PassThrough());
  Reflect.set(child, "stderr", new PassThrough());
  Reflect.set(child, "pid", 123);
  Reflect.set(child, "kill", () => true);
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- process factory fixture supplies the ChildProcess subset consumed by production code
  return child as ChildProcessWithoutNullStreams;
}

describe("Codex process factory", () => {
  it("resolves the exact native executable from the official package", () => {
    const executable = resolveCodexExecutable();
    expect(path.isAbsolute(executable)).toBe(true);
    expect(path.basename(executable)).toBe(process.platform === "win32" ? "codex.exe" : "codex");
  });

  it("resolves the Windows development package layout and manifest", () => {
    const packageJson = "C:\\repo\\node_modules\\@openai\\codex-win32-x64\\package.json";
    const executable =
      "C:\\repo\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
    const manifest =
      "C:\\repo\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex-package.json";
    const files = new Set([executable, manifest]);

    expect(
      resolveCodexInstallation({
        platform: "win32",
        arch: "x64",
        isPackaged: false,
        resolvePackageJson: (specifier) => {
          if (specifier === "@openai/codex-win32-x64/package.json") return packageJson;
          throw new Error("not installed");
        },
        canonicalizePath: (candidate) => candidate,
        pathExists: (candidate) => files.has(candidate),
      }),
    ).toMatchObject({
      executablePath: executable,
      packageManifestPath: manifest,
    });
  });

  it("does not infer packaged mode from resourcesPath alone", () => {
    const packageJson = "/repo/node_modules/@openai/codex-linux-x64/package.json";
    const targetRoot =
      "/repo/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl";
    const files = new Set([`${targetRoot}/bin/codex`, `${targetRoot}/codex-package.json`]);

    expect(
      resolveCodexInstallation({
        platform: "linux",
        arch: "x64",
        resourcesPath: "/electron/dev/resources",
        resolvePackageJson: (specifier) => {
          if (specifier === "@openai/codex-linux-x64/package.json") return packageJson;
          throw new Error("not installed");
        },
        canonicalizePath: (candidate) => candidate,
        pathExists: (candidate) => files.has(candidate),
      }).packageRoot,
    ).toBe("/repo/node_modules/@openai/codex-linux-x64");
  });

  it("prefers the packaged macOS AMFI app wrapper and preserves the manifest", () => {
    const resourcesPath = "/Applications/Marshal.app/Contents/Resources";
    const packageRoot =
      "/Applications/Marshal.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64";
    const targetRoot = `${packageRoot}/vendor/aarch64-apple-darwin`;
    const wrapper = `${targetRoot}/bin/codex.app/Contents/MacOS/codex`;
    const raw = `${targetRoot}/bin/codex`;
    const manifest = `${targetRoot}/codex-package.json`;
    const files = new Set([wrapper, raw, manifest]);

    expect(
      resolveCodexInstallation({
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        resourcesPath,
        pathExists: (candidate) => files.has(candidate),
      }),
    ).toEqual({
      executablePath: wrapper,
      packageManifestPath: manifest,
      packageRoot,
      targetRoot,
    });
  });

  it("resolves the packaged Linux target path", () => {
    const resourcesPath = "/opt/marshal/resources";
    const packageRoot =
      "/opt/marshal/resources/app.asar.unpacked/node_modules/@openai/codex-linux-x64";
    const targetRoot = `${packageRoot}/vendor/x86_64-unknown-linux-musl`;
    const executable = `${targetRoot}/bin/codex`;
    const manifest = `${targetRoot}/codex-package.json`;
    const files = new Set([executable, manifest]);

    expect(
      resolveCodexInstallation({
        platform: "linux",
        arch: "x64",
        isPackaged: true,
        resourcesPath,
        pathExists: (candidate) => files.has(candidate),
      }),
    ).toMatchObject({
      executablePath: executable,
      packageManifestPath: manifest,
    });
  });

  it("rejects an installation with a missing native executable", () => {
    const packageJson = "/repo/node_modules/@openai/codex-linux-x64/package.json";
    const manifest =
      "/repo/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-package.json";

    expect(() =>
      resolveCodexInstallation({
        platform: "linux",
        arch: "x64",
        isPackaged: false,
        resolvePackageJson: (specifier) => {
          if (specifier === "@openai/codex-linux-x64/package.json") return packageJson;
          throw new Error("not installed");
        },
        canonicalizePath: (candidate) => candidate,
        pathExists: (candidate) => candidate === manifest,
      }),
    ).toThrow("Codex executable is missing");
  });

  it("rejects an installation with a missing codex-package manifest", () => {
    const packageJson = "/repo/node_modules/@openai/codex-linux-x64/package.json";
    const executable =
      "/repo/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";

    expect(() =>
      resolveCodexInstallation({
        platform: "linux",
        arch: "x64",
        isPackaged: false,
        resolvePackageJson: (specifier) => {
          if (specifier === "@openai/codex-linux-x64/package.json") return packageJson;
          throw new Error("not installed");
        },
        canonicalizePath: (candidate) => candidate,
        pathExists: (candidate) => candidate === executable,
      }),
    ).toThrow("Codex package manifest is missing");
  });

  it("isolates CODEX_HOME and strips inherited secrets and injection variables", () => {
    const env = buildCodexEnvironment("C:\\isolated", {
      ...process.env,
      PATH: "C:\\bin",
      CODEX_HOME: "C:\\user\\.codex",
      NODE_OPTIONS: "--require bad.js",
      OPENAI_API_KEY: "secret",
      CHATGPT_ACCESS_TOKEN: "secret",
      GIT_ASKPASS: "helper",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "alias.status",
      GIT_CONFIG_VALUE_0: "!malicious",
    });

    expect(env).toMatchObject({
      PATH: "C:\\bin",
      CODEX_HOME: "C:\\isolated",
      LOG_FORMAT: "json",
      RUST_LOG: "warn",
      GIT_PAGER: "",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CHATGPT_ACCESS_TOKEN).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBe("blame");
    expect(Number(env.GIT_CONFIG_COUNT)).toBeGreaterThan(1);
  });

  it("prepends package-managed helper paths for wrapped macOS binaries", () => {
    const env = buildCodexEnvironment(
      "/isolated",
      { ...process.env, PATH: "/usr/bin" },
      { platform: "darwin", pathDirs: ["/package/codex-path"] },
    );

    expect(env.PATH).toBe("/package/codex-path:/usr/bin");
  });

  it("spawns app-server over stdio with an absolute path and hidden Windows console", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marshal-codex-process-"));
    tempDirs.push(root);
    const workspaceDir = path.join(root, "workspace");
    const codexHome = path.join(root, "codex-home");
    const executablePath = path.join(root, process.platform === "win32" ? "codex.exe" : "codex");
    const windowsRunnerPath = path.resolve("sidecar", "node-runner.exe");
    let captured:
      | {
          executable: string;
          args: readonly string[];
          options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] };
        }
      | undefined;
    const spawnProcess: CodexSpawnFunction = (executable, args, options) => {
      captured = { executable, args, options };
      return fakeChild();
    };

    await spawnCodexAppServer({
      workspaceDir,
      codexHome,
      executablePath,
      platform: "win32",
      windowsRunnerPath,
      spawnProcess,
      env: { ...process.env, PATH: "C:\\bin" },
    });

    expect(captured).toMatchObject({
      executable: windowsRunnerPath,
      args: [executablePath, "app-server", "--stdio"],
      options: {
        cwd: path.resolve(workspaceDir),
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    });
    expect(captured?.options.env?.CODEX_HOME).toBe(path.resolve(codexHome));
  });

  it("uses a Marshal-owned default home rather than the user Codex home", () => {
    expect(defaultCodexHome()).toBe(path.join(os.homedir(), ".marshal", "marshal-codex"));
  });
});
