# issue-lens

Issue Lens is a local-first Issue analysis CLI for open source contributors.
It syncs GitHub Issue/PR metadata into local SQLite, then ranks Issues by
contributability × merge probability to maximize contribution ROI.

All commands support `--json` for structured output (designed for AI agents).

## Setup

```bash
issue-lens init --repo <owner/repo>
issue-lens sync --repo <owner/repo> --full
```

Subsequent incremental sync:
```bash
issue-lens sync --repo <owner/repo>
```

## Find the best Issues for me

```bash
issue-lens discover --repo <owner/repo> --limit 10 --json
```

Results are sorted by `finalScore = contributability × mergeProbability / 100`.
Key fields in the JSON response:
- `finalScore`: overall score, higher = better ROI
- `mergeProbability.score`: 0-100, how likely a fix PR gets merged
- `mergeProbability.topFactors`: human-readable reasons for the probability
- `workability`: ready | claimed | blocked | unclear | stale
- `moduleAffinity.matched`: whether it matches the contributor's focus modules

## Semantic search

```bash
issue-lens search "permission authorization bug" --repo <owner/repo> --json
```

Supports fuzzy/semantic queries. Combines FTS5 full-text and vector similarity.

## Issue detail

```bash
issue-lens show <issue-number> --repo <owner/repo> --json
```

Returns workability, merge probability, maintainer activity, and related PRs.

## Cross-references

```bash
issue-lens xref <issue-number> --repo <owner/repo> --json
issue-lens related <issue-number> --repo <owner/repo> --json
```

`xref` shows PRs linked to this Issue. `related` shows semantically similar Issues.

## Maintainers

```bash
issue-lens maintainers --repo <owner/repo> --json
```

Shows maintainer profiles: role (merger/reviewer/triager), merge count,
response time, and last active date.

## Status

```bash
issue-lens status --repo <owner/repo> --json
```

Shows sync state, index health, vector availability, and GitHub rate limit.

## Typical AI agent workflows

1. User: "Find me good Issues in openclaw"
   ```
   issue-lens sync --repo openclaw/openclaw
   issue-lens discover --repo openclaw/openclaw --limit 10 --json
   ```
   → Interpret results, recommend top Issues with reasons.

2. User: "I'm interested in security bugs"
   ```
   issue-lens search "security vulnerability exploit" --repo openclaw/openclaw --json
   issue-lens show <top-hit-number> --repo openclaw/openclaw --json
   ```
   → Analyze workability + merge probability, give recommendation.

3. User: "Is Issue #41789 worth working on?"
   ```
   issue-lens show 41789 --repo openclaw/openclaw --json
   issue-lens xref 41789 --repo openclaw/openclaw --json
   ```
   → Check if someone is already working on it, assess merge probability.

4. User: "Who maintains this project?"
   ```
   issue-lens maintainers --repo openclaw/openclaw --json
   ```
   → List active mergers and their response patterns.

## Exit codes

- 0: success
- 1: error (missing args, not found, sync failure)
- 2: no results (search returned empty)
