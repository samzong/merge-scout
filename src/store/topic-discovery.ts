import type { DatabaseSync } from "node:sqlite";
import type { ProjectTopic, RepoRef } from "../types.js";
import { fetchRepoTree, fetchFileContent, type TreeInfo } from "../github.js";

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
  "testing",
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

const NOISE_SCOPES = new Set([
  "deps",
  "dep",
  "build",
  "ci",
  "cd",
  "docs",
  "doc",
  "e2e",
  "test",
  "tests",
  "testing",
  "release",
  "chore",
  "lint",
  "format",
  "typing",
  "types",
  "readme",
  "changelog",
  "license",
  "makefile",
  "docker",
  "script",
  "scripts",
  "misc",
  "cleanup",
  "refactor",
  "style",
  "perf",
  "revert",
  "merge",
  "wip",
  "nit",
  "typo",
  "vendor",
  "mod",
  "npm",
  "yarn",
  "pnpm",
  "pip",
  "cargo",
]);

const GENERIC_DIR_NAMES = new Set([
  "src",
  "lib",
  "main",
  "dist",
  "build",
  "out",
  "bin",
  "utils",
  "util",
]);

const COMMON_SOURCE_ROOTS = new Set(["src", "lib", "pkg", "packages", "crates", "internal", "cmd"]);

const MIN_SCOPE_COUNT = 3;

export function parseCodeowners(content: string): { path: string; owners: string[] }[] {
  const entries: { path: string; owners: string[] }[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const raw = parts[0]!;
    if (raw === "*" || raw.startsWith("!")) continue;
    let path = raw.replace(/^\//, "").replace(/\/$/, "");
    path = path.replace(/\/?\*\*$/, "").replace(/\/?\*$/, "");
    if (!path || !path.includes("/")) continue;
    if (path.includes("*")) continue;
    const owners = parts
      .slice(1)
      .filter((o) => o.startsWith("@"))
      .map((o) => o.slice(1));
    if (owners.length > 0) entries.push({ path, owners });
  }
  return entries;
}

export function discoverCodeownersTopics(content: string): ProjectTopic[] {
  const entries = parseCodeowners(content);
  const now = new Date().toISOString();
  return entries
    .filter((e) => !GENERIC_DIR_NAMES.has(e.path.split("/").pop()!.toLowerCase()))
    .map((e) => ({
      id: `codeowners:${e.path}`,
      name: e.path.split("/").pop()!,
      source: "codeowners" as const,
      pattern: e.path,
      openIssueCount: 0,
      recentPrCount: 0,
      activeMaintainers: e.owners,
      discoveredAt: now,
    }));
}

export function discoverOwnersDirTopics(
  ownersDirs: string[],
  existingNames: Set<string>,
): ProjectTopic[] {
  const now = new Date().toISOString();
  return ownersDirs
    .filter((d) => {
      if (d === "") return false;
      const parts = d.split("/");
      if (parts.length > 3) return false;
      if (parts.length === 1 && COMMON_SOURCE_ROOTS.has(parts[0]!.toLowerCase())) return false;
      if (parts.some((p) => SKIP_DIRS.has(p.toLowerCase()))) return false;
      const name = parts[parts.length - 1]!;
      if (GENERIC_DIR_NAMES.has(name.toLowerCase())) return false;
      return !existingNames.has(name.toLowerCase());
    })
    .map((d) => ({
      id: `codeowners:${d}`,
      name: d.split("/").pop()!,
      source: "codeowners" as const,
      pattern: d,
      openIssueCount: 0,
      recentPrCount: 0,
      activeMaintainers: [],
      discoveredAt: now,
    }));
}

export function discoverPrScopeTopics(db: DatabaseSync): ProjectTopic[] {
  const rows = db
    .prepare(
      `SELECT
        SUBSTR(title, INSTR(title,'(')+1, INSTR(title,')')-INSTR(title,'(')-1) as scope,
        COUNT(*) as cnt
      FROM pull_requests
      WHERE title LIKE '%(%):%'
        AND LENGTH(SUBSTR(title, INSTR(title,'(')+1, INSTR(title,')')-INSTR(title,'(')-1)) BETWEEN 2 AND 30
      GROUP BY scope
      HAVING COUNT(*) >= ?
      ORDER BY cnt DESC`,
    )
    .all(MIN_SCOPE_COUNT) as Array<{ scope: string; cnt: number }>;

  const now = new Date().toISOString();
  return rows
    .filter((r) => !NOISE_SCOPES.has(r.scope.toLowerCase()))
    .map((r) => ({
      id: `pr-scope:${r.scope}`,
      name: r.scope,
      source: "pr-scope" as const,
      pattern: r.scope,
      openIssueCount: 0,
      recentPrCount: r.cnt,
      activeMaintainers: [],
      discoveredAt: now,
    }));
}

export function discoverDirectoryTopics(
  allPaths: string[],
  existingNames: Set<string>,
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
    if (GENERIC_DIR_NAMES.has(dirName.toLowerCase())) return false;
    if (!p.startsWith(sourceRoot + "/")) return false;
    return true;
  });

  if (candidates.length < 2) return [];

  const now = new Date().toISOString();
  return candidates
    .filter((p) => !existingNames.has(p.split("/").pop()!.toLowerCase()))
    .map((p) => ({
      id: `dir:${p}`,
      name: p.split("/").pop()!,
      source: "directory" as const,
      pattern: p,
      openIssueCount: 0,
      recentPrCount: 0,
      activeMaintainers: [],
      discoveredAt: now,
    }));
}

