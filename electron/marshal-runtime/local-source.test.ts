import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_RUNTIME_DIRNAME,
  MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV,
  MARSHAL_RUNTIME_LOCAL_ENV,
  MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
  MARSHAL_RUNTIME_SOURCE_ENV,
  RUNTIME_PACKAGE_MANIFEST_RELATIVE,
  defaultLocalMarshalRuntimeRoot,
  defaultCliShimPath,
  isLocalMarshalRuntimeEnabled,
  maybeInstallPackagedMarshalCli,
  resolveLocalMarshalRuntimeSource,
  resolveRuntimeExtensionDiscoveryRoots,
} from "./local-source";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "marshal-runtime-local-source-"));
  tempDirectories.push(root);
  return root;
}

async function writeRuntimeWorkspace(root: string): Promise<void> {
  const manifest = path.join(root, RUNTIME_PACKAGE_MANIFEST_RELATIVE);
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, '{"name":"@marshal/runtime","version":"0.1.0"}\n', "utf8");
}

function unpackaged(appPath: string) {
  return { isPackaged: false, appPath, resourcesPath: appPath };
}

describe("isLocalMarshalRuntimeEnabled", () => {
  it("enables only unpackaged Marshal when the local flag is 1", () => {
    const location = unpackaged("/tmp/marshal");
    expect(
      isLocalMarshalRuntimeEnabled(location, {
        [MARSHAL_RUNTIME_LOCAL_ENV]: MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
      }),
    ).toBe(true);
    expect(isLocalMarshalRuntimeEnabled(location, { [MARSHAL_RUNTIME_LOCAL_ENV]: "true" })).toBe(
      false,
    );
    expect(
      isLocalMarshalRuntimeEnabled(
        { isPackaged: true, appPath: "/tmp/marshal", resourcesPath: "/tmp/marshal" },
        { [MARSHAL_RUNTIME_LOCAL_ENV]: MARSHAL_RUNTIME_LOCAL_FLAG_VALUE },
      ),
    ).toBe(false);
  });
});

describe("resolveLocalMarshalRuntimeSource", () => {
  it("loads the sibling workspace when the local flag is set", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const runtimeRoot = path.join(root, DEFAULT_LOCAL_RUNTIME_DIRNAME);
    await mkdir(appPath);
    await writeRuntimeWorkspace(runtimeRoot);

    expect(
      resolveLocalMarshalRuntimeSource(unpackaged(appPath), {
        [MARSHAL_RUNTIME_LOCAL_ENV]: MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
      }),
    ).toEqual({
      root: runtimeRoot,
      packageRoot: path.join(runtimeRoot, "packages", "runtime"),
    });
  });

  it("prefers MARSHAL_RUNTIME_SOURCE over the sibling default", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const configured = path.join(root, "custom-runtime");
    await mkdir(appPath);
    await writeRuntimeWorkspace(configured);

    expect(
      resolveLocalMarshalRuntimeSource(unpackaged(appPath), {
        [MARSHAL_RUNTIME_LOCAL_ENV]: MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
        [MARSHAL_RUNTIME_SOURCE_ENV]: configured,
      }),
    ).toMatchObject({ root: configured });
  });

  it("rejects a missing local workspace instead of falling back to the packed pin", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    await mkdir(appPath);

    expect(() =>
      resolveLocalMarshalRuntimeSource(unpackaged(appPath), {
        [MARSHAL_RUNTIME_LOCAL_ENV]: MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
      }),
    ).toThrow(/MARSHAL_RUNTIME_LOCAL=1 requires a Marshal Runtime workspace/);
  });

  it("rejects a relative MARSHAL_RUNTIME_SOURCE", () => {
    expect(() =>
      resolveLocalMarshalRuntimeSource(unpackaged("/tmp/marshal"), {
        [MARSHAL_RUNTIME_LOCAL_ENV]: MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
        [MARSHAL_RUNTIME_SOURCE_ENV]: "../marshal-agent-runtime",
      }),
    ).toThrow(/must be an absolute directory/);
  });
});

