---
name: marshal-release-notes
description: Generate release notes for OmerMachluf/marshal between two versions. Auto-detects the range (previous stable → current Latest) when versions are omitted. Fetches PRs, filters out hidden-experiment features, drafts announcement text, and converts to rich text HTML.
allowed-tools:
  - Bash(python3 skills/marshal-release-notes/*)
  - Bash(python3 skills/marshal-release-notes/scripts/update-github-release*)
  - Bash(gh pr view *)
  - Bash(gh pr diff *)
  - Bash(gh release view *)
  - Bash(gh release list *)
  - Bash(gh api repos/OmerMachluf/marshal/releases/latest*)
  - Read
  - Write
---

# Release Notes Skill

Generate release announcements for Marshal. Versions can be passed explicitly or auto-detected from GitHub release state in Phase 0.

## Usage

```
/marshal-release-notes <from-version> <to-version>   # explicit range
/marshal-release-notes                                # auto-detect via Phase 0
```

## Workflow

### Phase 0: Resolve versions

Skip this phase if the user invoked the skill with both versions explicit (e.g. `/marshal-release-notes 0.22.47 0.22.118`). Use those values directly.

Otherwise — including any free-form "next version release notes" / "share out the latest release" request without explicit numbers — run:

```bash
python3 skills/marshal-release-notes/scripts/suggest-versions.py
```

Sample output:

```json
{
  "currentLatest": "0.22.118",
  "previousStable": "0.22.47",
  "headVersion": "0.22.149",
  "betasSinceLatest": ["0.22.125"],
  "suggested": { "from": "0.22.47", "to": "0.22.118" }
}
```

The convention is **stable-to-stable**: announcements track the diff between the previous stable release and the newly-promoted "Latest" stable on GitHub. Beta cuts (Pre-release tags) are not announced individually.

Present the candidates and the suggested range to the user. Surface anything that may need a decision:

- **Default case**: `currentLatest` is the to-version, `previousStable` is the from-version. Suggested range matches.
- **Promote-in-progress case**: if `headVersion` is ahead of `currentLatest` and `betasSinceLatest` is non-empty, the user may be preparing notes for a not-yet-promoted version. Show the betas and HEAD as alternatives.
- **No current Latest**: the repo has no release flagged Latest — ask the user for both versions.

Ask the user to confirm the range before continuing. Never assume — `gh`'s Latest marker is the default signal, but the user may be announcing a different window (e.g. stable-to-HEAD when prepping notes ahead of a promote).

### Phase 1: Gather data

Run both scripts from the repo root:

```bash
python3 skills/marshal-release-notes/scripts/fetch-prs.py <from> <to>
python3 skills/marshal-release-notes/scripts/detect-hidden-experiments.py <to>
```

`fetch-prs.py` outputs JSON with all PRs merged to main between the two versions, contributor names, PR counts, and truncated PR summaries.

`detect-hidden-experiments.py` reads `src/features/settings/SettingsPanel.tsx` at the to-version commit and outputs the `flags`, `labels`, and `descriptions` inside `<Section title="Hidden Experiments">`. These are the experiment toggles that are NOT shown to most users — features behind them are internal experimentation and **must not appear in the announcement**.

Save both outputs for use in later phases.

#### Audit PRs for hidden-experiment work

Build a match list of strings to search against each PR's title + summary (already in the fetch-prs.py output):

- Every entry in `aliases` (lowercased label and flag variants — exact substring match, case-insensitive)
- Every capitalized word in `descriptions` that looks like a codename (e.g. "Aether", "Lobster", "Memora"). These often appear in PR titles even when the flag name does not.

For any PR that matches:

1. Flag it as `[HIDDEN?]` in the grouped list you present to the user.
2. Spot-check the PR diff with `gh pr diff <number> --repo OmerMachluf/marshal` if the title/summary alone doesn't make the gating clear. The gate looks like `if (experiments.<flagName>)`, `settings.experiments?.<flagName>`, or a feature-flag check that gates the whole new feature.
3. Default to **excluding** flagged PRs from the announcement unless the user explicitly opts them in. A PR that touches a hidden flag for an unrelated reason (e.g. a refactor that renames a variable) may still be fine, but the burden is on confirmation, not on the draft.

Present to the user:

1. The PR list grouped by prefix (feat/fix/refactor/other), with `[HIDDEN?]` markers on suspect PRs
2. The hidden-experiment flag list returned by detect-hidden-experiments.py, so the user can see what is being filtered and why
3. The contributor list with counts — and ask the user to verify contributor names look correct

### Phase 2: Draft release notes

Ask the user to define sections. Present the PR list and ask:

- Which sections to create (e.g., "Permissions", "Security", "Co-Create")
- Which PRs belong in each section
- Which PRs to skip (CI, chore, internal)
- Section ordering

The user may give partial guidance — group the rest reasonably and present for confirmation. If the user provides full guidance, just follow it.

For PRs where the truncated summary isn't enough, fetch the full body:

```bash
gh pr view <number> --repo OmerMachluf/marshal --json body
```

Draft the announcement following the established format:

```
@Marshal App

Here's what's new since <from-version> (<N> PRs merged):

---

<emoji> **SECTION TITLE** <description paragraph>

<emoji> **SECTION TITLE** <description paragraph>

...

---

🙌 **CONTRIBUTORS, Thank you!**

🏆 **Name**, N PRs
🏆 **Name**, N PRs
...

---

💬 **Feedback:** drop it in the Bugs channel or use the in-app feedback form.

Let's go @Marshal App 🔥 Contributors, you're welcome to contribute to the movement.
```

**Writing guidelines:**

- Each section: emoji + bold uppercase title + description paragraph
- Lead with the most impactful user-facing features
- Bold key phrases within descriptions
- Inline code for commands and file names
- Contributors: just name + PR count, no descriptions of work

**Audience: Information Workers.** They care what they can now do, what's fixed, what's safer. Not how it's wired.

- **Keep what the user sees:** UI labels (Always allow, Auto-approve read-only operations), keyboard shortcuts, visible feature names (Co-Create, Heartbeat, Daily Briefing), observable behavior. Drop internal SDK versions, error codes, file paths, settings keys, telemetry pipeline names, internal codenames, and prose describing wiring.

- **Translate PR descriptions, don't lift them.** PR bodies use internal codenames, acronyms, identifiers, and phase labels. Translate to what the user sees, or drop the detail. If you'd need to open the PR (or grep the code) to understand a phrase, drop it. Examples by category:
  - **Codenames → product names:** "Horizon" → "Daily Briefing"; "Memora", "Aether", "Lobster" → drop or rephrase
  - **Acronyms → spelled-out user labels.** If a user wouldn't know what an acronym means without explanation (kernel/OS codes, internal platform short-codes, ticket-tracker IDs), replace it with the visible product label or describe the observable effect. Illustrative pair: "MCP" → "connected tools". The pattern matters more than this specific example.
  - **Identifiers in backticks (tool IDs, magic constants, error strings) → drop:** `48:notes`, `askUser`, `publishRelayMessage`, `no_account_found`, kernel error -413, `CAPIError 400`. Backtick-code formatting is for things USERS type (commands, shortcuts, file paths they configure), not things engineers wrote
  - **Engineering phase labels → drop:** "Phase 1", "Phase 3a-2", "MVP", "v2 plumbing"
  - **Implementation jargon and infrastructure names → user-visible effect.** Words that name a mechanism read like proper nouns but are invisible plumbing. Recurring categories: transport names (sockets, REST endpoints), auth subsystems (brokers, token stores), code-signing artifacts (entitlements, provisioning profiles), protocol layers (header fields, payload schemas), parser/runtime internals, UI rendering internals. Translate to the effect or drop. Illustrative pair: "macOS broker" → "macOS sign-in". The principle generalizes: if a word names HOW something is wired, drop or translate to WHAT changes for the user.

- **Architecture, lint, CI, refactor:** skip entirely unless the user asks.
- **No em dashes (—) or en dashes (–) in the output.** They read as AI-generated. Use commas, colons, parentheses, or split into separate sentences instead. Applies to section bodies, the contributors list, and the HTML version.
- Avoid other AI-tells: don't open paragraphs with "We've", don't use "delve", "leverage", "robust", "seamless", "comprehensive", or "harness". Prefer plain verbs.
- Don't lift PR titles or descriptions verbatim, rewrite for end users. PR descriptions are usually accurate but occasionally misleading about what actually shipped (e.g. claims a feature is flagged when the diff shows it isn't). For high-impact claims (experiment-flag gating, "X is enabled by default", scope changes), spot-check the diff before quoting.
- **Never announce anything gated behind a Hidden Experiments toggle.** The audit in Phase 1 surfaces these. Even if the PR sounds exciting, if it ships behind a flag the user can't see, the wider audience cannot use it. Announcing it leaks intent and confuses users who can't find the feature.

**Self-check before presenting the draft.** After drafting, run a literal scan over the full draft and fix every hit before showing it to the user. This catches the cases where the rule was read but not applied while drafting. Look for:

- **Backtick code segments** — keep only if the content is something the user types (a command, a keyboard shortcut, a file path the user configures, a file extension they recognize like `.html`). Drop or unwrap everything else: tool IDs (`askUser`, `listLocalFiles`), internal constants (`48:notes`), error strings (`no_account_found`, `[object Object]`), config filenames (`marshal-diagnostics.jsonl`, `minimum-version.json`).
- **File paths and engineer-only file extensions** the user does not type: `.json`, `.jsonl`, `.tsx`, `.ts`, internal log files, settings files.
- **ALL-CAPS acronyms a user wouldn't recognize without explanation**: kernel/OS codes, internal platform short-codes, ticket IDs (TTR-NNNN, #NNNN). If you'd need to gloss it for the reader, translate or drop.
- **Identifiers shaped `<prefix>_<verb>` or `<thing>_<thing>`**: snake_case is almost always engineer-facing.
- **Re-read the draft against the five translate categories above.** Any phrase that fits one of those categories should already have been translated. Common slip-ups: a codename or acronym that read like a feature name got kept; an infrastructure mechanism (transport, signing, auth, parsing, rendering) got described instead of translated to the visible effect. These categories are stable across releases; the specific words inside them change every release, so don't rely on memorized phrase lists.
- **Parentheticals that "explain" a translated term by naming the engineer version** ("Translucency (vibrancy)"): drop the parens. The engineer name leaks the implementation you just translated away from.

For each hit: translate to a user-visible effect, or drop entirely if there is no user-visible effect.

Iterate with the user until approved.

### Phase 3: Rich text HTML

When the user approves the raw text, convert to HTML for pasting into a rich-text chat post. Trigger on user saying "convert to HTML", "make it rich text", "ready to post", "generate HTML", etc.

**HTML conversion rules:**

- Each section becomes a `<p>` with inline formatting
- Bold text → `<strong>`
- Italic text → `<em>`
- Inline code → `<code>`
- Blank lines between sections → `<p>&nbsp;</p>`
- No `<div>`, no CSS classes, no inline styles — chat clients strip most of them
- Emojis stay as Unicode characters
- `&` in text → `&amp;`

Write the HTML file to `<repo-root>/tmp-release-notes.html` and tell the user to open it in a browser, then Ctrl+A → Ctrl+C to copy rich text into the chat post.

**HTML template:**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Marshal Release Notes</title></head>
<body>
<p><strong>@Marshal App</strong></p>
<p>&nbsp;</p>
<p>Here's what's new since <from-version>:</p>
<p>&nbsp;</p>
<!-- For each section: -->
<p><emoji> <strong>SECTION TITLE</strong> description with <strong>bold</strong> and <code>code</code>.</p>
<p>&nbsp;</p>
<!-- For multi-paragraph sections, each paragraph is its own <p>: -->
<p>Continuation paragraph.</p>
<p>&nbsp;</p>
<!-- Contributors: -->
<p>🙌 <strong>CONTRIBUTORS, Thank you!</strong></p>
<p>&nbsp;</p>
<p>🏆 <strong>Name</strong>, N PRs</p>
<!-- one <p> per contributor, no &nbsp; between them -->
<p>&nbsp;</p>
<p>💬 <strong>Feedback:</strong> drop it in the Bugs channel or use the in-app feedback form.</p>
<p>&nbsp;</p>
<p>Let's go @Marshal App 🔥 Contributors, you're welcome to contribute to the movement.</p>
</body>
</html>
```

### Phase 4: Update GitHub release (optional)

After the user approves the raw text in Phase 2, ask:

> "Would you like to update the GitHub release for `v<to-version>` with these notes?"

If the user says yes:

1. Extract the change sections and contributors from the approved draft — strip the `@Marshal App` header, the `Here's what's new since...` intro, and the `Feedback:` / `Let's go` footer. Keep the `<emoji> **SECTION TITLE** <description>` blocks and the `CONTRIBUTORS` section.
2. Write the raw notes to a temp file (e.g. `tmp-release-notes.md`)
3. Verify the release exists first (the tag MUST be `v`-prefixed — `gh release view 0.22.0` will 404, use `gh release view v0.22.0`):
   ```bash
   gh release view v<to-version> --repo OmerMachluf/marshal
   ```
4. Run the update script:
   ```bash
   python3 skills/marshal-release-notes/scripts/update-github-release.py <to-version> tmp-release-notes.md
   ```
5. Clean up the temp file after success.

**Never create a release — only update an existing one.** If the release doesn't exist, tell the user and skip.

## Important

- **Always filter to `base:main`** — the fetch script does this automatically.
- **Exclude version bump PRs** — the fetch script strips `chore: bump to v*`.
- **Verify contributor names** with the user before finalizing — GitHub display names can be wrong.
- **Never post release notes anywhere without explicit user approval.** Always present the draft first.
- **Never create a GitHub release** — only update existing ones.
- **Use `python3` not `python`** for scripting — handles Unicode correctly on Windows.
- **Do not use the GitHub MCP server tools** (e.g. `get_release_by_tag`, `list_releases`, `get_file_contents`) for any step of this skill. Use only the scripts in `skills/marshal-release-notes/scripts/` and the `gh` CLI invocations listed in `allowed-tools`. The MCP GitHub server uses a separate token that typically cannot see the private `OmerMachluf/marshal` repo and returns 404 ("Not Found") for everything, which is misleading.
- **Always pass the `v`-prefixed tag to `gh release ...` and to any `gh api repos/.../releases/tags/...` call** (e.g. `v0.22.0`, not `0.22.0`). The fetch script `fetch-prs.py` accepts either form because it strips the prefix internally for `git log`, but release-tag lookups against GitHub require the literal tag name.
- **Release lookups belong in Phase 0, not Phase 1.** Phase 0 (`suggest-versions.py`) calls `gh api .../releases/latest` and `gh release list` to propose the range. Once the user confirms, `fetch-prs.py` resolves both versions purely from `git log --grep="bump to v<X>"` — do not re-call `gh release view` or any release API during Phase 1 for from/to version resolution.
- **Hidden Experiments are the source of truth for what is secret.** `detect-hidden-experiments.py` reads `src/features/settings/SettingsPanel.tsx` at the to-version commit and returns the flag names + labels. Do not invent your own list of "things that look internal" — trust the file. If a feature is in Hidden Experiments at the to-version, it is hidden regardless of how mature it looks. If a feature moved out of Hidden Experiments **after** the to-version (as Cloud Sync and Memora did after v0.22.118), it is still hidden for that announcement.
