# Handoff — Issue Lens

**Date**: 2026-03-30
**Branch**: main (8 commits)
**Status**: MVP validated end-to-end on real repos (llm-d/llm-d, openclaw/openclaw). Scoring, hybrid search, and embedding pipeline all working.

## Goal

AI-first CLI tool that helps open source contributors find high-value, high-merge-probability Issues in large GitHub repos.

## Architecture

```
gh CLI → sync (issues, PRs, comments, xrefs, embeddings) → SQLite + FTS5 + sqlite-vec
                                                                ↓
CLI commands (discover, search, show, related, xref, maintainers, status, config)
                                                                ↓
                                                        AI agent (SKILL.md)
```

## What Works (validated on llm-d/llm-d)

- **Full sync pipeline**: issues → PRs → maintainers → xrefs (PR links + search API) → comments → embeddings
- **Scoring with continuous signals**: `finalScore = contributability × mergeProbability / 100`
  - Maintainer response time gradient: 3d +25, 7d +20, 14d +15, 30d +10, >30d +5
  - Multiple maintainer replies: 2-3 +5, 4+ +8
  - Label merge rate from xref data
  - Active merger: +8, no mergers: -25
  - No response >30d: -20
  - Score range on llm-d: 17-53, merge probability: 44-74 (no saturation)
- **Hybrid search**: FTS5 BM25 + sqlite-vec KNN cosine similarity fusion
  - FTS: keyword matches ("bug crash timeout")
  - Vector: semantic matches ("GPU memory CUDA OOM" → finds #787 CUDA OOM issue)
  - Hybrid: both sources fused with vector fallback weighting
- **Embedding pipeline**: node-llama-cpp, embeddinggemma-300m, auto-downloads on first run (~300MB)
- **Incremental sync**: watermarks for issues, PRs, comments, xrefs
- **Pagination resilience**: graceful stop on HTTP 422 (GitHub page limit)
- **32 tests passing**: workability (7), priority (7), merge-probability (6), store (10), sqlite-vec (2)
- **Verify gate**: `pnpm run verify` = typecheck + lint + test, all green

## Real-World Validation

### llm-d/llm-d (primary test repo)

249 issues, 788 PRs, 314 comments, 190 xrefs, 249 embeddings, 60 maintainers.

Discover top 3:

- #323 score=53 (good first issue + help wanted + fast maintainer reply)
- #1030 score=29 (enhancement + maintainer reply)
- #759 score=26 (bug + maintainer reply)

Semantic search: "GPU memory management CUDA OOM" → found #787 (CUDA OOM on sampler warmup) via vector search despite no keyword overlap.

### openclaw/openclaw (stress test)

23,970 issues, 31,661 PRs, 13,102 comments, 14,807 xrefs, 23,328 embeddings, 1,262 maintainers. After scoring calibration, scores range 38-42 with merge probability 69-77 (previously all 100).

## Dead Ends (Do Not Retry)

- **`direction=asc` on GitHub issues API for large repos** — hangs. Always use `direction=desc`
- **`merged_by` field from pulls list API** — always null. Use PR author instead
- **Page-based pagination beyond page 100 with `since` param** — issues API returns HTTP 422. `collectPaginated` now gracefully stops. Pulls API does NOT hit this limit
- **`node --experimental-strip-types` with `.js` import extensions** — must use tsx
- **`DatabaseSync` without `allowExtension: true`** — extension loading silently fails
- **vec0 `INSERT ... ON CONFLICT`** — virtual tables don't support UPSERT. Must DELETE+INSERT
- **vec0 positional `(?, ?)` for rowid+blob** — rowid gets misinterpreted. Use `CAST(? AS INTEGER)`
- **vec0 KNN with JOIN + LIMIT** — `LIMIT` must be `k = ?` in WHERE clause, not external. Use subquery pattern
- **GitHub pulls API `since` parameter** — silently ignored. Must filter client-side by `created_at`

## Key Decisions

- AI-first CLI, no TUI. SKILL.md is the interface contract
- `finalScore = contributability × mergeProbability / 100` (multiplicative, not additive)
- Scoring: continuous signals (response time gradient, reply count), base 30. Max ~91
- Maintainer inference from PR author (not merged_by — API returns null)
- sqlite-vec for vector search, node-llama-cpp for local embedding. Zero external API
- Xref from two sources: PR body closing references (zero cost) + GitHub search API (authoritative)
- Comment sync: all open issues with comments, no arbitrary limit. Incremental via watermark
- Search API xref: 2.1s interval to respect 30 req/min limit
- vec0 KNN: subquery with `k = ?`, post-filter for state

## Open Questions

- `related` command still returns empty (needs query by issue's own embedding)
- `discover` loads all open issues without limit — slow at 5k+ scale
- PR sync always fetches ALL PRs (API ignores since) — wastes ~317 API calls per sync on large repos
- Search API rate limit (30 req/min) makes xref sync slow for repos with many open issues
- Embedding model Metal GPU cleanup assertion on exit (cosmetic, no data impact)

## Next Steps

1. **`related` command** — look up issue's embedding from `issues_vec`, query KNN, return similar issues. Simple: one query, no new API calls
2. **`config add` subcommand** — implement `issue-lens config add "src/renderer/**"` to set contributor modules, enabling moduleAffinity scoring
3. **Cursor-based pagination** — replace page-based for incremental syncs (issues API 422 at page>100)
4. **Rate limit awareness in sync** — check remaining before starting, early stop instead of burning through errors
5. **PR sync optimization** — skip fetching all PRs on incremental sync when watermark is set

## Context Files

- `DESIGN.md` — full architecture, scoring formulas, data model
- `SKILL.md` — AI agent operation manual
- `src/cli.ts` — 10 CLI commands + sync pipeline (comments, xrefs, embeddings)
- `src/store.ts` — SQLite schema + all CRUD + vector ops
- `src/store/merge-probability.ts` — scoring logic (continuous signals)
- `src/store/search.ts` — FTS + vector hybrid search fusion (vec0 `k = ?` pattern)
- `src/embedding.ts` — local embedding provider (node-llama-cpp)
- `src/github.ts` — GitHub API layer (pagination with 422 graceful stop)
