import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  extractEsbuildNativeBinaryForPackagedFallback,
  resolveEsbuildNativeBinaryPath,
  resolveWorkflowCompilerPaths,
} from "../workflow-compiler";

let tmpRoot: string | undefined;

afterEach(() => {
  if (!tmpRoot) return;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

function makeRoot(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-compiler-paths-"));
  return tmpRoot;
}

function writePackageJson(root: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "marshal" }));
}

describe("workflow compiler packaged runtime", () => {
  it("resolves app package paths from source and dist-electron module locations", () => {
    const repo = makeRoot();
    writePackageJson(repo);

    const sourceDir = path.join(repo, "electron", "workflows");
    const distDir = path.join(repo, "dist-electron");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    expect(resolveWorkflowCompilerPaths(sourceDir)).toEqual({
      appPackageRoot: repo,
      appNodeModules: path.join(repo, "node_modules"),
      workflowSdkEntry: path.join(repo, "packages", "workflow-sdk", "src", "index.ts"),
    });
    expect(resolveWorkflowCompilerPaths(distDir)).toEqual({
      appPackageRoot: repo,
      appNodeModules: path.join(repo, "node_modules"),
      workflowSdkEntry: path.join(repo, "packages", "workflow-sdk", "src", "index.ts"),
    });
  });

  it("uses app.asar.unpacked node_modules for packaged esbuild resolution", () => {
    const resources = makeRoot();
    const asarRoot = path.join(resources, "app.asar");
    writePackageJson(asarRoot);
    const packagedModuleDir = path.join(asarRoot, "dist-electron");
    fs.mkdirSync(packagedModuleDir, { recursive: true });

    expect(resolveWorkflowCompilerPaths(packagedModuleDir)).toEqual({
      appPackageRoot: asarRoot,
      appNodeModules: path.join(resources, "app.asar.unpacked", "node_modules"),
      workflowSdkEntry: path.join(asarRoot, "packages", "workflow-sdk", "src", "index.ts"),
    });
  });

  it("can extract a trusted packaged esbuild native binary when unpacked modules are absent", () => {
    const resources = makeRoot();
    const asarRoot = path.join(resources, "app.asar");
    writePackageJson(asarRoot);
    const nativePackageDir = path.join(asarRoot, "node_modules", "@esbuild", "win32-x64");
    fs.mkdirSync(nativePackageDir, { recursive: true });
    fs.writeFileSync(
      path.join(nativePackageDir, "package.json"),
      JSON.stringify({ version: "0.27.4" }),
    );
    fs.writeFileSync(path.join(nativePackageDir, "esbuild.exe"), "fake-esbuild-binary");
    const paths = resolveWorkflowCompilerPaths(path.join(asarRoot, "dist-electron"));
    const cacheRoot = path.join(resources, "cache");

    expect(resolveEsbuildNativeBinaryPath(paths, "win32", "x64")).toBe(
      path.join(nativePackageDir, "esbuild.exe"),
    );
    const extracted = extractEsbuildNativeBinaryForPackagedFallback(
      paths,
      cacheRoot,
      "win32",
      "x64",
    );

    expect(extracted).not.toBeNull();
    expect(extracted).toContain(path.join("cache", "win32-x64-0.27.4-"));
    expect(fs.readFileSync(extracted!, "utf-8")).toBe("fake-esbuild-binary");
  });

  it("returns null for packaged esbuild extraction when no native binary exists", () => {
    const resources = makeRoot();
    const asarRoot = path.join(resources, "app.asar");
    writePackageJson(asarRoot);
    const paths = resolveWorkflowCompilerPaths(path.join(asarRoot, "dist-electron"));

    expect(
      extractEsbuildNativeBinaryForPackagedFallback(
        paths,
        path.join(resources, "cache"),
        "win32",
        "x64",
      ),
    ).toBeNull();
  });

  it("packages compiler runtime dependencies for sourceDir workflows", () => {
    const builderConfig = fs.readFileSync(
      path.join(process.cwd(), "electron-builder.json5"),
      "utf-8",
    );
    const packageJson: unknown = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
    );
    if (packageJson === null || typeof packageJson !== "object") {
      throw new Error("Expected package.json to contain an object");
    }
    const dependencies: unknown = Reflect.get(packageJson, "dependencies");
    if (dependencies === null || typeof dependencies !== "object") {
      throw new Error("Expected package.json dependencies to contain an object");
    }

    expect(Reflect.get(dependencies, "esbuild")).toBeDefined();
    for (const pattern of [
      "node_modules/esbuild/**",
      "node_modules/@esbuild/**",
      "node_modules/zod/**",
      "packages/workflow-sdk/src/**/*",
    ]) {
      expect(builderConfig).toContain(pattern);
    }
  });
});
