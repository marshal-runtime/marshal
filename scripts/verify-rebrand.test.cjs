"use strict";

// Guards scripts/verify-rebrand.mjs itself. A verification script that can only
// ever pass is worthless, so the interesting assertions here are the NEGATIVE
// ones: each builds a fixture with one specific thing broken and proves the
// script actually catches it.

const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const sharp = require("sharp");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "scripts", "verify-rebrand.mjs");
const temps = [];

after(() => {
  for (const dir of temps) rmSync(dir, { force: true, recursive: true });
});

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** A copy of just the files verify-rebrand.mjs reads, so fixtures stay cheap. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "verify-rebrand-"));
  temps.push(root);
  const copy = (rel) => {
    const destination = path.join(root, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repoRoot, rel), destination, { recursive: true });
  };
  for (const rel of [
    "package.json",
    "src/index.css",
    "src/components/icons/index.tsx",
    "src/assets/icons/nav-icons.tsx",
    "scripts/marshal-generate-badge-icons.mjs",
    "scripts/lib/badge-glyphs.mjs",
    "scripts/lib/generated-icon-assets.mjs",
    "public/fonts",
    "public/marshal-flash-prevention.css",
    "electron/theme.ts",
  ]) {
    copy(rel);
  }
  const icons = [
    "marshal-app-icon.svg",
    "marshal-icon.svg",
    "marshal-icon-outline.svg",
    "marshal-app-icon.png",
    "marshal-app-icon.ico",
    "marshal-app-icon.icns",
    "marshal-tray-template.png",
    "marshal-tray-template@2x.png",
  ];
  for (const channel of ["dev", "beta"]) {
    icons.push(
      `marshal-app-icon-${channel}.png`,
      `marshal-app-icon-${channel}-win.png`,
      `marshal-app-icon-${channel}-overlay.png`,
      `marshal-tray-template-${channel}.png`,
      `marshal-tray-template-${channel}@2x.png`,
      `marshal-tray-icon-${channel}.png`,
    );
  }
  for (const name of icons) copy(path.join("public", name));
  copy("public/macos-iconset");
  return root;
}

// String.prototype.replace with a string argument only replaces the FIRST
// occurrence, which silently weakens a tamper when the target appears more than
// once — a fixture that is still half-correct can leave the verifier passing for
// the right reason. Replace every occurrence and prove none survived.
const patch = (root, rel, from, to) => {
  const file = path.join(root, rel);
  const before = readFileSync(file, "utf8");
  assert.ok(before.includes(from), `fixture precondition: ${rel} should contain ${from}`);
  const after = before.split(from).join(to);
  assert.ok(!after.includes(from), `tamper incomplete: ${rel} still contains ${from}`);
  writeFileSync(file, after);
};

