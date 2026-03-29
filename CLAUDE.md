# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Issue Lens — local-first CLI tool that helps open source contributors find high-value GitHub Issues. Syncs repo data into SQLite, scores Issues by `finalScore = (contributability × mergeProbability) / 100`, and surfaces the best contribution opportunities.

## Tech Stack

- TypeScript 5.9 (strict, ESM, NodeNext)
- Node.js ≥22 (built-in `node:sqlite`)
- pnpm ≥10
- SQLite + FTS5 + sqlite-vec (vector search)
- node-llama-cpp (local embeddings, embeddinggemma-300m)
- gh CLI (GitHub API access, no SDK)
- eslint + typescript-eslint (linter)
- vitest (test runner)
- prettier (formatter)

## Commands

- `pnpm run verify` — typecheck + lint + test (canonical verification gate)
- `pnpm run typecheck` — `tsc --noEmit`
- `pnpm run lint` — eslint check
- `pnpm run lint:fix` — eslint autofix
- `pnpm test` — `vitest run`
- `pnpm run format:fix` — prettier fix
- `pnpm run format` — prettier check
- `pnpm run issue-lens` — run the CLI

## Prerequisites

- `gh` CLI must be installed and authenticated (`gh auth login`)

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, etc.)
- All CLI commands accept `--repo <owner/name>`, `--limit N`, `--json`, `--db <path>`
- Exit codes: 0 success, 1 error, 2 no results
- DB path: `~/.cache/issue-lens/repos/{safe_repo_name}.db`

## Architecture

- `src/cli.ts` — 10 CLI command handlers (init, sync, discover, search, show, related, xref, maintainers, status, config)
- `src/store.ts` — SQLite schema + CRUD (8 tables + FTS5 + vec0)
- `src/github.ts` — gh CLI wrapper with retry/pagination
- `src/store/` — scoring modules (priority, merge-probability, workability, maintainer, search)
- `src/lib/` — utilities (sqlite loader, text processing, concurrency pool, hybrid search fusion)
- `src/types.ts` — all domain types
- `src/embedding.ts` — local embedding provider

## Design References

- @DESIGN.md — full architecture, scoring formulas, data model, competitive analysis
- @skill/SKILL.md — AI agent skill definition with routing, workflows, score interpretation
- @HANDOFF.md — current status and next steps
