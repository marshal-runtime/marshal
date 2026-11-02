import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isKnownNonMarshalBrowserString,
  LiveConnectionRefusalError,
  liveModePort,
  liveModeRequested,
  MARSHAL_RENDERER_MARKER_EXPRESSION,
  selectMarshalPageTarget,
} from "./live-connection.mjs";

const ALLOW_LIVE_KEY = "ACCEPTANCE_FACILITY_ALLOW_LIVE";
const PORT_KEY = "ACCEPTANCE_FACILITY_CDP_PORT";

function withEnv(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// F-005 (d): live-flag-off must gate every live-only receipt to "blocked", never a pass.
void test("liveModeRequested is false by default (no opt-in env var)", () => {
  withEnv({ [ALLOW_LIVE_KEY]: undefined }, () => {
    assert.equal(liveModeRequested(), false);
  });
});

void test("liveModeRequested is false for any value other than the literal '1'", () => {
  withEnv({ [ALLOW_LIVE_KEY]: "true" }, () => {
    assert.equal(liveModeRequested(), false);
  });
});

void test("liveModeRequested is true only for the exact opt-in value", () => {
  withEnv({ [ALLOW_LIVE_KEY]: "1" }, () => {
    assert.equal(liveModeRequested(), true);
  });
});

// F-DEPLOY-2 guard (a): live mode requires an EXPLICIT port everywhere — the
// removed default (9222) is exactly what let identify-installed-artifact.mjs
// attach to the operator's personal Google Chrome instead of Marshal.
void test("liveModePort refuses with a typed reason when no port is configured (guard a)", () => {
  withEnv({ [PORT_KEY]: undefined }, () => {
    assert.throws(
      () => liveModePort(),
      (error) => {
        assert.ok(error instanceof LiveConnectionRefusalError);
        assert.equal(error.code, "missing-explicit-cdp-port");
        return true;
      },
    );
  });
});

void test("liveModePort refuses with a typed reason for a non-numeric override", () => {
  withEnv({ [PORT_KEY]: "not-a-port" }, () => {
    assert.throws(
      () => liveModePort(),
      (error) => {
        assert.ok(error instanceof LiveConnectionRefusalError);
        assert.equal(error.code, "missing-explicit-cdp-port");
        return true;
      },
    );
  });
});

void test("liveModePort refuses with a typed reason for a non-positive override", () => {
  withEnv({ [PORT_KEY]: "0" }, () => {
    assert.throws(
      () => liveModePort(),
      (error) => {
        assert.ok(error instanceof LiveConnectionRefusalError);
        assert.equal(error.code, "missing-explicit-cdp-port");
        return true;
      },
    );
  });
});

void test("liveModePort honors an explicit override", () => {
  withEnv({ [PORT_KEY]: "9333" }, () => {
    assert.equal(liveModePort(), 9333);
  });
});

// F-DEPLOY-2 guard (c): target matching only ever accepts a confident URL
// match — no blind first-page/[0] fallback survives the repair.
void test("selectMarshalPageTarget (guard c) matches the deployed marshal://app/index.html page", () => {
  const targets = [
    { url: "devtools://devtools/bundled/inspector.html" },
    { url: "marshal://app/index.html" },
  ];
  assert.deepEqual(selectMarshalPageTarget(targets), { url: "marshal://app/index.html" });
});

void test("selectMarshalPageTarget (guard c) falls back to the legacy /dist/index.html page only when no marshal:// page exists", () => {
  const targets = [{ url: "file:///build/dist/index.html" }];
  assert.deepEqual(selectMarshalPageTarget(targets), { url: "file:///build/dist/index.html" });
});

void test("selectMarshalPageTarget (guard c) prefers marshal://app/index.html over a legacy /dist/index.html page", () => {
  const targets = [{ url: "file:///build/dist/index.html" }, { url: "marshal://app/index.html" }];
  assert.deepEqual(selectMarshalPageTarget(targets), { url: "marshal://app/index.html" });
});

void test("selectMarshalPageTarget (guard c) refuses (returns null) rather than guessing a first/only page — the exact F-DEPLOY-2 shape (a personal Slack tab, no Marshal page open)", () => {
  const targets = [
    { url: "https://app.slack.com/client/T00/C00" },
    { url: "https://mail.google.com/mail/u/0/" },
  ];
  assert.equal(selectMarshalPageTarget(targets), null);
});

void test("selectMarshalPageTarget (guard c) refuses on an empty target list instead of guessing", () => {
  assert.equal(selectMarshalPageTarget([]), null);
});

void test("selectMarshalPageTarget (guard c) ignores targets with a non-string/missing url instead of throwing", () => {
  assert.equal(selectMarshalPageTarget([{}, { url: undefined }, { url: 42 }]), null);
});

// F-DEPLOY-2 guard (b): endpoint verification — the /json/version metadata
// pre-check rejects the literal reported scenario (a real desktop browser on
// the CDP port) before any Runtime.evaluate is attempted.
//
// F-DEPLOY-2b (Codex-found, independently confirmed — see Field Guide
// SUPERSESSION section): a real desktop Chrome's User-Agent lacks the
// Marshal/Electron markers below, so these "no User-Agent supplied" cases
// still correctly reject — a real desktop browser's own /json/version never
// carries those markers either.
void test("isKnownNonMarshalBrowserString (guard b) rejects real Google Chrome's exact Browser string — the reproduced F-DEPLOY-2 scenario", () => {
  assert.equal(
    isKnownNonMarshalBrowserString(
      "Chrome/122.0.6261.129",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/122.0.6261.129 Safari/537.36",
    ),
    true,
  );
});

void test("isKnownNonMarshalBrowserString (guard b) rejects other real desktop browser families", () => {
  assert.equal(isKnownNonMarshalBrowserString("Firefox/128.0", "Mozilla/5.0 Firefox/128.0"), true);
  assert.equal(
    isKnownNonMarshalBrowserString("Safari/605.1.15", "Mozilla/5.0 Safari/605.1.15"),
    true,
  );
  assert.equal(isKnownNonMarshalBrowserString("Edg/122.0.0.0", "Mozilla/5.0 Edg/122.0.0.0"), true);
});

void test("isKnownNonMarshalBrowserString (guard b) does not reject a legitimate headless test browser — the window-marker probe is the authoritative check for this case", () => {
  assert.equal(isKnownNonMarshalBrowserString("HeadlessChrome/145.0.7632.6"), false);
});

void test("isKnownNonMarshalBrowserString (guard b) treats a missing/non-string Browser field as inconclusive, not a pass", () => {
  assert.equal(isKnownNonMarshalBrowserString(undefined), false);
  assert.equal(isKnownNonMarshalBrowserString(null), false);
  assert.equal(isKnownNonMarshalBrowserString(42), false);
});

// F-DEPLOY-2b (Codex independent, over-rejection fix — binding per Field
// Guide SUPERSESSION section): Electron's Browser field is Chrome-shaped, not
// "Electron/<version>" as the superseded 3b8e99bc3 repair's comment falsely
// claimed. Metadata acceptance is via User-Agent, never Browser-string
// guessing.
void test("isKnownNonMarshalBrowserString (guard b, F-DEPLOY-2b) does NOT reject the REAL live Marshal /json/version shape — Browser is Chrome-shaped but User-Agent carries the Marshal/Electron markers", () => {
  // Fixture: example-receipts/live-demonstration/json-version-9333.json,
  // captured read-only from the deployed host's own debug port.
  assert.equal(
    isKnownNonMarshalBrowserString(
      "Chrome/146.0.7680.166",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Marshal/0.23.346 Chrome/146.0.7680.166 Electron/41.1.1 Safari/537.36",
    ),
    false,
  );
});

void test("isKnownNonMarshalBrowserString (guard b, F-DEPLOY-2b) still rejects a real desktop Chrome whose User-Agent carries no Marshal/Electron marker", () => {
  assert.equal(
    isKnownNonMarshalBrowserString(
      "Chrome/146.0.7680.166",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/146.0.7680.166 Safari/537.36",
    ),
    true,
  );
});

void test("isKnownNonMarshalBrowserString (guard b, F-DEPLOY-2b) treats a spoofed Marshal/Electron User-Agent as inconclusive, not a pass — metadata alone never suffices, the marker probe remains mandatory", () => {
  assert.equal(
    isKnownNonMarshalBrowserString(
      "Chrome/999.0.0.0",
      "Mozilla/5.0 Marshal/9.9.9 Chrome/999.0.0.0 Electron/9.9.9",
    ),
    false,
  );
});

void test("MARSHAL_RENDERER_MARKER_EXPRESSION (guard b) checks for Marshal's own preload globals, not a generic marker", () => {
  assert.match(MARSHAL_RENDERER_MARKER_EXPRESSION, /window\.sessionsAPI/);
  assert.match(MARSHAL_RENDERER_MARKER_EXPRESSION, /window\.runtimeUiAPI/);
});
