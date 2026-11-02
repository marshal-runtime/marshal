<!-- marshal-owned -->

# GitHub Review Data Exploration

## PR Comment Data Source

| Field       | Value                                    |
| ----------- | ---------------------------------------- |
| Source      | GitHub GraphQL v4 + REST v3 via `gh api` |
| Repository  | `OmerMachluf/marshal`                             |
| Base branch | `main`                                   |

GitHub already stores the review-exact `diffHunk`, so the extractor does not need blob-object reconstruction to recover the reviewed snippet.

## Core Objects

Four GitHub surfaces are involved:

| Surface                                                   | Purpose                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| Search query (`is:pr is:merged base:main merged:<range>`) | Discover merged PRs in the date window                        |
| `PullRequest.reviewThreads`                               | File path + thread metadata (`isResolved`, `isOutdated`)      |
| Review comment fields                                     | Comment body, reviewer, `diffHunk`, line numbers, commit OIDs |
| `pulls/{number}/files`                                    | Raw file status and PR file patch for enrichment fallback     |

## Data Retrieved

The extractor provides the following fields per comment:

- **Comment content** - what the reviewer wrote
- **File path** - `reviewThreads.path`
- **`DiffHunk`** - exact diff snippet GitHub shows on the review thread
- **`CommitOid` / `OriginalCommitOid`** - commit SHAs GitHub anchors the comment to
- **Reviewer login** - `author.login`
- **PR author login** - used to drop self-comments
- **`IsResolved` / `IsOutdated`** - thread metadata for later interpretation
- **PR number and merge date** - used for PR spread counting and time-window filtering

## Filter Pipeline

The GitHub version of the filter pipeline is:

1. PR must be merged
2. PR base branch must be `main`
3. PR must fall inside the requested merge-date window
4. Keep only thread-opening review comments
5. Keep only comments with a non-empty `path`
6. Exclude bot accounts and deleted authors
7. Exclude comments authored by the PR author
8. Exclude trivial comments (`len(normalized_body) < 20`)

## Important GitHub Gotchas

### 1. No exact "rejected feedback" state

GitHub has no "won't fix" / "by design" thread state. `isResolved` only tells you whether the conversation was marked resolved; it does not prove the reviewer was right or wrong.

**Implication:** treat `IsResolved` and `IsOutdated` as metadata, not as a hard filter.

### 1a. Bot-like reviewers are not always `[bot]` accounts

Some automated reviewers can appear as regular `User` logins without the `[bot]` suffix. In this repo, `copilot-pull-request-reviewer` is one example.

**Implication:** keep an explicit login denylist in addition to the generic `[bot]` suffix filter.

### 2. `diffHunk` is exact but narrow

GitHub preserves the exact hunk shown to the reviewer, which is great for fidelity, but it may only include a small patch window.

**Implication:** enrichment uses the PR file `patch` as a fallback when `diffHunk` is empty, and manual clustering should still read neighboring code when the snippet is ambiguous.

### 3. Renames are first-class in GitHub

GitHub file metadata distinguishes `renamed` from `modified`.

**Implication:** the enriched dataset includes `renamed_file` so rename-only review patterns do not get flattened into generic edits.

### 4. Search window semantics

GitHub issue search date ranges are inclusive, while the scripts accept `start-date` inclusive and `end-date` exclusive.

**Implication:** the extractor converts the exclusive end date into an inclusive search range internally.

## Example GraphQL Queries

### Discover merged PRs

```graphql
query ($searchQuery: String!, $cursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        title
        mergedAt
        baseRefName
        headRefName
        url
        author {
          login
        }
      }
    }
  }
}
```

Example search string:

```text
repo:OmerMachluf/marshal is:pr is:merged base:main merged:2026-03-01..2026-03-21
```

### Fetch review threads

```graphql
query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          path
          comments(first: 1) {
            nodes {
              databaseId
              body
              diffHunk
              createdAt
              url
              line
              originalLine
              author {
                login
              }
              authorAssociation
              commit {
                oid
              }
              originalCommit {
                oid
              }
              pullRequestReview {
                state
                submittedAt
              }
            }
          }
        }
      }
    }
  }
}
```

### Enrichment fallback via REST

```text
GET /repos/{owner}/{repo}/pulls/{number}/files
```

Relevant fields:

- `filename`
- `status` (`modified`, `added`, `removed`, `renamed`, ...)
- `patch`
- `previous_filename`

## Verification Notes

- Search results determine which PRs are in scope
- Review-thread GraphQL data determines which human comments are in scope
- PR file metadata only enriches the records; it does not define the primary evidence

When in doubt, trust the review comment `DiffHunk` over the final PR patch, because the hunk is what the reviewer actually saw.
