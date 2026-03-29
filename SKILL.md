# issue-lens

Issue Lens is a local-first Issue analysis CLI for open source contributors.
It syncs GitHub Issue/PR metadata into local SQLite, then ranks Issues by
contributability × merge probability to maximize contribution ROI.

All commands support `--json` for structured output (designed for AI agents).

## Install as AI Agent Skill

```bash
ln -s /path/to/issue-lens/skill ~/.agents/skills/issue-lens
```

The full skill definition (with routing, workflows, and score interpretation)
is in [`skill/SKILL.md`](skill/SKILL.md).

## Commands

```
issue-lens init     --repo <owner/repo>              Initialize (create local DB)
issue-lens sync     --repo <owner/repo> [--full]     Sync issues, PRs, comments, xrefs, embeddings
issue-lens discover --repo <owner/repo> [--limit N]  Ranked recommendations by finalScore
issue-lens search   <query> --repo <owner/repo>      Hybrid search (FTS + vector)
issue-lens show     <N> --repo <owner/repo>           Issue detail + workability + merge probability
issue-lens xref     <N> --repo <owner/repo>           Issue → PR cross-references
issue-lens related  <N> --repo <owner/repo>           Semantically similar issues
issue-lens maintainers --repo <owner/repo>            Maintainer profiles
issue-lens status   --repo <owner/repo>               Sync state + index health
issue-lens config   --repo <owner/repo>               View/modify contributor modules
```

## Quick Start

```bash
issue-lens init --repo llm-d/llm-d
issue-lens sync --repo llm-d/llm-d --full
issue-lens discover --repo llm-d/llm-d --limit 10 --json
```

## Scoring

`finalScore = contributability × mergeProbability / 100`

- **contributability**: label bonuses (good first issue +20, help wanted +15, bug +10), module affinity, body clarity, recency
- **mergeProbability**: maintainer response time gradient, reply count, label merge rate, active mergers

## Exit Codes

- 0: success
- 1: error
- 2: no results
