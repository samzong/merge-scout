import { describe, it, expect } from "vitest";
import { discoverLabelTopics, discoverDirectoryTopics, enrichTopics } from "./topic-discovery.js";
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

describe("discoverLabelTopics", () => {
  it("discovers structured prefix labels", () => {
    const store = makeTempStore();
    for (let i = 1; i <= 5; i++) {
      store.upsertIssue(makeIssue(i, ["area/scheduler"]));
    }
    const topics = discoverLabelTopics(store.db);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.id).toBe("label:area/scheduler");
    expect(topics[0]!.name).toBe("scheduler");
    expect(topics[0]!.openIssueCount).toBe(5);
  });

  it("filters out workflow labels", () => {
    const store = makeTempStore();
    for (let i = 1; i <= 10; i++) {
      store.upsertIssue(makeIssue(i, ["bug", "good first issue", "performance"]));
    }
    const topics = discoverLabelTopics(store.db);
    const names = topics.map((t) => t.pattern);
    expect(names).not.toContain("bug");
    expect(names).not.toContain("good first issue");
    expect(names).toContain("performance");
  });

  it("filters out standalone labels below threshold", () => {
    const store = makeTempStore();
    store.upsertIssue(makeIssue(1, ["rare-label"]));
    store.upsertIssue(makeIssue(2, ["rare-label"]));
    for (let i = 3; i <= 10; i++) {
      store.upsertIssue(makeIssue(i, ["common-label"]));
    }
    const topics = discoverLabelTopics(store.db);
    const names = topics.map((t) => t.pattern);
    expect(names).toContain("common-label");
    expect(names).not.toContain("rare-label");
  });

  it("filters out workflow prefix labels", () => {
    const store = makeTempStore();
    for (let i = 1; i <= 5; i++) {
      store.upsertIssue(makeIssue(i, ["priority/P1", "lifecycle/stale"]));
    }
    const topics = discoverLabelTopics(store.db);
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

  it("skips directory topics whose names collide with existing label topics", () => {
    const tree = ["src", "src/scheduler", "src/networking", "src/security"];
    const existing = new Set(["scheduler"]);
    const topics = discoverDirectoryTopics(tree, existing);
    const names = topics.map((t) => t.name);
    expect(names).not.toContain("scheduler");
    expect(names).toContain("networking");
    expect(names).toContain("security");
  });

  it("detects project-name source root like vllm/", () => {
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

  it("matches label-based topics exactly", () => {
    const issue = makeIssue(1, ["rocm", "bug"]);
    const interests: ProjectTopic[] = [
      {
        id: "label:rocm",
        name: "rocm",
        source: "label",
        pattern: "rocm",
        openIssueCount: 10,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: "2026-03-30T00:00:00Z",
      },
    ];
    const result = computeTopicAffinity(issue, interests);
    expect(result.matched).toBe(true);
    expect(result.modules).toEqual(["rocm"]);
    expect(result.score).toBeGreaterThan(0);
  });

  it("does not false-positive on partial label match", () => {
    const issue = makeIssue(1, ["rocm-experimental"]);
    const interests: ProjectTopic[] = [
      {
        id: "label:rocm",
        name: "rocm",
        source: "label",
        pattern: "rocm",
        openIssueCount: 10,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: "2026-03-30T00:00:00Z",
      },
    ];
    const result = computeTopicAffinity(issue, interests);
    expect(result.matched).toBe(false);
  });

  it("matches directory-based topics via body text", () => {
    const issue = makeIssue(1, [], "Error in vllm/distributed when using 2 GPUs");
    const interests: ProjectTopic[] = [
      {
        id: "dir:vllm/distributed",
        name: "distributed",
        source: "directory",
        pattern: "vllm/distributed",
        openIssueCount: 0,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: "2026-03-30T00:00:00Z",
      },
    ];
    const result = computeTopicAffinity(issue, interests);
    expect(result.matched).toBe(true);
    expect(result.modules).toEqual(["distributed"]);
  });
});

describe("enrichTopics", () => {
  it("counts recent PRs for label topics", () => {
    const store = makeTempStore();
    store.upsertPr({
      number: 100,
      title: "fix scheduler",
      state: "merged",
      author: "alice",
      mergedBy: null,
      mergedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      labels: ["area/scheduler"],
      linkedIssues: [],
    });
    const topics: ProjectTopic[] = [
      {
        id: "label:area/scheduler",
        name: "scheduler",
        source: "label",
        pattern: "area/scheduler",
        openIssueCount: 5,
        recentPrCount: 0,
        activeMaintainers: [],
        discoveredAt: new Date().toISOString(),
      },
    ];
    enrichTopics(store.db, topics);
    expect(topics[0]!.recentPrCount).toBe(1);
  });
});
