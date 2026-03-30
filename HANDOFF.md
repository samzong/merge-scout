# Handoff — MergeScout

**Date**: 2026-03-30
**Branch**: main (23 commits, pushed to origin)
**Status**: MVP shipped + topic discovery rewritten. Published to npm. Three-source topic discovery validated on 4 repos.

## Goal

AI-first CLI tool that helps open source contributors find high-value, high-merge-probability Issues in large GitHub repos.

## Quick Start

```bash
npm i -g merge-scout                           # or: git clone + pnpm install + pnpm link --global
merge-scout init --repo llm-d/llm-d
merge-scout sync --repo llm-d/llm-d --full     # ~2 min for small repo

# Daily
merge-scout sync --repo llm-d/llm-d            # incremental, ~30s
merge-scout discover --repo llm-d/llm-d --limit 10 --json
merge-scout search "your interest" --repo llm-d/llm-d --json
merge-scout show 323 --repo llm-d/llm-d --json
```

## Architecture

```
gh CLI → sync (issues, PRs, comments, xrefs, embeddings, topics) → SQLite + FTS5 + sqlite-vec
                                                                        ↓
CLI commands (discover, search, show, related, xref, maintainers, status, config)
                                                                        ↓
                                                                AI agent (SKILL.md)
```

## What Works

- **Full sync pipeline**: issues → PRs → maintainers → xrefs → comments → embeddings → topic discovery
- **Incremental sync with PR early stop**: watermark-based, PR sync stops at first stale page
- **Scoring with continuous signals**: `finalScore = contributability × mergeProbability / 100`
  - Maintainer response time gradient: 3d +25, 7d +20, 14d +15, 30d +10, >30d +5
  - Multiple maintainer replies: 2-3 +5, 4+ +8
  - Label merge rate from xref data
  - `good first issue` +20, `help wanted` +15, `bug` +10
- **Topic discovery (three-source merge)**:
  1. CODEOWNERS / K8s OWNERS files — explicit module ownership with maintainers
  2. PR title conventional commit scopes — `fix(scheduler):` → topic "scheduler"
  3. Directory tree — structural fallback under detected source root
  - All topics enriched with issue counts, PR counts, active maintainers
  - Config subcommands: `config topics`, `config select`, `config deselect`
- **Hybrid search**: FTS5 BM25 + sqlite-vec KNN fusion
- **Embedding pipeline**: node-llama-cpp, embeddinggemma-300m (~300MB, auto-downloads)
- **Pagination resilience**: graceful stop on HTTP 422
- **AI agent skill**: `skill/SKILL.md` with routing, workflows, score interpretation
- **Published to npm**: `npm i -g merge-scout` (v0.1.0)
- **54 tests passing**, verify gate green

## Validated On

### kubernetes-sigs/kueue (topic discovery primary test)

2,281 issues, 7,809 PRs. 25 topics discovered:

- 7 codeowners (from OWNERS files: controller, webhooks, kueueviz, kueue-populator...)
- 5 pr-scope (scheduler×6, multikueue×6, tas×4, visibility×3, helm×5)
- 13 directory (workload, config, resources, cache, metrics, dra...)

### cli/cli (CODEOWNERS test)

5,862 issues, 3,976 PRs. 28 topics discovered:

- 8 codeowners (codespace→cli/codespaces, attestation→cli/package-security...)
- 4 pr-scope (pr, repo, pr create, browse, repo fork)
- 16 directory (search, cmd, ssh, extensions, markdown...)

### llm-d/llm-d (sparse project)

249 issues, 788 PRs. 1 topic (pr-scope: actions×11). Honest result — no CODEOWNERS, no standard source dirs.

### openclaw/openclaw (stress test)

23,970 issues, 31,661 PRs, 123MB DB.

## Dead Ends (Do Not Retry)

- **`direction=asc` on GitHub issues API for large repos** — hangs. Always `direction=desc`
- **`merged_by` from pulls list API** — always null. Use PR author
- **Page-based pagination >100 with `since`** — issues API 422. `collectPaginated` gracefully stops
- **`DatabaseSync` without `allowExtension: true`** — extension loading silently fails
- **vec0 UPSERT** — not supported. Must DELETE+INSERT
- **vec0 `(?, ?)` for rowid+blob** — use `CAST(? AS INTEGER)`
- **vec0 KNN with JOIN + LIMIT** — must use `k = ?` in WHERE, not external LIMIT
- **GitHub pulls API `since` param** — silently ignored. Use client-side early stop on `updated_at`
- **Label-based topic discovery** — too noisy. `size/L`, `priority-3`, `needs-triage` all leak through. Replaced with CODEOWNERS + PR scope + directory
- **node-llama-cpp ggml Metal cleanup crash** — exit code 134 on macOS when process exits. Data is saved, harmless. Known upstream issue.

## Key Decisions

- AI-first CLI, no TUI. SKILL.md is the interface contract
- `finalScore = contributability × mergeProbability / 100` (multiplicative)
- Scoring: continuous response time gradient, base 30, max ~91
- Maintainer inference from PR author (not merged_by)
- sqlite-vec + node-llama-cpp for local vector search. Zero external API
- Xref: PR body closing refs (zero cost) + search API (authoritative, 2.1s interval)
- PR incremental sync: own pagination loop with early stop on `updated_at`
- Topic discovery: three sources merged (CODEOWNERS → PR scope → directory), not fallback chain
- `fetchRepoTree` uses `HEAD` ref (not hardcoded branch name)
- npm published as `merge-scout`, source install recommended (frequent changes)

## Not Yet Done

| Item                                             | Effort | Impact                                              |
| ------------------------------------------------ | ------ | --------------------------------------------------- |
| `related` command                                | small  | KNN query on issue's own embedding                  |
| Cursor-based pagination                          | medium | fixes issues API 422 on large repos                 |
| Rate limit pre-check in sync                     | small  | early stop instead of failing mid-sync              |
| Short PR scope names (`pr`, `repo`) over-match   | small  | min length filter or word boundary matching         |
| OWNERS file content parsing for maintainer names | medium | currently only uses OWNERS file existence as signal |
| Issues API returns all when `since` matches many | medium | incremental issues sync still slow for active repos |

## Context Files

- `README.md` — project intro, install (npm + source), usage scenarios
- `DESIGN.md` — full architecture, scoring formulas, data model
- `skill/SKILL.md` — AI agent skill (routing, workflows, score interpretation)
- `src/cli.ts` — 10 CLI commands + sync pipeline + config subcommands
- `src/store.ts` — SQLite schema + CRUD + vector ops + topic storage
- `src/store/topic-discovery.ts` — three-source topic discovery + enrichment
- `src/store/priority.ts` — scoring + topic affinity (unified text matching)
- `src/store/merge-probability.ts` — merge probability (continuous signals)
- `src/store/search.ts` — FTS + vector hybrid search (vec0 `k = ?`)
- `src/github.ts` — GitHub API (fetchRepoTree, fetchFileContent, pagination)
- `src/embedding.ts` — local embedding provider
- `docs/design-topic-discovery.md` — topic discovery design doc
