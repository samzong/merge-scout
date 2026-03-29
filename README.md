# Issue Lens

Local-first CLI that helps open source contributors find the **best issues to work on** — ranked by value × merge probability.

Syncs GitHub data into SQLite, scores every open issue, and provides hybrid semantic search (FTS5 + vector). Designed as an AI agent tool — the real UI is your AI assistant.

## Install AI Skill

```bash
git clone https://github.com/samzong/issue-lens.git
cd issue-lens && pnpm install
ln -s "$(pwd)/skill" ~/.agents/skills/issue-lens
```

Then tell your AI: **"Find me the best issue to contribute to in this project"** — it handles the rest.

## Prerequisites

- Node.js ≥ 22
- pnpm ≥ 10
- [gh CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

## Quick Start

```bash
pnpm run issue-lens -- init --repo <owner/repo>
pnpm run issue-lens -- sync --repo <owner/repo> --full
pnpm run issue-lens -- discover --repo <owner/repo> --limit 10
```

## How It Works

```text
finalScore = contributability × mergeProbability / 100
```

**contributability** — is this issue worth doing?

- Label bonuses: `good first issue` +20, `help wanted` +15, `bug` +10
- Body clarity, recency, module affinity

**mergeProbability** — will my PR actually get merged?

- Maintainer response time gradient (replied in 3d → +25, 7d → +20, 14d → +15...)
- Multiple maintainer replies boost (+5 to +8)
- Label historical merge rate from cross-reference data
- Active merger presence, no-response penalty

## Usage Scenarios

### 1. Daily Recommendation

> "What issues should I work on today?"

AI runs `sync` → `discover`, then explains why each issue is recommended: which signals drove the score, whether it's claimable, and what risks exist.

### 2. Semantic Search

> "Find issues related to GPU memory management"

AI runs `search "GPU memory management"`. Returns results matched by meaning, not just keywords — finds issues about CUDA OOM, memory leaks, and allocation bugs even if those exact words aren't in the title.

### 3. Issue Assessment

> "Is issue #759 worth working on?"

AI runs `show 759` + `xref 759`, gives a clear verdict:

- **Go**: workability=ready, merge probability ≥ 60, maintainer recently active
- **Maybe**: some risk factors but could work
- **Skip**: claimed, blocked, stale, or low merge probability

### 4. Maintainer Profiles

> "Who maintains this project?"

AI runs `maintainers`, shows who has merge power, how fast they respond, and how active they are in the last 90 days.

### 5. End-to-End Contribution

> "Find the easiest issue and submit a PR for it"

AI runs the full pipeline:

1. `discover --limit 5` → pick the highest-scored `ready` issue
2. `show <N>` → understand the requirement
3. `xref <N>` → confirm no one else is working on it
4. Read the relevant code, implement the fix
5. Commit, push, create PR referencing the issue

From discovery to PR in one conversation.

### 6. New Repo Setup

> "Initialize this repo and show me what to work on"

AI runs `init` → `sync --full` → `discover`, gives the first batch of recommendations.

## Commands

| Command                           | Description                                    |
| --------------------------------- | ---------------------------------------------- |
| `init --repo <R>`                 | Initialize (create local DB)                   |
| `sync --repo <R> [--full]`        | Sync issues, PRs, comments, xrefs, embeddings  |
| `discover --repo <R> [--limit N]` | Ranked recommendations by finalScore           |
| `search <query> --repo <R>`       | Hybrid search (FTS5 + vector semantic)         |
| `show <N> --repo <R>`             | Issue detail + workability + merge probability |
| `xref <N> --repo <R>`             | Issue → PR cross-references                    |
| `related <N> --repo <R>`          | Semantically similar issues                    |
| `maintainers --repo <R>`          | Maintainer profiles and activity               |
| `status --repo <R>`               | Sync state, index health, rate limit           |
| `config --repo <R>`               | View/modify contributor module focus           |

All commands support `--json` for structured output.

## AI Agent Skill

The `skill/SKILL.md` file defines how AI agents should use this tool. It includes:

- Intent routing (daily recommend, search, assessment, maintainers)
- Score interpretation tables
- Decision framework (Go / Maybe / Skip)
- Workflow sequences for each scenario

Install: `ln -s /path/to/issue-lens/skill ~/.agents/skills/issue-lens`

## Tech Stack

- TypeScript, Node.js ≥ 22 (built-in `node:sqlite`)
- SQLite + FTS5 + [sqlite-vec](https://github.com/asg017/sqlite-vec) (vector search)
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (local embeddings, embeddinggemma-300m)
- `gh` CLI for GitHub API (no SDK, no tokens to manage)

## License

MIT
