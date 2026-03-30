# MergeScout

Find GitHub issues worth your time.

MergeScout is a local-first CLI for open source contributors. It syncs GitHub issues, PRs, comments, and maintainer activity into SQLite, then ranks open issues by **contributability × merge probability**.

The goal is simple: help you pick work that is both a good fit and more likely to land.

What MergeScout gives you:

- ranked issue recommendations instead of raw issue lists
- merge-probability signals based on maintainer activity and repo history
- hybrid search with FTS5 + vector similarity for vague problem statements
- AI-friendly `--json` output so an assistant can drive the workflow end to end

## Install

```bash
git clone https://github.com/samzong/merge-scout.git
cd merge-scout && pnpm install && pnpm link --global
ln -s "$(pwd)/skill" ~/.agents/skills/merge-scout
```

Then tell your agent: **"Find me the best issue to contribute to in this project"**.

<details>
<summary>Or install via npm</summary>

```bash
npm i -g merge-scout
ln -s "$(npm root -g)/merge-scout/skill" ~/.agents/skills/merge-scout
```

</details>

## Prerequisites

- Node.js ≥ 22
- pnpm ≥ 10
- [gh CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

## Quick Start

```bash
pnpm run merge-scout -- init --repo <owner/repo>
pnpm run merge-scout -- sync --repo <owner/repo> --full
pnpm run merge-scout -- discover --repo <owner/repo> --limit 10
```

## How It Works

$$\text{finalScore} = \frac{\text{contributability} \times \text{mergeProbability}}{100}$$

Where:

$$\text{contributability} = \underbrace{L_{\text{label}}}_{\text{good first issue +20}\atop\text{help wanted +15, bug +10}} + \underbrace{M_{\text{affinity}}}_{\text{module match}\atop\text{0–25}} + \underbrace{S_{\text{spec}}}_{\text{body clarity}\atop\text{0–10}} + \underbrace{R_{\text{recency}}}_{\text{updated recently}\atop\text{0–10}} - \underbrace{P_{\text{claimed}}}_{\text{assignee/open PR}\atop\text{30–50}}$$

$$\text{mergeProbability} = 30 + \underbrace{T_{\text{response}}}_{\text{3d → +25}\atop\text{7d → +20, 14d → +15}} + \underbrace{N_{\text{replies}}}_{\text{2-3 → +5}\atop\text{4+ → +8}} + \underbrace{H_{\text{merge rate}}}_{\text{label history}\atop\text{0–12}} + \underbrace{A_{\text{active}}}_{\text{merger exists}\atop\text{+8}} - \underbrace{D_{\text{silence}}}_{\text{no reply >30d}\atop\text{−20}}$$

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

Install: `ln -s /path/to/merge-scout/skill ~/.agents/skills/merge-scout`

## Tech Stack

- TypeScript, Node.js ≥ 22 (built-in `node:sqlite`)
- SQLite + FTS5 + [sqlite-vec](https://github.com/asg017/sqlite-vec) (vector search)
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (local embeddings, embeddinggemma-300m)
- `gh` CLI for GitHub API (no SDK, no tokens to manage)

## License

MIT
