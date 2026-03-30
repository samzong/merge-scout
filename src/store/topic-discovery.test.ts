import { describe, it, expect } from "vitest";
import {
  parseCodeowners,
  discoverCodeownersTopics,
  discoverOwnersDirTopics,
  discoverPrScopeTopics,
  discoverDirectoryTopics,
  enrichTopics,
} from "./topic-discovery.js";
import { computeTopicAffinity } from "./priority.js";
import { MergeScoutStore } from "../store.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IssueRecord, ProjectTopic } from "../types.js";

function makeTempStore(): MergeScoutStore {
  const dir = mkdtempSync(join(tmpdir(), "ms-topic-test-"));
  const store = new MergeScoutStore({ dbPath: join(dir, "test.db") });
  store.init();
  return store;
}

function makeIssue(n: number, labels: string[], body = ""): IssueRecord {
  return {
    number: n,
    title: `Issue ${n}`,
    body,
    state: "open",
    author: "user",
    assignee: null,
    labels,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-25T00:00:00Z",
    closedAt: null,
    url: `https://github.com/test/test/issues/${n}`,
    commentCount: 0,
  };
}

describe("parseCodeowners", () => {
  it("parses standard directory entries", () => {
    const content = [
      "* @global-owner",
      "/pkg/scheduler/ @alice @bob",
      "/internal/codespaces/ @cli/codespaces",
    ].join("\n");
    const entries = parseCodeowners(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ path: "pkg/scheduler", owners: ["alice", "bob"] });
    expect(entries[1]).toEqual({ path: "internal/codespaces", owners: ["cli/codespaces"] });
  });

  it("skips glob patterns and single-file entries", () => {
    const content = [
      "*.js @frontend",
      "/docs/ @docs-team",
      "/pkg/api/ @api-team",
      "!excluded/ @nobody",
    ].join("\n");
    const entries = parseCodeowners(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("pkg/api");
  });

  it("strips trailing glob suffixes", () => {
    const content = "/packages/desktop/src/main/ws/** @samzong";
    const entries = parseCodeowners(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("packages/desktop/src/main/ws");
  });

  it("skips comments and blank lines", () => {
    const content = ["# This is a comment", "", "/pkg/core/ @team"].join("\n");
    const entries = parseCodeowners(content);
    expect(entries).toHaveLength(1);
  });
});

describe("discoverCodeownersTopics", () => {
  it("creates topics with owners from CODEOWNERS content", () => {
    const content = [
      "* @global",
      "/pkg/scheduler/ @alice @bob",
      "/internal/codespaces/ @cli/codespaces",
    ].join("\n");
    const topics = discoverCodeownersTopics(content);
    expect(topics).toHaveLength(2);
    expect(topics[0]!.name).toBe("scheduler");
    expect(topics[0]!.source).toBe("codeowners");
    expect(topics[0]!.activeMaintainers).toEqual(["alice", "bob"]);
    expect(topics[1]!.name).toBe("codespaces");
  });

  it("filters out generic directory names", () => {
    const content = "/packages/shared/src/** @samzong";
    const topics = discoverCodeownersTopics(content);
    expect(topics).toHaveLength(0);
  });
});

describe("discoverOwnersDirTopics", () => {
  it("creates topics from OWNERS directories", () => {
    const dirs = ["", "cmd", "cmd/kueueviz", "pkg", "pkg/controller", "pkg/webhooks"];
    const topics = discoverOwnersDirTopics(dirs, new Set());
    const names = topics.map((t) => t.name);
    expect(names).toContain("kueueviz");
    expect(names).toContain("controller");
    expect(names).toContain("webhooks");
    expect(names).not.toContain("cmd");
    expect(names).not.toContain("pkg");
  });

  it("skips root, SKIP_DIRS, and existing names", () => {
    const dirs = ["", "pkg/test", "pkg/vendor", "pkg/scheduler"];
    const topics = discoverOwnersDirTopics(dirs, new Set(["scheduler"]));
    expect(topics).toHaveLength(0);
  });

  it("skips deep paths (>3 segments)", () => {
    const dirs = ["pkg/a/b/c/deep"];
    const topics = discoverOwnersDirTopics(dirs, new Set());
    expect(topics).toHaveLength(0);
  });
});

describe("discoverPrScopeTopics", () => {
  it("extracts scopes from PR titles", () => {
    const store = makeTempStore();
    for (let i = 1; i <= 5; i++) {
      store.upsertPr({
        number: i,
        title: `fix(scheduler): fix bug ${i}`,
        state: "merged",
        author: "alice",
        mergedBy: null,
        mergedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        labels: [],
        linkedIssues: [],
      });
    }
    const topics = discoverPrScopeTopics(store.db);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.name).toBe("scheduler");
    expect(topics[0]!.source).toBe("pr-scope");
    expect(topics[0]!.recentPrCount).toBe(5);
  });

  it("filters noise scopes", () => {
    const store = makeTempStore();
    for (let i = 1; i <= 5; i++) {
      store.upsertPr({
        number: i,
        title: `chore(deps): bump dependency ${i}`,
        state: "merged",
        author: "bot",
        mergedBy: null,
        mergedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        labels: [],
        linkedIssues: [],
      });
    }
    const topics = discoverPrScopeTopics(store.db);
    expect(topics).toHaveLength(0);
  });

  it("applies minimum count threshold", () => {
    const store = makeTempStore();
    store.upsertPr({
      number: 1,
      title: "fix(rare-module): fix something",
      state: "merged",
      author: "alice",
      mergedBy: null,
      mergedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      labels: [],
      linkedIssues: [],
    });
    const topics = discoverPrScopeTopics(store.db);
    expect(topics).toHaveLength(0);
  });
});

