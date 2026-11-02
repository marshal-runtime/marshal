import { describe, expect, it } from "vitest";

import { monacoLanguageForFile } from "./monacoLanguage";

describe("monacoLanguageForFile", () => {
  it("maps extensions that differ from their Monaco language id", () => {
    expect(monacoLanguageForFile("sessions.ts")).toBe("typescript");
    expect(monacoLanguageForFile("FilePreview.tsx")).toBe("typescript");
    expect(monacoLanguageForFile("preload.cjs")).toBe("javascript");
    expect(monacoLanguageForFile("dag.py")).toBe("python");
    expect(monacoLanguageForFile("ci.yml")).toBe("yaml");
    expect(monacoLanguageForFile("run.sh")).toBe("shell");
    expect(monacoLanguageForFile("README.md")).toBe("markdown");
    expect(monacoLanguageForFile("index.htm")).toBe("html");
  });

  it("passes through extensions that already are Monaco language ids", () => {
    expect(monacoLanguageForFile("package.json")).toBe("json");
    expect(monacoLanguageForFile("index.css")).toBe("css");
    expect(monacoLanguageForFile("main.go")).toBe("go");
  });

  it("handles paths, case, and extensionless names", () => {
    expect(monacoLanguageForFile("C:\\repo\\src\\App.TSX")).toBe("typescript");
    expect(monacoLanguageForFile("/repo/Dockerfile")).toBe("dockerfile");
    expect(monacoLanguageForFile("/repo/.gitignore")).toBe("ini");
    expect(monacoLanguageForFile("LICENSE")).toBe("plaintext");
  });
});