function detectSourceRoot(paths: string[]): string | null {
  const depth1Dirs = paths.filter((p) => !p.includes("/") && !p.startsWith("."));
  for (const root of COMMON_SOURCE_ROOTS) {
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
    const nameLike = `%${topic.name.toLowerCase()}%`;

    if (topic.openIssueCount === 0) {
      const row = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM issues
           WHERE state = 'open' AND (LOWER(title) LIKE ? OR LOWER(body) LIKE ?)`,
        )
        .get(nameLike, nameLike) as { cnt: number };
      topic.openIssueCount = row.cnt;
    }

    if (topic.recentPrCount === 0) {
      const row = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM pull_requests
           WHERE state = 'merged' AND merged_at > ? AND LOWER(title) LIKE ?`,
        )
        .get(ninetyDaysAgo, nameLike) as { cnt: number };
      topic.recentPrCount = row.cnt;
    }

    if (topic.activeMaintainers.length === 0) {
      const rows = db
        .prepare(
          `SELECT DISTINCT ic.author FROM issue_comments ic
           JOIN issues i ON ic.issue_number = i.number
           WHERE ic.is_maintainer = 1 AND ic.created_at > ?
             AND (LOWER(i.title) LIKE ? OR LOWER(i.body) LIKE ?)
           LIMIT 10`,
        )
        .all(ninetyDaysAgo, nameLike, nameLike) as Array<{ author: string }>;
      topic.activeMaintainers = rows.map((r) => r.author);
    }
  }
}

export async function discoverTopics(db: DatabaseSync, repo: RepoRef): Promise<ProjectTopic[]> {
  const seen = new Map<string, ProjectTopic>();

  function merge(topics: ProjectTopic[]) {
    for (const t of topics) {
      const key = t.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, t);
    }
  }

  let tree: TreeInfo | null = null;
  try {
    tree = await fetchRepoTree(repo);

    if (tree.codeownersPath) {
      const content = await fetchFileContent(repo, tree.codeownersPath);
      if (content) merge(discoverCodeownersTopics(content));
    }

    if (tree.ownersDirs.length > 1) {
      const existingNames = new Set([...seen.values()].map((t) => t.name.toLowerCase()));
      merge(discoverOwnersDirTopics(tree.ownersDirs, existingNames));
    }
  } catch (err) {
    process.stderr.write(
      `  Warning: could not fetch repo tree: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  merge(discoverPrScopeTopics(db));

  if (tree) {
    const existingNames = new Set([...seen.values()].map((t) => t.name.toLowerCase()));
    merge(discoverDirectoryTopics(tree.directories, existingNames));
  }

  const all = [...seen.values()];
  enrichTopics(db, all);
  return all;
}
