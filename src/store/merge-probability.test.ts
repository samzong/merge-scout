import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MergeScoutStore } from "../store.js";
import { computeMergeProbability } from "./merge-probability.js";
import type { IssueRecord, MaintainerProfile } from "../types.js";

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number: 100,
    title: "Test issue",
    body: "Test body",
    state: "open",
    author: "user1",
    assignee: null,
    labels: ["bug"],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-25T00:00:00Z",
    closedAt: null,
    url: "https://github.com/test/test/issues/100",
    commentCount: 3,
    ...overrides,
  };
}

function makeMaintainer(overrides: Partial<MaintainerProfile> = {}): MaintainerProfile {
  return {
    login: "alice",
    role: "merger",
    modules: [],
    mergeCount90d: 10,
    issueReplyCount90d: 5,
    avgResponseDays: 2,
    lastActiveAt: "2026-03-28T00:00:00Z",
    ...overrides,
  };
}

const now = new Date("2026-03-29T12:00:00Z");

describe("computeMergeProbability", () => {
  let store: MergeScoutStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "merge-scout-test-"));
    store = new MergeScoutStore({ dbPath: join(tmpDir, "test.db") });
    await store.init();
  });

  it("gives low base score with no signals", () => {
    const issue = makeIssue({ labels: [], commentCount: 0 });
    const result = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [],
      now,
    });
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.topFactors).toContain("No active mergers identified");
  });

  it("fast maintainer reply scores higher than slow reply", () => {
    const issue = makeIssue({ createdAt: "2026-03-20T00:00:00Z" });
    store.upsertIssue(issue);

    store.upsertComment({
      id: 1,
      issueNumber: 100,
      author: "alice",
      body: "Looking into this",
      createdAt: "2026-03-21T00:00:00Z",
      isMaintainer: true,
    });
    store.updateMaintainerReplyStats(100);

    const fastReply = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [makeMaintainer()],
      now,
    });

    store.db.prepare("DELETE FROM issue_comments").run();
    store.upsertComment({
      id: 2,
      issueNumber: 100,
      author: "alice",
      body: "Looking into this",
      createdAt: "2026-03-28T00:00:00Z",
      isMaintainer: true,
    });
    store.updateMaintainerReplyStats(100);

    const slowReplyIssue = makeIssue({ createdAt: "2026-03-10T00:00:00Z" });
    const slowReply = computeMergeProbability({
      db: store.db,
      issue: slowReplyIssue,
      maintainers: [makeMaintainer()],
      now,
    });

    expect(fastReply.score).toBeGreaterThan(slowReply.score);
  });

  it("multiple maintainer replies boost score", () => {
    const issue = makeIssue({ createdAt: "2026-03-20T00:00:00Z" });
    store.upsertIssue(issue);

    store.upsertComment({
      id: 1,
      issueNumber: 100,
      author: "alice",
      body: "Looking into this",
      createdAt: "2026-03-21T00:00:00Z",
      isMaintainer: true,
    });
    store.updateMaintainerReplyStats(100);

    const oneReply = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [makeMaintainer()],
      now,
    });

    for (let i = 2; i <= 5; i++) {
      store.upsertComment({
        id: i,
        issueNumber: 100,
        author: "alice",
        body: `Follow up ${i}`,
        createdAt: `2026-03-${20 + i}T00:00:00Z`,
        isMaintainer: true,
      });
    }
    store.updateMaintainerReplyStats(100);

    const manyReplies = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [makeMaintainer()],
      now,
    });

    expect(manyReplies.score).toBeGreaterThan(oneReply.score);
  });

  it("penalizes no maintainer response after 30+ days", () => {
    const issue = makeIssue({ createdAt: "2026-01-01T00:00:00Z" });
    const maintainer = makeMaintainer();

    const result = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [maintainer],
      now,
    });
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.topFactors.some((f) => f.includes("No maintainer response"))).toBe(true);
  });

  it("score does not saturate at 100 for typical good issues", () => {
    const issue = makeIssue({ createdAt: "2026-03-25T00:00:00Z" });
    store.upsertIssue(issue);

    store.upsertComment({
      id: 1,
      issueNumber: 100,
      author: "alice",
      body: "Confirmed",
      createdAt: "2026-03-26T00:00:00Z",
      isMaintainer: true,
    });
    store.updateMaintainerReplyStats(100);

    const result = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [makeMaintainer()],
      now,
    });
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("penalizes high comment count", () => {
    const base = makeIssue({ commentCount: 2, createdAt: "2026-03-20T00:00:00Z" });
    const controversial = makeIssue({ commentCount: 25, createdAt: "2026-03-20T00:00:00Z" });
    store.upsertIssue(base);

    const baseResult = computeMergeProbability({
      db: store.db,
      issue: base,
      maintainers: [makeMaintainer()],
      now,
    });
    const controversialResult = computeMergeProbability({
      db: store.db,
      issue: controversial,
      maintainers: [makeMaintainer()],
      now,
    });
    expect(controversialResult.score).toBeLessThan(baseResult.score);
  });
});
