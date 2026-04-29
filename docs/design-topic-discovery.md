# Project Topic Discovery — Design Document

> Status: Draft
> Date: 2026-03-30
> Replaces: `contributor_modules` (manual glob pattern configuration)

## Problem

MergeScout's target user is a contributor who is **not familiar** with a project's internal structure. The current `contributor_modules` system requires users to manually configure glob patterns like `src/scheduler/**` — but a user who knows the codebase that well doesn't need MergeScout to find issues.

The abstraction is wrong: contributors care about **topics** (e.g., "scheduling", "GPU memory", "security"), not code paths. The system should discover what topics exist in a project and let the user pick from them.

## Real-World Label Taxonomy Survey

Surveyed four active open-source projects (2026-03-30):

| Project                   | Label strategy    | Structured prefixes                        | Standalone topic labels                                         | Directory-based modules                |
| ------------------------- | ----------------- | ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------- |
| **kubernetes/kubernetes** | Highly structured | `area/36`, `sig/4`, `kind/5`, `priority/4` | Very few                                                        | Not needed (labels sufficient)         |
| **openclaw/openclaw**     | Semi-structured   | `channel/16`, `extensions/12`, `app/4`     | Moderate                                                        | Supplemental value                     |
| **llm-d/llm-d**           | Minimal structure | Almost none (1 `lifecycle/` prefix)        | 41 standalone labels                                            | Primary signal needed                  |
| **vllm-project/vllm**     | Flat but rich     | Only `ci/build`                            | 31 topical labels (`rocm`, `tpu`, `speculative-decoding`, etc.) | High value (`vllm/` has 30 submodules) |

### Key findings

1. **Label-only discovery fails on ~50% of projects** — llm-d and vllm have almost no structured prefixes.
2. **Standalone labels need filtering** — workflow/process labels (`claude-code-assisted`, `fb-exported`, `needs-rebase`) are noise. Can't use a static blocklist because every project invents its own workflow labels.
3. **Directory structure provides a reliable fallback** — even when labels are sparse, top-level code directories reflect real modules.
4. **Natural correspondences exist but aren't string-matchable** — vllm's `multi-modality` label maps to `vllm/multimodal/` directory, `tool-calling` maps to `vllm/tool_parsers/`. Too fragile to auto-merge; present as separate topics.

## Design

### Core Concept

Replace `contributor_modules` (user provides glob patterns) with:

- **`project_topics`** — system-discovered areas of the project
- **`contributor_interests`** — user-selected topics they care about

```
sync → discover topics → user selects interests → affinity scoring
```

### Topic Discovery Sources

| Source                       | Signal                                                                                              | Cost                  | When useful                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| 1. Structured labels         | `area/*`, `component/*`, `sig/*`, `scope/*`, `pkg/*`, `extensions/*`, `channel/*`, `app/*` prefixes | Zero (already synced) | kubernetes-style projects                                   |
| 2. Standalone topical labels | Labels on >= N open issues, excluding known workflow labels                                         | Zero (already synced) | vllm-style projects                                         |
| 3. Repository directory tree | Top-level code directories via GitHub Trees API                                                     | 1 API call            | All projects as fallback; primary for label-sparse projects |

Not included in MVP (v2): semantic clustering of issue embeddings.

### Label Classification

```
STEP 1 — Extract structured prefix labels:
  For each label with "/" separator:
    If prefix in {area, component, sig, module, scope, pkg, extensions, channel, app}:
      → topic candidate (source = "label")
    Else (e.g., lifecycle/stale, priority/P1, kind/bug, ci/build):
      → skip (workflow prefix)

STEP 2 — Filter standalone labels:
  Known workflow labels (hardcoded, universal across GitHub):
    bug, enhancement, feature, feature request, question,
    good first issue, help wanted, wontfix, duplicate, invalid,
    stale, unstale, documentation, dependencies,
    needs-rebase, needs-tests, needs reproduction,
    do-not-merge, lgtm, In Progress, keep-open,
    RFC, ready

  For each remaining standalone label:
    Count open issues with this label.
    If count >= threshold (dynamic: max(3, total_open_issues * 0.5%)):
      → topic candidate (source = "label")
    Else:
      → skip (too rare to be a meaningful topic)

STEP 3 — Directory tree enrichment:
  Fetch: gh api repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1
  Extract directories at depth 1-2 under the main source root.
  Skip: .github, docs, hack, scripts, vendor, node_modules, test(s), examples,
         benchmarks, docker, cmake, tools, requirements, .devcontainer, assets

  For each remaining directory:
    If it has siblings (i.e., multiple modules at the same level):
      → topic candidate (source = "directory")
```

