import type { DatabaseSync } from "node:sqlite";
import type { ProjectTopic, RepoRef } from "../types.js";
import { fetchDirectoryTree } from "../github.js";

const STRUCTURED_PREFIXES = new Set([
  "area",
  "component",
  "sig",
  "module",
  "scope",
  "pkg",
  "extensions",
  "channel",
  "app",
]);

const WORKFLOW_LABELS = new Set([
  "bug",
  "enhancement",
  "feature",
  "feature request",
  "question",
  "good first issue",
  "help wanted",
  "wontfix",
  "duplicate",
  "invalid",
  "stale",
  "unstale",
  "documentation",
  "dependencies",
  "needs-rebase",
  "needs-tests",
  "needs reproduction",
  "do-not-merge",
  "lgtm",
  "in progress",
  "keep-open",
  "rfc",
  "ready",
  "high",
  "medium",
  "low",
  "critical",
  "p0",
  "p1",
  "p2",
  "p3",
  "p4",
  "hacktoberfest",
  "hacktoberfest-accepted",
]);

const WORKFLOW_PREFIXES = new Set(["priority", "lifecycle", "kind", "ci"]);

const SKIP_DIRS = new Set([
  ".github",
  ".devcontainer",
  ".vscode",
  ".idea",
  "docs",
  "doc",
  "guides",
  "guide",
  "hack",
  "scripts",
  "vendor",
  "node_modules",
  "test",
  "tests",
  "examples",
  "example",
  "benchmarks",
  "benchmark",
  "docker",
  "cmake",
  "tools",
  "requirements",
  "assets",
  "third_party",
  ".circleci",
]);

type LabelCount = { label: string; count: number };

export function discoverLabelTopics(db: DatabaseSync): ProjectTopic[] {
  const rows = db
    .prepare(
      `SELECT value, COUNT(*) as cnt FROM (
         SELECT j.value as value FROM issues, json_each(issues.labels) as j
         WHERE issues.state = 'open'
       ) GROUP BY value ORDER BY cnt DESC`,
    )
    .all() as Array<{ value: string; cnt: number }>;

  const totalOpen = (
    db.prepare("SELECT COUNT(*) as c FROM issues WHERE state = 'open'").get() as { c: number }
  ).c;
  const threshold = Math.max(3, Math.floor(totalOpen * 0.005));

  const labelCounts: LabelCount[] = rows.map((r) => ({ label: r.value, count: r.cnt }));
  const topics: ProjectTopic[] = [];
  const now = new Date().toISOString();

  for (const { label, count } of labelCounts) {
    const classification = classifyLabel(label);
    if (classification === "workflow") continue;
    if (classification === "standalone" && count < threshold) continue;

    const name =
      classification === "structured" && label.includes("/")
        ? label.split("/").slice(1).join("/")
        : label;

    topics.push({
      id: `label:${label}`,
      name,
      source: "label",
      pattern: label,
      openIssueCount: count,
      recentPrCount: 0,
      activeMaintainers: [],
      discoveredAt: now,
    });
  }

  return topics;
}

function classifyLabel(label: string): "structured" | "standalone" | "workflow" {
  if (label.includes("/")) {
    const prefix = label.split("/")[0]!.toLowerCase();
    if (STRUCTURED_PREFIXES.has(prefix)) return "structured";
    if (WORKFLOW_PREFIXES.has(prefix)) return "workflow";
    return "structured";
  }
  if (WORKFLOW_LABELS.has(label.toLowerCase())) return "workflow";
  return "standalone";
}

export function discoverDirectoryTopics(
  allPaths: string[],
  existingTopicNames: Set<string>,
): ProjectTopic[] {
  const sourceRoot = detectSourceRoot(allPaths);
  if (!sourceRoot) return [];
  const targetDepth = sourceRoot.split("/").length + 1;

  const candidates = allPaths.filter((p) => {
    const parts = p.split("/");
    if (parts.length !== targetDepth) return false;
    const dirName = parts[parts.length - 1]!;
    if (dirName.startsWith(".")) return false;
    if (SKIP_DIRS.has(dirName.toLowerCase())) return false;
    if (!p.startsWith(sourceRoot + "/")) return false;
    return true;
  });

  if (candidates.length < 2) return [];

  const now = new Date().toISOString();
  return candidates
    .filter((p) => {
      const name = p.split("/").pop()!;
      return !existingTopicNames.has(name.toLowerCase());
    })
    .map((p) => {
      const name = p.split("/").pop()!;
      return {
        id: `dir:${p}`,
        name,
        source: "directory" as const,
        pattern: p,
        openIssueCount: 0,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: now,
      };
    });
}

function detectSourceRoot(paths: string[]): string | null {
  const depth1Dirs = paths.filter((p) => !p.includes("/") && !p.startsWith("."));
  const commonSourceRoots = ["src", "lib", "pkg", "packages", "crates", "internal", "cmd"];
  for (const root of commonSourceRoots) {
    if (depth1Dirs.includes(root)) {
      const children = paths.filter((p) => p.startsWith(root + "/") && p.split("/").length === 2);
      if (children.length >= 3) return root;
    }
  }

  const projectNameDirs = depth1Dirs.filter((d) => {
    const children = paths.filter((p) => p.startsWith(d + "/") && p.split("/").length === 2);
    return children.length >= 5 && !SKIP_DIRS.has(d.toLowerCase());
  });
  if (projectNameDirs.length === 1) return projectNameDirs[0]!;

  return null;
}

export function enrichTopics(db: DatabaseSync, topics: ProjectTopic[]): void {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  for (const topic of topics) {
    if (topic.source === "label") {
      const prRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM pull_requests
           WHERE state = 'merged' AND merged_at > ?
             AND json_extract(labels, '$') LIKE ?`,
        )
        .get(ninetyDaysAgo, `%${topic.pattern}%`) as { cnt: number };
      topic.recentPrCount = prRow.cnt;

      const maintainerRows = db
        .prepare(
          `SELECT DISTINCT ic.author FROM issue_comments ic
           JOIN issues i ON ic.issue_number = i.number
           WHERE ic.is_maintainer = 1
             AND ic.created_at > ?
             AND json_extract(i.labels, '$') LIKE ?
           LIMIT 10`,
        )
        .all(ninetyDaysAgo, `%${topic.pattern}%`) as Array<{ author: string }>;
      topic.activeMaintainers = maintainerRows.map((r) => r.author);
    }
  }
}

export async function discoverTopics(db: DatabaseSync, repo: RepoRef): Promise<ProjectTopic[]> {
  const labelTopics = discoverLabelTopics(db);

  let dirTopics: ProjectTopic[] = [];
  try {
    const tree = await fetchDirectoryTree(repo);
    const existingNames = new Set(labelTopics.map((t) => t.name.toLowerCase()));
    dirTopics = discoverDirectoryTopics(tree, existingNames);
  } catch (err) {
    process.stderr.write(
      `  Warning: could not fetch directory tree: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const all = [...labelTopics, ...dirTopics];
  enrichTopics(db, all);
  return all;
}