describe("resolveRuntimeExtensionDiscoveryRoots", () => {
  it("discovers the user-visible Marshal Runtime extension library", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const homedir = path.join(root, "home");
    await mkdir(appPath);

    const roots = await resolveRuntimeExtensionDiscoveryRoots(
      unpackaged(appPath),
      path.join(appPath, "trusted"),
      {},
      { homedir },
    );

    expect(roots).toEqual([await realpath(path.join(homedir, "Marshal Runtime", "extensions"))]);
  });

  it("does not scan a sibling runtime workspace unless local mode is on", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const homedir = path.join(root, "home");
    await mkdir(appPath);
    await writeRuntimeWorkspace(defaultLocalMarshalRuntimeRoot(appPath));

    const roots = await resolveRuntimeExtensionDiscoveryRoots(
      unpackaged(appPath),
      path.join(appPath, "trusted"),
      {},
      { homedir },
    );

    expect(roots).toEqual([await realpath(path.join(homedir, "Marshal Runtime", "extensions"))]);
  });

  it("skips the user library during tests unless a homedir is injected", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    await mkdir(appPath);

    await expect(
      resolveRuntimeExtensionDiscoveryRoots(unpackaged(appPath), path.join(appPath, "trusted"), {}),
    ).resolves.toEqual([]);
  });

  it("uses MARSHAL_RUNTIME_EXTENSIONS_ROOT when it is an absolute directory", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const configured = path.join(root, "extra-extensions");
    await mkdir(appPath);
    await mkdir(configured);

    await expect(
      resolveRuntimeExtensionDiscoveryRoots(unpackaged(appPath), path.join(appPath, "trusted"), {
        [MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV]: configured,
      }),
    ).resolves.toEqual([await realpath(configured)]);
  });

  it("adds the local runtime workspace as an extra root when local mode is on", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const homedir = path.join(root, "home");
    const configured = path.join(root, "custom-runtime");
    await mkdir(appPath);
    await writeRuntimeWorkspace(configured);

    const roots = await resolveRuntimeExtensionDiscoveryRoots(
      unpackaged(appPath),
      path.join(appPath, "trusted"),
      {
        [MARSHAL_RUNTIME_LOCAL_ENV]: MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
        [MARSHAL_RUNTIME_SOURCE_ENV]: configured,
      },
      { homedir },
    );

    expect(roots).toEqual([
      await realpath(path.join(homedir, "Marshal Runtime", "extensions")),
      await realpath(path.join(configured, "extensions")),
    ]);
  });

  it("discovers the user library in packaged Marshal and ignores a sibling runtime", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const homedir = path.join(root, "home");
    await mkdir(appPath);
    await writeRuntimeWorkspace(defaultLocalMarshalRuntimeRoot(appPath));

    const roots = await resolveRuntimeExtensionDiscoveryRoots(
      { isPackaged: true, appPath, resourcesPath: appPath },
      path.join(appPath, "trusted"),
      {},
      { homedir },
    );

    expect(roots).toEqual([await realpath(path.join(homedir, "Marshal Runtime", "extensions"))]);
  });

  it("rejects a relative MARSHAL_RUNTIME_EXTENSIONS_ROOT", async () => {
    await expect(
      resolveRuntimeExtensionDiscoveryRoots(unpackaged("/tmp/marshal"), "/tmp/trusted", {
        [MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV]: "extensions",
      }),
    ).rejects.toThrow(/must be an absolute directory/);
  });

  it("rejects a missing configured discovery root", async () => {
    const root = await tempRoot();
    await expect(
      resolveRuntimeExtensionDiscoveryRoots(
        unpackaged(path.join(root, "marshal")),
        path.join(root, "trusted"),
        {
          [MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV]: path.join(root, "missing-extensions"),
        },
      ),
    ).rejects.toThrow(/unavailable/);
  });

  it("rejects a discovery root that is a symbolic link", async () => {
    const root = await tempRoot();
    const appPath = path.join(root, "marshal");
    const realExtensions = path.join(root, "real-extensions");
    const linked = path.join(root, "linked-extensions");
    await mkdir(appPath);
    await mkdir(realExtensions);
    await symlink(realExtensions, linked);

    await expect(
      resolveRuntimeExtensionDiscoveryRoots(unpackaged(appPath), path.join(appPath, "trusted"), {
        [MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV]: linked,
      }),
    ).rejects.toThrow(/must be a real directory/);
  });
});

describe("maybeInstallPackagedMarshalCli", () => {
  it("writes a unix shim for packaged Marshal and skips unpackaged Marshal", async () => {
    const root = await tempRoot();
    const homedir = path.join(root, "home");
    const resourcesPath = path.join(root, "resources");
    await mkdir(path.join(resourcesPath, "cli"), { recursive: true });
    await writeFile(path.join(resourcesPath, "cli", "marshal-cli.mjs"), "export {}\n", "utf8");

    await expect(
      maybeInstallPackagedMarshalCli({
        isPackaged: false,
        resourcesPath,
        homedir,
      }),
    ).resolves.toBeNull();

    const shimPath = await maybeInstallPackagedMarshalCli({
      isPackaged: true,
      resourcesPath,
      homedir,
      platform: "darwin",
      nodePath: "/usr/bin/node",
    });
    expect(shimPath).toBe(defaultCliShimPath({ platform: "darwin", homedir }));
    expect(await readFile(shimPath!, "utf8")).toMatch(/exec "\/usr\/bin\/node"/);
  });
});