describe("discoverDirectoryTopics", () => {
  it("discovers directories under detected source root", () => {
    const tree = ["src", "src/scheduler", "src/networking", "src/security", "docs", "tests"];
    const topics = discoverDirectoryTopics(tree, new Set());
    const names = topics.map((t) => t.name);
    expect(names).toContain("scheduler");
    expect(names).toContain("networking");
    expect(names).toContain("security");
    expect(names).not.toContain("docs");
    expect(names).not.toContain("tests");
  });

  it("skips directory topics whose names collide with existing topics", () => {
    const tree = ["src", "src/scheduler", "src/networking", "src/security"];
    const existing = new Set(["scheduler"]);
    const topics = discoverDirectoryTopics(tree, existing);
    const names = topics.map((t) => t.name);
    expect(names).not.toContain("scheduler");
    expect(names).toContain("networking");
    expect(names).toContain("security");
  });

  it("detects project-name source root", () => {
    const tree = [
      "benchmarks",
      "docs",
      "tests",
      "vllm",
      "vllm/distributed",
      "vllm/engine",
      "vllm/kernels",
      "vllm/lora",
      "vllm/multimodal",
    ];
    const topics = discoverDirectoryTopics(tree, new Set());
    const names = topics.map((t) => t.name);
    expect(names).toContain("distributed");
    expect(names).toContain("engine");
    expect(names).not.toContain("benchmarks");
  });
});

describe("computeTopicAffinity", () => {
  it("returns no match when no interests configured", () => {
    const issue = makeIssue(1, ["area/scheduler"]);
    const result = computeTopicAffinity(issue, []);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(0);
  });

  it("matches via issue body text (path pattern)", () => {
    const issue = makeIssue(1, [], "Error in pkg/scheduler when processing jobs");
    const interests: ProjectTopic[] = [
      {
        id: "codeowners:pkg/scheduler",
        name: "scheduler",
        source: "codeowners",
        pattern: "pkg/scheduler",
        openIssueCount: 10,
        recentPrCount: 5,
        activeMaintainers: ["alice"],
        discoveredAt: "2026-03-30T00:00:00Z",
      },
    ];
    const result = computeTopicAffinity(issue, interests);
    expect(result.matched).toBe(true);
    expect(result.modules).toEqual(["scheduler"]);
  });

  it("matches via issue labels", () => {
    const issue = makeIssue(1, ["area/scheduler", "bug"]);
    const interests: ProjectTopic[] = [
      {
        id: "pr-scope:scheduler",
        name: "scheduler",
        source: "pr-scope",
        pattern: "scheduler",
        openIssueCount: 10,
        recentPrCount: 5,
        activeMaintainers: [],
        discoveredAt: "2026-03-30T00:00:00Z",
      },
    ];
    const result = computeTopicAffinity(issue, interests);
    expect(result.matched).toBe(true);
  });

  it("does not false-positive on unrelated content", () => {
    const issue = makeIssue(1, ["networking"], "Fix network timeout");
    const interests: ProjectTopic[] = [
      {
        id: "dir:pkg/scheduler",
        name: "scheduler",
        source: "directory",
        pattern: "pkg/scheduler",
        openIssueCount: 0,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: "2026-03-30T00:00:00Z",
      },
    ];
    const result = computeTopicAffinity(issue, interests);
    expect(result.matched).toBe(false);
  });
});

describe("enrichTopics", () => {
  it("counts open issues mentioning topic name", () => {
    const store = makeTempStore();
    store.upsertIssue(makeIssue(1, [], "Bug in scheduler component"));
    store.upsertIssue(makeIssue(2, [], "Scheduler performance issue"));
    store.upsertIssue(makeIssue(3, [], "Unrelated bug"));
    const topics: ProjectTopic[] = [
      {
        id: "dir:pkg/scheduler",
        name: "scheduler",
        source: "directory",
        pattern: "pkg/scheduler",
        openIssueCount: 0,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: new Date().toISOString(),
      },
    ];
    enrichTopics(store.db, topics);
    expect(topics[0]!.openIssueCount).toBe(2);
  });

  it("preserves pre-set maintainers from CODEOWNERS", () => {
    const store = makeTempStore();
    const topics: ProjectTopic[] = [
      {
        id: "codeowners:pkg/scheduler",
        name: "scheduler",
        source: "codeowners",
        pattern: "pkg/scheduler",
        openIssueCount: 0,
        recentPrCount: 0,
        activeMaintainers: ["alice", "bob"],
        discoveredAt: new Date().toISOString(),
      },
    ];
    enrichTopics(store.db, topics);
    expect(topics[0]!.activeMaintainers).toEqual(["alice", "bob"]);
  });

  it("counts recent merged PRs for topic", () => {
    const store = makeTempStore();
    store.upsertPr({
      number: 100,
      title: "fix(scheduler): fix race condition",
      state: "merged",
      author: "alice",
      mergedBy: null,
      mergedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      labels: [],
      linkedIssues: [],
    });
    const topics: ProjectTopic[] = [
      {
        id: "dir:pkg/scheduler",
        name: "scheduler",
        source: "directory",
        pattern: "pkg/scheduler",
        openIssueCount: 0,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: new Date().toISOString(),
      },
    ];
    enrichTopics(store.db, topics);
    expect(topics[0]!.recentPrCount).toBe(1);
  });
});