### Threshold Rationale

The open-issue-count threshold for standalone labels is dynamic:

- `max(3, floor(total_open_issues * 0.005))`
- For a repo with 200 open issues: threshold = 3 (small repo, keep more topics)
- For a repo with 24,000 open issues: threshold = 120 (large repo, filter noise)

This prevents one-off labels from cluttering the topic list while keeping small-repo topics discoverable.

### Topic Enrichment

Each discovered topic is enriched with context that helps the user decide:

```
For each topic:
  open_issue_count   — how many open issues have this label (label topics)
                        or mention this directory (directory topics)
  recent_pr_count    — merged PRs in last 90 days touching this area
  active_maintainers — maintainers active in this area (from maintainer table)
```

### Data Model

```sql
-- Replaces contributor_modules
CREATE TABLE project_topics (
  id TEXT PRIMARY KEY,                  -- 'label:area/scheduler' or 'dir:vllm/distributed'
  name TEXT NOT NULL,                   -- 'scheduler' or 'distributed' (human-readable)
  source TEXT NOT NULL,                 -- 'label' | 'directory'
  pattern TEXT NOT NULL,                -- original label name or directory path
  open_issue_count INTEGER DEFAULT 0,
  recent_pr_count INTEGER DEFAULT 0,
  active_maintainers TEXT DEFAULT '[]', -- JSON array of logins
  discovered_at TEXT NOT NULL
);

CREATE TABLE contributor_interests (
  topic_id TEXT NOT NULL REFERENCES project_topics(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (topic_id)
);
```

Migration: drop `contributor_modules` table, create the two new tables. Existing DBs will re-discover topics on next sync.

### CLI Commands

```
merge-scout config topics   --repo <R> [--json]   List discovered project topics
merge-scout config select   <topic> ... --repo <R> Add topics to contributor interests
merge-scout config deselect <topic> ... --repo <R> Remove topics from interests
merge-scout config interests --repo <R> [--json]   List current contributor interests
```

`config` with no subcommand shows current interests (backward-compatible behavior).

### Sync Integration

Topic discovery runs at the end of the sync pipeline, after all data is available:

```
sync pipeline:
  1. sync-issues
  2. sync-prs
  3. sync-maintainers
  4. sync-xrefs
  5. sync-comments
  6. sync-embeddings
  7. discover-topics  ← NEW (label scan + 1 tree API call)
```

Discovery is idempotent: re-running replaces the `project_topics` table contents. User selections in `contributor_interests` are preserved (foreign key references topic IDs that are stable across rediscovery since IDs are deterministic: `label:{label_name}` or `dir:{path}`).

### Affinity Computation

Replaces `computeModuleAffinity` in `src/store/priority.ts`:

```ts
function computeTopicAffinity(issue: IssueRecord, interests: ProjectTopic[]): ModuleAffinity {
  if (interests.length === 0) return { matched: false, modules: [], score: 0 };

  const matched: string[] = [];
  for (const topic of interests) {
    if (topic.source === "label") {
      // Exact label match — zero false positives
      if (issue.labels.some((l) => l === topic.pattern)) {
        matched.push(topic.name);
      }
    } else if (topic.source === "directory") {
      // Check if issue body/title mentions the directory path
      const text = `${issue.title} ${issue.body ?? ""}`;
      if (text.includes(topic.pattern)) {
        matched.push(topic.name);
      }
    }
  }

  const score = matched.length > 0 ? Math.min(1, matched.length / interests.length + 0.3) : 0;
  return { matched: matched.length > 0, modules: matched, score };
}
```

Key improvement: label-based topics use **exact label match** on `issue.labels` instead of keyword substring hacking on issue text.

