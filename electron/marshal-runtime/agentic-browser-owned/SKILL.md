---
name: agentic-browser
description: Whenever you need to use a browser, supports headless and full user profile modes
---

# Agentic Browser

CLI tool for browser automation via Chrome DevTools Protocol. Every command returns JSON with `"success": true|false`.

## Quick Start

```bash
agentic-browser setup                         # launch browser (visible, with user profile)
agentic-browser navigate "https://example.com"
agentic-browser screenshot --output page.png
agentic-browser shutdown
```

Setup flags: `--headless`, `--browser edge|chrome`, `--port N`, `--profile "Profile 1"`, `--expose`

---

## Command Reference

### Lifecycle

```bash
agentic-browser setup                                      # launch browser
agentic-browser connect --host 10.0.0.5 --port 9222       # attach to existing browser
agentic-browser status                                     # check connection
agentic-browser profile-info                               # show cookies & logged-in services
agentic-browser shutdown                                   # kill browser
```

### Navigation

```bash
agentic-browser navigate "<url>"
agentic-browser go-back | go-forward | reload [--hard]
```

### Click

```bash
agentic-browser click "<selector>"                         # by CSS selector
agentic-browser click --x 200 --y 300                      # by viewport coordinates
```

Options: `--button left|right|middle`, `--click-count N` (use hyphen, not camelCase), `--modifiers ctrl,shift,alt,meta`

### Type

```bash
agentic-browser type "<selector>" "text"                   # type into element
agentic-browser type "<selector>" "text" --clear           # clear first
agentic-browser type --text "hello"                        # type at cursor (Input.insertText)
```

`type --text` is preferred for contenteditable / rich editors (Word Online, Google Docs) where selectors can't target the editable area.

### Keyboard

```bash
agentic-browser keyboard "Tab"                             # single key
agentic-browser keyboard "a" --modifiers ctrl              # Ctrl+A
agentic-browser keyboard "Control+a"                       # alternative combo syntax
```

Keys: `Tab`, `Enter`, `Escape`, `Backspace`, `Delete`, `Home`, `End`, `ArrowUp/Down/Left/Right`, `F1`–`F12`, `PageUp`, `PageDown`
Modifiers: `ctrl`, `shift`, `alt`, `meta` (via `--modifiers` flag or `+` combo syntax)

### Other Interaction

```bash
agentic-browser select "<selector>" --value "US"           # dropdown (also: --label, --index)
agentic-browser hover "<selector>"
agentic-browser scroll --y 500 [--selector ".panel"]
agentic-browser drag --start-x 100 --start-y 200 --end-x 400 --end-y 200 [--steps N] [--modifiers shift]
```

### Content Extraction

```bash
agentic-browser screenshot [--output f.png] [--full-page] [--selector ".el"] [--format jpeg --quality 80]
agentic-browser html [--selector "article"]
agentic-browser accessibility-tree [--max-depth 4]
agentic-browser extract-data table [--selector "#tbl"]     # also: structured
agentic-browser metadata
```

### Script Execution

```bash
agentic-browser execute "document.title"
agentic-browser execute "document.title" --target "ABC123" # run inside iframe/worker
agentic-browser list-targets                               # discover all CDP targets
```

### Multi-Target Support (--target)

`--target <id>` works on **any command**, not just `execute`. Use `list-targets` to discover all
CDP targets (pages, iframes, workers, WebView2 surfaces), then point any command at one:

```bash
agentic-browser list-targets --port 9333
agentic-browser click "#submit" --target BD28C4 --port 9333
agentic-browser screenshot --target BD28C4 --port 9333 --output dialog.png
agentic-browser execute "document.querySelector('select').value" --target BD28C4
agentic-browser accessibility-tree --target BD28C4
```

Target ID supports **prefix matching** — you don't need the full hex string.

`accessibility-tree` does NOT penetrate cross-origin iframes — use `--target` to connect directly.

### Wait

```bash
agentic-browser wait-for-selector "<sel>" [--condition visible|hidden|present] [--timeout 60000]
agentic-browser wait-for-navigation
agentic-browser wait-for-network-idle
agentic-browser wait-for-condition "window.appReady === true"
```

### Tabs & Targets

```bash
agentic-browser list-tabs                                  # open page tabs
agentic-browser list-targets                               # all targets (pages, iframes, workers)
agentic-browser create-tab [--url "<url>"]
agentic-browser switch-tab "<target-id>"
agentic-browser close-tab "<target-id>"
```

### Dialogs

```bash
agentic-browser handle-dialog accept|dismiss --trigger "<js-expr>" [--prompt-text "answer"]
```

### Files & Downloads

```bash
agentic-browser upload-file "<selector>" "file1.pdf" ["file2.pdf"]
agentic-browser download "<url>" [--output ./file.csv] [--timeout 120000]
```

### Cookies

```bash
agentic-browser get-cookies [--domain ".example.com"]
agentic-browser set-cookie --name "s" --value "v" --domain ".example.com" [--path / --secure --http-only --same-site Lax --expires N]
agentic-browser delete-cookie --name "s" --domain ".example.com"
```

### Network

```bash
agentic-browser network-log [--duration 10000]             # default 5000ms
```

### DOM Modification

```bash
agentic-browser inject-css ".ads { display: none !important; }"
agentic-browser modify-attribute "<sel>" "<attr>" ["val"]  # omit val to remove
agentic-browser insert-html "<sel>" "<html>" [--position beforebegin|afterbegin|beforeend|afterend]
agentic-browser remove-element "<sel>"
```

### Device Emulation

```bash
agentic-browser emulate-device --preset "iphone-14"        # or: --width 375 --height 812 --mobile
agentic-browser reset-emulation
```

Presets: `iphone-14`, `iphone-14-pro-max`, `pixel-7`, `ipad-pro`, `galaxy-s23`

---

## Global Options

| Flag              | Default     | Description                              |
| ----------------- | ----------- | ---------------------------------------- |
| `--port <N>`      | `9222`      | CDP debugging port                       |
| `--host <addr>`   | `127.0.0.1` | CDP host (for remote browsers)           |
| `--target <id>`   | *(auto)*    | Connect to a specific CDP target by ID   |

---

## User Profiles

`setup` auto-loads your Chrome/Edge user profile (cookies, logins, extensions). If the profile is locked (browser already running), it falls back to the alternate browser or creates a temp profile with copied cookies. Use `profile-info` to verify.

---

## Error Recovery

| Error | Fix |
|-------|-----|
| `No browser on port 9222` | Run `setup` first |
| `Element not found` | Use `wait-for-selector` before interacting |
| `WebSocket closed` | Tab closed — `list-tabs` + `switch-tab` |
| `Browser did not start` | Close existing instances using same profile |

**Pattern for dynamic pages:** `navigate` → `wait-for-network-idle` → `wait-for-selector` → interact.

---

## Security

- CDP is unauthenticated — never use `--expose` on public networks.
- `setup` without `--expose` binds to `127.0.0.1` only.
- For remote control, use an SSH tunnel: `ssh -L 9222:127.0.0.1:9222 user@host`
w