# Issue Lens

Local-first CLI that helps open source contributors find the **best issues to work on** — ranked by value × merge probability.

Syncs GitHub data into SQLite, scores every open issue, and provides hybrid semantic search (FTS5 + vector). Designed as an AI agent tool — the real UI is your AI assistant.

## Install AI Skill (one line)

```
Clone https://github.com/samzong/issue-lens and run: ln -s /path/to/issue-lens/skill ~/.agents/skills/issue-lens
```

Then just tell your AI: **"帮我找 llm-d/llm-d 最值得贡献的 issue"** — it knows what to do.

## Prerequisites

- Node.js ≥ 22
- pnpm ≥ 10
- [gh CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

## Quick Start

```bash
pnpm install
pnpm run issue-lens -- init --repo llm-d/llm-d
pnpm run issue-lens -- sync --repo llm-d/llm-d --full
pnpm run issue-lens -- discover --repo llm-d/llm-d --limit 10
```

## How It Works

```
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

### 1. "今天贡献什么" — Daily Recommendation

Tell your AI:

> "帮我看看 llm-d 今天有什么值得做的 issue"

AI runs `sync` → `discover`, then explains:

> **推荐 #323** — "Multiple model deployment demo"
> Score 53（最高分），`good first issue` + `help wanted`，维护者 2 天内回复了，merge probability 71%，没人认领，可以直接开始。

### 2. "我对 X 方向感兴趣" — Semantic Search

> "搜一下跟 GPU memory 和 CUDA OOM 相关的 issue"

AI runs `search "GPU memory CUDA OOM"`, returns vector-matched results even when titles don't contain those keywords. Example: finds #787 "CUDA OOM on sampler warmup" via semantic similarity.

### 3. "#759 值得做吗" — Issue Assessment

> "llm-d 的 759 这个 issue 值得做吗"

AI runs `show 759` + `xref 759`, gives verdict:

> **Maybe** — merge probability 74%，维护者回复了。但这是 RDMA/H200 环境的并发 bug，scope 比较大。xref 显示目前没人提 PR。

### 4. "谁是维护者" — Maintainer Profiles

> "kueue 的主要维护者是谁"

AI runs `maintainers`, shows: who has merge power, how fast they respond, which modules they own.

### 5. "帮我找一个 issue 直接处理提 PR" — End-to-End Contribution

> "帮我在 llm-d 找一个最容易的 issue，分析一下然后直接帮我处理提 PR"

AI runs the full pipeline:

1. `discover --limit 5` → pick the highest-scored `ready` issue
2. `show <N>` → read the issue detail, understand the requirement
3. `xref <N>` → confirm no one else is working on it
4. Clone the repo, read the relevant code, implement the fix
5. Commit, push, create PR referencing the issue

This is the ultimate workflow — from discovery to PR in one conversation.

### 6. "初始化一个新仓库" — New Repo Setup

> "帮我初始化 kubernetes-sigs/kueue，看看有什么可以做的"

AI runs `init` → `sync --full` → `discover`, gives you the first batch of recommendations.

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

## Tech Stack

- TypeScript, Node.js ≥ 22 (built-in `node:sqlite`)
- SQLite + FTS5 + [sqlite-vec](https://github.com/asg017/sqlite-vec) (vector search)
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (local embeddings, embeddinggemma-300m)
- `gh` CLI for GitHub API (no SDK, no tokens to manage)

## License

MIT
