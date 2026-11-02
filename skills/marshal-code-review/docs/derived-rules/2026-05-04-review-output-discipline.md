# Review output discipline — avoid AI-generated noise

- Status: candidate
- Review surface: orchestrator-level (applies to how `/marshal-code-review` posts, not what it finds)

## Guideline

When `/marshal-code-review` is run interactively, present the draft review in chat first; do not auto-post. The user typically iterates 2-3 times before posting. When a code-authoring agent generates inline `//` comments alongside code changes, default to NO inline comments unless they explain non-obvious WHY.

## Why

A reviewer: _"I would really like to avoid the raw output from being posted, I often have 2-3 iterations on the generated review comment before throwing it in."_

A reviewer: _"On this commit specifically agent added a ton of comments, most of them are low value IMO but I will let you decide if they should be kept."_

A reviewer: _"The model for some reason added a ton of comments, let's reduce the amount."_

Raw AI-generated noise erodes signal-to-noise on PRs and makes the review feel like a robot, not a co-author.

## Detection signal

- `/marshal-code-review`: orchestrator presents draft, awaits explicit "post it" / "submit" / "LGTM" before calling `gh pr review`. (Already in `SKILL.md` Posting Rules — confirmed.)
- Code-author mode: when an agent generates code, default to NO inline `// comment` additions unless explaining non-obvious WHY (hidden invariants, surprising platform behavior, workarounds for specific bugs).

## Example

Bad (re-stating what the code does — noise):

```ts
// Add the new session
const session = createSession();
// Now load the metadata
const meta = await session.getMetadata();
// Process the messages
const messages = meta.messages;
```

Good (no noise — the code self-documents):

```ts
const session = createSession();
const meta = await session.getMetadata();
const messages = meta.messages;
```

Acceptable (non-obvious WHY):

```ts
// The auth SDK silently ignores its openBrowser option on this code path
// — must use openExternalSafe explicitly here
await openExternalSafe(authUrl);
```

## Exceptions

- A non-obvious WHY warrants a comment.
- Hidden invariants deserve doc-shaped comments.
- TODO / FIXME / HACK markers with rationale (issue link, deadline, root cause) are fine; bare `// TODO` is noise.

<details>
<summary>Provenance</summary>

- Derived from 17 comments across 7 PRs, plus ~10 more in the corpus where the reviewer explicitly called out agent-added comment noise.
- Reviewer: an upstream reviewer (top-priority).
- Status decision: keep as `candidate` — applies to skill _posting/code-author behavior_ more than code-review findings. Not folded into any of the 14 agents.

</details>