### AI Agent Workflow

The primary interaction path (via SKILL.md):

```
AI → merge-scout config topics --repo R --json
     → { topics: [{ id, name, source, openIssueCount, activeMaintainers, ... }] }

AI → "This project has these active areas:
      1. scheduler (47 open issues, maintainers @alice @bob active)
      2. networking (32 open issues, maintainer @charlie active)
      3. gpu-memory (28 open issues, no active maintainer !)
      Which areas interest you?"

User → "scheduler and networking"

AI → merge-scout config select scheduler networking --repo R
```

### Output Format

#### `config topics --json`

```json
{
  "repo": "vllm-project/vllm",
  "topicCount": 42,
  "topics": [
    {
      "id": "label:rocm",
      "name": "rocm",
      "source": "label",
      "pattern": "rocm",
      "openIssueCount": 89,
      "recentPrCount": 23,
      "activeMaintainers": ["alice", "bob"]
    },
    {
      "id": "dir:vllm/distributed",
      "name": "distributed",
      "source": "directory",
      "pattern": "vllm/distributed",
      "openIssueCount": 0,
      "recentPrCount": 0,
      "activeMaintainers": []
    }
  ]
}
```

Note: directory-sourced topics may have `openIssueCount: 0` since they are discovered structurally, not from issue labels. Their value is in affinity matching (issues that mention the directory path in their body).

## Files Changed

| File                           | Change                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                 | Add `ProjectTopic` type                                                                                     |
| `src/store.ts`                 | Replace `contributor_modules` with `project_topics` + `contributor_interests` tables; add CRUD methods      |
| `src/store/topic-discovery.ts` | **New** — `discoverTopics()`: label classification + tree API + enrichment                                  |
| `src/store/priority.ts`        | `computeModuleAffinity` → `computeTopicAffinity`; `buildDiscoverResults` reads interests instead of modules |
| `src/cli.ts`                   | `handleConfig` → subcommands (topics/select/deselect/interests); `handleSync` calls `discoverTopics` at end |
| `src/github.ts`                | Add `fetchDirectoryTree()` helper                                                                           |
| `skills/merge-scout/SKILL.md`  | Update config workflow                                                                                      |
| Tests                          | Update `priority.test.ts`; add `topic-discovery.test.ts`                                                    |

## Not Doing

- **Semantic clustering** — v2. Requires k-means + cluster count selection. Embeddings are already in DB for when we're ready.
- **Auto-infer user interests from git log** — v2. Requires local clone.
- **Label-to-directory auto-mapping** — too fragile. Present as separate topics; let users select both if they want.
- **TUI interactive picker** — AI agent is the interaction layer.

## Validation Results

### llm-d/llm-d (249 issues, label-sparse)

**Round 1 (19 topics) — problems found:**

- `medium`, `high` discovered as topics → actually priority labels. Fixed: added to workflow blocklist.
- `hacktoberfest-accepted` discovered → event label, not a topic. Fixed: added to workflow blocklist.
- 10 `guides/*` directory topics discovered → `guides/` detected as source root because it had >= 5 subdirectories. Fixed: added `guides` to SKIP_DIRS; also changed behavior to return no directory topics when no source root is found (top-level dirs of non-code repos are mostly infra).

**Round 2 (6 topics) — clean:**

- `automation` (18), `upstream-breaking-change` (18), `upstream-update` (12), `agentic-workflows` (8), `Image builds` (5), `official-guides` (4)
- No directory topics (correct — llm-d has no standard source root)
- Affinity scoring verified: selecting `automation` + `agentic-workflows` correctly boosts 9 matching issues by +20 points

### cli/cli (pending — syncing)

Target: validate directory topic discovery with `pkg/`, `cmd/`, `internal/` source roots, and standalone topical labels (`auth`, `core`, `codespaces`, etc.).

## Open Questions

1. Should directory topics also check linked PR file paths (from `issue_pr_xref` → `pull_requests`) for affinity? Would improve recall for label-sparse repos but adds a JOIN.
2. How to handle topic ID stability when a project renames a label? Current design: old topic ID becomes orphaned, new one is created, user interest on old ID is silently lost. Acceptable for MVP.
