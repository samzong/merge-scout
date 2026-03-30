---
name: merge-scout
description: >
  Find the best GitHub issues to contribute to. Syncs repo data locally,
  scores issues by contributability × merge probability, and does semantic
  search. Use when: "what should I work on", "find me good issues",
  "今天贡献什么", "这个 issue 值得做吗", "find issues about X",
  "who maintains this project", "show me easy issues", contribution
  discovery, issue analysis, merge probability assessment.
  Do not use for: PR review, code review, issue creation, git operations.
argument-hint: [discover|search|show|sync] [query|#issue] [--repo owner/repo]
---

# MergeScout

Local-first Issue analysis CLI. Ranks GitHub issues by `finalScore = contributability × mergeProbability / 100` to maximize contribution ROI.

Binary: `merge-scout` (run via `pnpm tsx bin/merge-scout.ts` from the MergeScout project, or `merge-scout` if globally installed).

## Repo Detection

1. If `--repo` is given, use it.
2. Otherwise, detect from git remotes — prefer `upstream` over `origin` (most contributors fork to `origin`, the real project lives at `upstream`):
   ```bash
   git remote get-url upstream 2>/dev/null || git remote get-url origin
   ```
   Extract `owner/repo` from the URL.
3. If neither works, ask the user.

## First-Time Setup

If `merge-scout status --repo <R> --json` returns an error or `lastSyncAt: null`, the repo needs initialization:

```bash
merge-scout init --repo <owner/repo>
merge-scout sync --repo <owner/repo> --full
```

Full sync fetches all issues, PRs, comments, cross-references, and computes embeddings. Takes 1-5 minutes depending on repo size. Only needed once.

## Routing

| User intent                                                   | Action                                       |
| ------------------------------------------------------------- | -------------------------------------------- |
| "what should I work on" / "今天贡献什么" / "find good issues" | → Daily Recommend                            |
| "find issues about X" / "搜一下 X 相关的"                     | → Semantic Search                            |
| "is #N worth working on" / "#N 值得做吗"                      | → Issue Assessment                           |
| "who maintains this" / "谁是维护者"                           | → `merge-scout maintainers --repo <R> --json` |
| "sync" / "更新数据"                                           | → `merge-scout sync --repo <R>`               |

## Daily Recommend

The core workflow. Run in sequence:

```bash
merge-scout sync --repo <R>
merge-scout discover --repo <R> --limit 10 --json
```

Interpret the JSON results. For each recommended issue, explain:

- **Why this issue**: which signals drove the score (labels, maintainer response speed, merge rate)
- **Workability**: can work start now, or is it claimed/blocked
- **Risk**: what could prevent merge (no maintainer, controversial, scope creep)

Prioritize issues where:

- `workability.status === "ready"` (no assignee, no open PR)
- `mergeProbability.score >= 60` (maintainer engaged)
- Labels include `good first issue` or `help wanted` (bonus for new contributors)

If the user has mentioned interests before (e.g., "I like networking stuff"), combine with search:

```bash
merge-scout search "networking" --repo <R> --json
```

Then cross-reference with discover scores to give personalized recommendations.

## Semantic Search

```bash
merge-scout search "<natural language query>" --repo <R> --json
```

Uses FTS5 + vector similarity. Works with vague queries like "memory leak in scheduler" even if no issue title contains those exact words.

For each result, check the `matchSource`:

- `fts`: keyword match — high precision
- `vector`: semantic match — found by meaning, not keywords
- `hybrid`: both matched — strongest signal

Follow up interesting hits with:

```bash
merge-scout show <number> --repo <R> --json
merge-scout xref <number> --repo <R> --json
```

## Issue Assessment

When the user asks about a specific issue:

```bash
merge-scout show <N> --repo <R> --json
merge-scout xref <N> --repo <R> --json
```

Give a clear verdict:

- **Go**: workability=ready, mergeProbability≥60, maintainer recently active
- **Maybe**: mergeProbability 40-59, some risk factors but could work
- **Skip**: claimed, blocked, stale, or mergeProbability<40

Explain the top merge probability factors in plain language. Example:

> "Maintainer @alice replied within 2 days, bug label has 72% historical merge rate, and there's an active merger. This is a safe bet."

## Score Interpretation

| finalScore | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| 40+        | Strong candidate — high value + high merge probability      |
| 25-39      | Decent — worth considering if the topic interests you       |
| 15-24      | Risky — may have low merge probability or missing signals   |
| <15        | Avoid — stale, no maintainer engagement, or already claimed |

| mergeProbability | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| 70+              | Maintainer engaged, fast response, good track record |
| 50-69            | Some positive signals but not all                    |
| 30-49            | Mixed — proceed with caution                         |
| <30              | No maintainer response or project appears inactive   |

## Exit Codes

- 0: success
- 1: error
- 2: no results (search returned empty — try broader query)
