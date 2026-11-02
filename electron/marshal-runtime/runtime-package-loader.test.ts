import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MARSHAL_RUNTIME_LOCAL_ENV, MARSHAL_RUNTIME_SOURCE_ENV } from "./local-source";
import { PinnedMarshalRuntimePackageLoader } from "./runtime-package-loader";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(
  source: string,
): Promise<{ readonly appPath: string; readonly entryPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "marshal-runtime-loader-test-"));
  tempDirectories.push(root);
  const appPath = path.join(root, "app");
  const packageRoot = path.join(root, "runtime-source");
  const entryPath = path.join(packageRoot, "dist", "host.js");
  const packageLink = path.join(appPath, "node_modules", "@marshal", "runtime");

  await mkdir(path.dirname(entryPath), { recursive: true });
  await mkdir(path.dirname(packageLink), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    '{"name":"@marshal/runtime","version":"0.1.0-test","type":"module"}\n',
    "utf8",
  );
  await writeFile(entryPath, source, "utf8");
  await symlink(packageRoot, packageLink, process.platform === "win32" ? "junction" : "dir");

  return { appPath, entryPath };
}

function loader(appPath: string): PinnedMarshalRuntimePackageLoader {
  return new PinnedMarshalRuntimePackageLoader({
    location: { isPackaged: false, appPath, resourcesPath: appPath },
  });
}

describe("PinnedMarshalRuntimePackageLoader", () => {
  it("loads the Runtime host entry from a linked package", async () => {
    const fixture = await createFixture(
      "export const createAgentRuntime = () => undefined;\n" +
        "export const createRuntimeBuiltinsSource = () => undefined;\n" +
        "export const createRuntimeNativeExtensionDiscoveryService = () => undefined;\n",
    );
    const packageLoader = loader(fixture.appPath);

    const firstLoad = packageLoader.load();
    expect(packageLoader.load()).toBe(firstLoad);
    const loaded = await firstLoad;

    expect(loaded.createAgentRuntime).toBeTypeOf("function");
    expect(loaded.createRuntimeBuiltinsSource).toBeTypeOf("function");
    expect(loaded.createRuntimeNativeExtensionDiscoveryService).toBeTypeOf("function");
    expect(fs.realpathSync(fixture.entryPath)).not.toContain(
      path.join("node_modules", "@marshal", "runtime"),
    );
    expect(packageLoader.metadata()).toMatchObject({
      name: "@marshal/runtime",
      version: "0.1.0-test",
      entrypoint: "dist/host.js",
    });
  });

  it("rejects a missing Runtime package", async () => {
    const appPath = await mkdtemp(path.join(tmpdir(), "marshal-runtime-loader-test-"));
    tempDirectories.push(appPath);

    await expect(loader(appPath).load()).rejects.toMatchObject({ code: "package-missing" });
  });

  it("rejects a module without every required Runtime host factory", async () => {
    const fixture = await createFixture(
      "export const createAgentRuntime = () => undefined;\n" +
        "export const createRuntimeBuiltinsSource = () => undefined;\n",
    );

    await expect(loader(fixture.appPath).load()).rejects.toMatchObject({
      code: "invalid-runtime-module",
    });
  });

  it("loads dist/host.js from a local Runtime workspace when MARSHAL_RUNTIME_LOCAL=1", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "marshal-runtime-loader-local-"));
    tempDirectories.push(root);
    const appPath = path.join(root, "marshal");
    const runtimeRoot = path.join(root, "marshal-agent-runtime");
    const packageRoot = path.join(runtimeRoot, "packages", "runtime");
    const entryPath = path.join(packageRoot, "dist", "host.js");
    const source =
      "export const createAgentRuntime = () => undefined;\n" +
      "export const createRuntimeBuiltinsSource = () => undefined;\n" +
      "export const createRuntimeNativeExtensionDiscoveryService = () => undefined;\n";
    await mkdir(path.join(appPath, "node_modules", "@marshal"), { recursive: true });
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@marshal/runtime","version":"0.1.0-local","type":"module"}\n',
      "utf8",
    );
    await writeFile(entryPath, source, "utf8");

    const packageLoader = new PinnedMarshalRuntimePackageLoader({
      location: { isPackaged: false, appPath, resourcesPath: appPath },
      env: {
        [MARSHAL_RUNTIME_LOCAL_ENV]: "1",
        [MARSHAL_RUNTIME_SOURCE_ENV]: runtimeRoot,
      },
    });

    await expect(packageLoader.load()).resolves.toMatchObject({
      createAgentRuntime: expect.any(Function),
    });
    expect(packageLoader.metadata()).toMatchObject({
      name: "@marshal/runtime",
      version: "0.1.0-local",
      entrypoint: "dist/host.js",
      entrySha256: createHash("sha256").update(source).digest("hex"),
    });
  });

  it("fails closed when the local Runtime workspace has not been built", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "marshal-runtime-loader-unbuilt-"));
    tempDirectories.push(root);
    const appPath = path.join(root, "marshal");
    const runtimeRoot = path.join(root, "marshal-agent-runtime");
    const packageRoot = path.join(runtimeRoot, "packages", "runtime");
    await mkdir(appPath, { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@marshal/runtime","version":"0.1.0-local","type":"module"}\n',
      "utf8",
    );

    const packageLoader = new PinnedMarshalRuntimePackageLoader({
      location: { isPackaged: false, appPath, resourcesPath: appPath },
      env: {
        [MARSHAL_RUNTIME_LOCAL_ENV]: "1",
        [MARSHAL_RUNTIME_SOURCE_ENV]: runtimeRoot,
      },
    });

    await expect(packageLoader.load()).rejects.toMatchObject({ code: "entrypoint-missing" });
  });
});