describe("verify-rebrand", () => {
  it("passes against the real repository", () => {
    const { code, stdout } = run(repoRoot);
    assert.match(stdout, /VERDICT: PASS/);
    assert.doesNotMatch(stdout, /^FAIL/m);
    assert.strictEqual(code, 0);
  });

  it("is read-only against the real repository", () => {
    const before = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
      cwd: repoRoot,
      encoding: null,
    });
    const { code } = run(repoRoot);
    const after = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
      cwd: repoRoot,
      encoding: null,
    });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(after, before);
  });

  it("passes against an unmodified fixture", () => {
    const { code, stdout } = run(fixture());
    assert.match(stdout, /VERDICT: PASS/, stdout);
    assert.strictEqual(code, 0);
  });

  it("catches an accent colour that drifts off the iris hue", () => {
    const root = fixture();
    patch(
      root,
      "src/index.css",
      "--brand-action: hsl(250, 66%, 52%)",
      "--brand-action: hsl(350, 66%, 52%)",
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}palette\/tokens/);
    assert.strictEqual(code, 1);
  });

  // The regression this exists for: the renderer looks correct in every
  // screenshot while the native window still paints the predecessor's colour.
  it("catches a pre-paint surface left out of sync", () => {
    const root = fixture();
    patch(root, "electron/theme.ts", '"#F8F8FB"', '"#FAF7F2"');
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}palette\/pre-paint-surfaces-in-sync/);
    assert.match(stdout, /native window paints the wrong colour/);
    assert.strictEqual(code, 1);
  });

  it("catches a flash-prevention stylesheet left out of sync", () => {
    const root = fixture();
    patch(
      root,
      "public/marshal-flash-prevention.css",
      "background: hsl(240, 30%, 98%)",
      "background: hsl(36, 40%, 96%)",
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}palette\/pre-paint-surfaces-in-sync/);
    assert.match(stdout, /cold boot would flash/);
    assert.strictEqual(code, 1);
  });

  it("catches a directional panel icon losing its mirror", () => {
    const root = fixture();
    patch(
      root,
      "src/components/icons/index.tsx",
      '"PanelRightClose", {\n  mirrored: true,\n}',
      '"PanelRightClose"',
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/barrel-and-direction/);
    assert.match(stdout, /PanelRightClose is not mirrored/);
    assert.strictEqual(code, 1);
  });

  it("catches the predecessor icon library coming back", () => {
    const root = fixture();
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    pkg.dependencies["lucide-react"] = "^0.400.0";
    writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg, null, 2));
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/predecessor-removed/);
    assert.strictEqual(code, 1);
  });

  it("catches Wayfinder source geometry drift", () => {
    const root = fixture();
    for (const file of ["public/marshal-app-icon.svg", "public/marshal-icon.svg"]) {
      patch(root, file, "m5 7.5 7-3 7 3", "m5 8 7-3 7 3");
    }
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/app-mark-source/);
    assert.match(stdout, /missing Wayfinder path/);
    assert.strictEqual(code, 1);
  });

  it("rejects a DEV icon substituted for the release icon", () => {
    const root = fixture();
    cpSync(
      path.join(root, "public/marshal-app-icon-dev.png"),
      path.join(root, "public/marshal-app-icon.png"),
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/generated-assets/);
    assert.match(stdout, /Mismatched generated assets: public\/marshal-app-icon\.png/);
    assert.strictEqual(code, 1);
  });

  it("rejects a colored menu icon substituted for the release template", () => {
    const root = fixture();
    cpSync(
      path.join(root, "public/marshal-tray-template-dev.png"),
      path.join(root, "public/marshal-tray-template.png"),
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/template-alpha/);
    assert.match(stdout, /marshal-tray-template\.png must be true white\+alpha/);
    assert.strictEqual(code, 1);
  });

  it("rejects a dock icon substituted for the Beta Windows icon", () => {
    const root = fixture();
    cpSync(
      path.join(root, "public/marshal-app-icon-beta.png"),
      path.join(root, "public/marshal-app-icon-beta-win.png"),
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/generated-assets/);
    assert.match(stdout, /Mismatched generated assets: public\/marshal-app-icon-beta-win\.png/);
    assert.strictEqual(code, 1);
  });

  it("rejects a solid orange image substituted for the DEV overlay", async () => {
    const root = fixture();
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 230, g: 126, b: 34, alpha: 1 },
      },
    })
      .png()
      .toFile(path.join(root, "public/marshal-app-icon-dev-overlay.png"));
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/generated-assets/);
    assert.match(stdout, /Mismatched generated assets: public\/marshal-app-icon-dev-overlay\.png/);
    assert.strictEqual(code, 1);
  });

  it("rejects the DEV menu icon substituted for the Beta menu icon", () => {
    const root = fixture();
    cpSync(
      path.join(root, "public/marshal-tray-template-dev.png"),
      path.join(root, "public/marshal-tray-template-beta.png"),
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/generated-assets/);
    assert.match(stdout, /Mismatched generated assets: public\/marshal-tray-template-beta\.png/);
    assert.strictEqual(code, 1);
  });

  it("rejects D glyph outline and advance tampering", () => {
    const root = fixture();
    patch(root, "scripts/lib/badge-glyphs.mjs", "advance: 716,", "advance: 717,");
    patch(
      root,
      "scripts/lib/badge-glyphs.mjs",
      'path: "M74.001 0V710H318.6Q491.599',
      'path: "M75.001 0V710H318.6Q491.599',
    );
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}icons\/badge-glyph-provenance/);
    assert.match(stdout, /Badge glyph provenance digest mismatch/);
    assert.strictEqual(code, 1);
  });

  it("catches the predecessor typeface coming back", () => {
    const root = fixture();
    writeFileSync(path.join(root, "public/fonts/Segoe-sans.woff2"), "");
    const { code, stdout } = run(root);
    assert.match(stdout, /FAIL {2}typography\/predecessor-removed/);
    assert.strictEqual(code, 1);
  });
});
