# Handoff — Issue Lens

**Date**: 2026-03-30
**Branch**: main (3 commits)
**Status**: MVP core pipeline complete — scoring differentiated, vector search working, needs real-world validation

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

## What Works

- **Full sync pipeline**: issues → PRs → maintainers → xrefs (PR links + search API) → comments → embeddings
- **Scoring differentiation**: `finalScore = contributability × mergeProbability / 100` with real signals
  - Maintainer replied on issue: +30 merge probability
  - Label merge rate from xref data (e.g., "bug" label has 70% historical merge rate)
  - Active merger exists: +10
  - No maintainer response >30d: -40
  - Assigned/open PR penalties on contributability
- **sqlite-vec**: loads correctly, 768-dim float32 vectors, KNN query works
- **Hybrid search**: FTS5 BM25 + vector cosine similarity fusion
- **Embedding pipeline**: sync auto-computes embeddings for issues missing vectors (node-llama-cpp, embeddinggemma-300m)
- **Incremental sync**: watermarks for issues, PRs, comments, xrefs
- **32 tests passing**: workability (7), priority (7), merge-probability (6), store (10), sqlite-vec (2)
- **Verify gate**: `pnpm run verify` = typecheck + lint + test, all green

## Files Changed (since initial scaffold)

| File                                  | Change                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`                          | Comment sync, xref sync, embedding sync steps in handleSync; search uses query embedding                                                                                                            |
| `src/store.ts`                        | allowExtension: true fix; upsertIssueEmbedding (DELETE+INSERT for vec0); getOpenIssuesWithComments/getIssueNumbersMissingEmbeddings/updateMaintainerReplyStats/buildXrefsFromPrLinks; count methods |
| `src/types.ts`                        | SyncSummary.xrefs field                                                                                                                                                                             |
| `src/store.test.ts`                   | 10 tests: xref build, maintainer reply stats, comment filtering, counts, embeddings                                                                                                                 |
| `src/store/workability.test.ts`       | 7 tests: ready/claimed/stale/unclear scenarios                                                                                                                                                      |
| `src/store/priority.test.ts`          | 7 tests: labels, penalties, module affinity, maintainer bonus                                                                                                                                       |
| `src/store/merge-probability.test.ts` | 6 tests: maintainer reply boost, no-response penalty, label merge rate, controversy                                                                                                                 |
| `src/lib/sqlite-vec.test.ts`          | 2 tests: extension loading, vector insert + KNN query                                                                                                                                               |

## Dead Ends (Do Not Retry)

- **`direction=asc` on GitHub issues API for large repos** — hangs. Always use `direction=desc`
- **`merged_by` field from pulls list API** — always null. Use PR author instead
- **Page-based pagination beyond page 100** — HTTP 422. Need cursor-based for >10k results
- **`node --experimental-strip-types` with `.js` import extensions** — must use tsx
- **`DatabaseSync` without `allowExtension: true`** — extension loading silently fails
- **vec0 `INSERT ... ON CONFLICT`** — virtual tables don't support UPSERT. Must DELETE+INSERT
- **vec0 positional `(?, ?)` for rowid+blob** — rowid gets misinterpreted. Use `CAST(? AS INTEGER)`

## Key Decisions

- AI-first CLI, no TUI. SKILL.md is the interface contract
- `finalScore = contributability × mergeProbability / 100` (multiplicative, not additive)
- Maintainer inference from PR author (not merged_by — API returns null)
- sqlite-vec for vector search, node-llama-cpp for local embedding. Zero external API
- Xref from two sources: PR body closing references (zero cost) + GitHub search API (authoritative)
- Comment sync: all open issues with comments, no arbitrary limit. Incremental via watermark
- Search API xref: 2.1s interval to respect 30 req/min limit

## Real-World Validation (2026-03-30, openclaw/openclaw)

Ran against 23,970 issues + 31,661 PRs. Results:

- **13,102 comments** synced for ~4,900 open issues (rate limit hit at 5000 calls)
- **14,807 xrefs** built from PR closing references
- **23,328 embeddings** computed (model auto-downloaded, ~300MB embeddinggemma-300m)
- **1,262 maintainers** identified

**Scoring problem found**: merge_probability saturates at 100 for all 1,617 issues with maintainer replies. Formula: base 50 + reply +30 + labeled +10 + active merger +10 = 100. No differentiation within the "maintainer replied" group. All top issues show identical score=55.

**Root cause**: additive bonuses with a 100 cap. Need multiplicative or weighted approach that uses continuous signals (response time, reply sentiment, specificity) instead of binary flags.

**Bugs found and fixed during validation**:

- `collectPaginated` crashed on HTTP 422 at page 100 (issues API) — added graceful stop
- `buildXrefsFromPrLinks` FK constraint when PR references non-existent issue — added try/catch
- PR API ignores `since` param — added client-side filtering by `created_at`
- Pulls API doesn't hit 422 at page 100 (only issues API does)

## Open Questions

- `related` command still returns empty (needs query by issue's own embedding)
- `discover` loads all open issues without limit — performance concern at 5k+ scale
- PR sync always fetches ALL PRs (API ignores since) — wastes ~317 API calls per sync

## Next Steps

1. **Scoring calibration** (P0) — the biggest issue. Merge probability needs to use continuous signals, not binary flags. Lower base to 30, use response time as a gradient (1d → +25, 7d → +15, 30d → +5), add specificity signals (maintainer said "will fix" vs just "noted")
2. **`related` command** — look up issue's embedding from `issues_vec`, query KNN, return similar issues
3. **`config add` subcommand** — implement `issue-lens config add "src/renderer/**"` to set contributor modules
4. **Cursor-based pagination** — replace page-based for incremental syncs (issues API 422 at page>100)
5. **Rate limit awareness in sync** — check remaining before starting comment sync, pause/resume instead of failing

## Context Files

- `DESIGN.md` — full architecture, scoring formulas, data model
- `SKILL.md` — AI agent operation manual
- `src/cli.ts` — 10 CLI commands + sync pipeline (comments, xrefs, embeddings)
- `src/store.ts` — SQLite schema + all CRUD + vector ops
- `src/store/merge-probability.ts` — scoring logic
- `src/store/search.ts` — FTS + vector hybrid search fusion
- `src/embedding.ts` — local embedding provider (node-llama-cpp)
