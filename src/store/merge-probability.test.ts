import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IssueLensStore } from "../store.js";
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
  let store: IssueLensStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-lens-test-"));
    store = new IssueLensStore({ dbPath: join(tmpDir, "test.db") });
    await store.init();
  });

  it("gives base score of 50 with no signals", () => {
    const issue = makeIssue({ labels: [], commentCount: 0 });
    const result = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [],
      now,
    });
    expect(result.score).toBeLessThan(50);
    expect(result.topFactors).toContain("No active mergers identified");
  });

  it("boosts score when maintainer replied", () => {
    const issue = makeIssue();
    store.upsertIssue(issue);
    const maintainer = makeMaintainer();
    store.upsertComment({
      id: 1,
      issueNumber: 100,
      author: "alice",
      body: "I can review this",
      createdAt: "2026-03-26T00:00:00Z",
      isMaintainer: true,
    });

    const result = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [maintainer],
      now,
    });
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.topFactors.some((f) => f.includes("@alice"))).toBe(true);
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
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.topFactors.some((f) => f.includes("No maintainer response"))).toBe(true);
  });

  it("uses label merge rate from xref data", () => {
    const maintainer = makeMaintainer();

    for (let i = 1; i <= 10; i++) {
      store.upsertIssue(
        makeIssue({
          number: i,
          state: "closed",
          labels: ["bug"],
          closedAt: "2026-03-15T00:00:00Z",
        }),
      );
    }
    for (let i = 1; i <= 7; i++) {
      store.upsertXref({
        issueNumber: i,
        prNumber: 1000 + i,
        prState: "merged",
        prAuthor: "contributor",
        prTitle: `fix: issue ${i}`,
        linkSource: "closing_reference",
      });
    }

    const issue = makeIssue({ number: 100, labels: [] });
    store.upsertIssue(issue);

    const withXref = computeMergeProbability({
      db: store.db,
      issue: makeIssue({ number: 100, labels: ["bug"] }),
      maintainers: [maintainer],
      now,
    });
    const withoutXref = computeMergeProbability({
      db: store.db,
      issue: makeIssue({ number: 100, labels: [] }),
      maintainers: [maintainer],
      now,
    });
    expect(withXref.score).toBeGreaterThan(withoutXref.score);
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

  it("returns correct label for score ranges", () => {
    const issue = makeIssue({ createdAt: "2026-03-20T00:00:00Z" });
    store.upsertIssue(issue);
    const maintainer = makeMaintainer();
    store.upsertComment({
      id: 1,
      issueNumber: 100,
      author: "alice",
      body: "LGTM",
      createdAt: "2026-03-21T00:00:00Z",
      isMaintainer: true,
    });

    const result = computeMergeProbability({
      db: store.db,
      issue,
      maintainers: [maintainer],
      now,
    });
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.label).toBe("very likely");
    expect(result.confidence).toBe("high");
  });
});
