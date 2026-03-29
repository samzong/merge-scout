# Handoff — Issue Lens

**Date**: 2026-03-30
**Branch**: main (10 commits)
**Status**: MVP usable. Scoring, hybrid search, embedding pipeline validated on real repos. Ready for daily use.

## Goal

AI-first CLI tool that helps open source contributors find high-value, high-merge-probability Issues in large GitHub repos.

## Quick Start

```bash
# First time
issue-lens init --repo llm-d/llm-d
issue-lens sync --repo llm-d/llm-d --full    # ~2 min for small repo

# Daily
issue-lens sync --repo llm-d/llm-d           # incremental, ~30s
issue-lens discover --repo llm-d/llm-d --limit 10 --json
issue-lens search "your interest" --repo llm-d/llm-d --json
issue-lens show 323 --repo llm-d/llm-d --json
```

## Architecture

```
gh CLI → sync (issues, PRs, comments, xrefs, embeddings) → SQLite + FTS5 + sqlite-vec
                                                                ↓
CLI commands (discover, search, show, related, xref, maintainers, status, config)
                                                                ↓
                                                        AI agent (SKILL.md)
```

## What Works

- **Full sync pipeline**: issues → PRs → maintainers → xrefs (PR links + search API) → comments → embeddings
- **Incremental sync with PR early stop**: watermark-based, PR sync stops at first stale page (317 pages → 1-2 pages for openclaw)
- **Scoring with continuous signals**: `finalScore = contributability × mergeProbability / 100`
  - Maintainer response time gradient: 3d +25, 7d +20, 14d +15, 30d +10, >30d +5
  - Multiple maintainer replies: 2-3 +5, 4+ +8
  - Label merge rate from xref data
  - `good first issue` +20, `help wanted` +15, `bug` +10
  - Score range on llm-d: 17-53, merge probability: 44-74
- **Hybrid search**: FTS5 BM25 + sqlite-vec KNN fusion
  - "GPU memory CUDA OOM" → finds #787 via vector despite no keyword overlap
- **Embedding pipeline**: node-llama-cpp, embeddinggemma-300m (~300MB, auto-downloads)
- **Pagination resilience**: graceful stop on HTTP 422
- **32 tests passing**, verify gate green

## Validated On

### llm-d/llm-d (primary)

249 issues, 788 PRs, 314 comments, 190 xrefs, 249 embeddings, 60 maintainers.

- #323 score=53 (good first issue + help wanted + fast maintainer reply)
- Semantic search working (FTS + vector + hybrid)

### openclaw/openclaw (stress test)

23,970 issues, 31,661 PRs, 13,102 comments, 14,807 xrefs, 23,328 embeddings.

- Scores range 38-42, merge probability 69-77 (no saturation after calibration)

## Dead Ends (Do Not Retry)

- **`direction=asc` on GitHub issues API for large repos** — hangs. Always `direction=desc`
- **`merged_by` from pulls list API** — always null. Use PR author
- **Page-based pagination >100 with `since`** — issues API 422. `collectPaginated` gracefully stops. Pulls API does NOT hit this
- **`DatabaseSync` without `allowExtension: true`** — extension loading silently fails
- **vec0 UPSERT** — not supported. Must DELETE+INSERT
- **vec0 `(?, ?)` for rowid+blob** — use `CAST(? AS INTEGER)`
- **vec0 KNN with JOIN + LIMIT** — must use `k = ?` in WHERE, not external LIMIT
- **GitHub pulls API `since` param** — silently ignored. Use client-side early stop on `updated_at`

## Key Decisions

- AI-first CLI, no TUI. SKILL.md is the interface contract
- `finalScore = contributability × mergeProbability / 100` (multiplicative)
- Scoring: continuous response time gradient, base 30, max ~91
- Maintainer inference from PR author (not merged_by)
- sqlite-vec + node-llama-cpp for local vector search. Zero external API
- Xref: PR body closing refs (zero cost) + search API (authoritative, 2.1s interval)
- PR incremental sync: own pagination loop with early stop on `updated_at`

## Not Yet Done

| Item                                                   | Effort | Impact                                              |
| ------------------------------------------------------ | ------ | --------------------------------------------------- |
| `config add` subcommand                                | small  | enables moduleAffinity personalization              |
| `related` command                                      | small  | KNN query on issue's own embedding                  |
| SKILL.md daily workflow                                | small  | "what should I contribute today" one-shot           |
| Cursor-based pagination                                | medium | fixes issues API 422 on large repos                 |
| Rate limit pre-check in sync                           | small  | early stop instead of failing mid-sync              |
| Issues API still returns all when `since` matches many | medium | incremental issues sync still slow for active repos |

## Context Files

- `DESIGN.md` — full architecture, scoring formulas, data model
- `SKILL.md` — AI agent operation manual
- `src/cli.ts` — 10 CLI commands + sync pipeline
- `src/store.ts` — SQLite schema + CRUD + vector ops
- `src/store/merge-probability.ts` — scoring (continuous signals)
- `src/store/search.ts` — FTS + vector hybrid search (vec0 `k = ?`)
- `src/github.ts` — GitHub API (pagination 422 stop, PR early stop)
- `src/embedding.ts` — local embedding provider
