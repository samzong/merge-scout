import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IssueLensStore } from "./store.js";
import type { IssueRecord } from "./types.js";

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number: 1,
    title: "Test issue",
    body: "Test body",
    state: "open",
    author: "user1",
    assignee: null,
    labels: ["bug"],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-25T00:00:00Z",
    closedAt: null,
    url: "https://github.com/test/test/issues/1",
    commentCount: 3,
    ...overrides,
  };
}

describe("IssueLensStore", () => {
  let store: IssueLensStore;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "issue-lens-test-"));
    store = new IssueLensStore({ dbPath: join(tmpDir, "test.db") });
    await store.init();
  });

  describe("buildXrefsFromPrLinks", () => {
    it("creates xref entries from PR linked_issues", () => {
      store.upsertIssue(makeIssue({ number: 10 }));
      store.upsertIssue(makeIssue({ number: 20 }));
      store.upsertPr({
        number: 100,
        title: "fix: resolve issue 10 and 20",
        state: "merged",
        author: "bob",
        mergedBy: null,
        mergedAt: "2026-03-20T00:00:00Z",
        createdAt: "2026-03-19T00:00:00Z",
        labels: ["bug"],
        linkedIssues: [10, 20],
      });

      const count = store.buildXrefsFromPrLinks();
      expect(count).toBe(2);

      const xrefs10 = store.getXrefsForIssue(10);
      expect(xrefs10).toHaveLength(1);
      expect(xrefs10[0]!.prNumber).toBe(100);
      expect(xrefs10[0]!.prState).toBe("merged");
      expect(xrefs10[0]!.prAuthor).toBe("bob");
      expect(xrefs10[0]!.linkSource).toBe("closing_reference");

      const xrefs20 = store.getXrefsForIssue(20);
      expect(xrefs20).toHaveLength(1);
    });

    it("skips PRs with empty linked_issues", () => {
      store.upsertPr({
        number: 101,
        title: "chore: update deps",
        state: "merged",
        author: "bot",
        mergedBy: null,
        mergedAt: "2026-03-20T00:00:00Z",
        createdAt: "2026-03-19T00:00:00Z",
        labels: [],
        linkedIssues: [],
      });

      const count = store.buildXrefsFromPrLinks();
      expect(count).toBe(0);
    });
  });

  describe("updateMaintainerReplyStats", () => {
    it("updates maintainer_reply_count and first_maintainer_reply_at", () => {
      store.upsertIssue(makeIssue({ number: 1 }));
      store.upsertComment({
        id: 1,
        issueNumber: 1,
        author: "alice",
        body: "I see the issue",
        createdAt: "2026-03-10T00:00:00Z",
        isMaintainer: true,
      });
      store.upsertComment({
        id: 2,
        issueNumber: 1,
        author: "bob",
        body: "me too",
        createdAt: "2026-03-11T00:00:00Z",
        isMaintainer: false,
      });
      store.upsertComment({
        id: 3,
        issueNumber: 1,
        author: "alice",
        body: "working on a fix",
        createdAt: "2026-03-12T00:00:00Z",
        isMaintainer: true,
      });

      store.updateMaintainerReplyStats(1);

      const row = store.db
        .prepare(
          "SELECT maintainer_reply_count, first_maintainer_reply_at FROM issues WHERE number = 1",
        )
        .get() as { maintainer_reply_count: number; first_maintainer_reply_at: string };

      expect(row.maintainer_reply_count).toBe(2);
      expect(row.first_maintainer_reply_at).toBe("2026-03-10T00:00:00Z");
    });

    it("sets zero when no maintainer comments", () => {
      store.upsertIssue(makeIssue({ number: 2 }));
      store.upsertComment({
        id: 10,
        issueNumber: 2,
        author: "user",
        body: "bump",
        createdAt: "2026-03-15T00:00:00Z",
        isMaintainer: false,
      });

      store.updateMaintainerReplyStats(2);

      const row = store.db
        .prepare(
          "SELECT maintainer_reply_count, first_maintainer_reply_at FROM issues WHERE number = 2",
        )
        .get() as { maintainer_reply_count: number; first_maintainer_reply_at: string | null };

      expect(row.maintainer_reply_count).toBe(0);
      expect(row.first_maintainer_reply_at).toBeNull();
    });
  });

  describe("getOpenIssuesWithComments", () => {
    it("returns only open issues with comment_count > 0", () => {
      store.upsertIssue(makeIssue({ number: 1, commentCount: 5 }));
      store.upsertIssue(makeIssue({ number: 2, commentCount: 0 }));
      store.upsertIssue(makeIssue({ number: 3, state: "closed", commentCount: 10 }));
      store.upsertIssue(makeIssue({ number: 4, commentCount: 3 }));

      const result = store.getOpenIssuesWithComments();
      const numbers = result.map((i) => i.number);
      expect(numbers).toEqual([1, 4]);
    });

    it("filters by since watermark", () => {
      store.upsertIssue(
        makeIssue({ number: 1, commentCount: 5, updatedAt: "2026-03-20T00:00:00Z" }),
      );
      store.upsertIssue(
        makeIssue({ number: 2, commentCount: 3, updatedAt: "2026-03-28T00:00:00Z" }),
      );

      const result = store.getOpenIssuesWithComments("2026-03-25T00:00:00Z");
      expect(result).toHaveLength(1);
      expect(result[0]!.number).toBe(2);
    });
  });

  describe("counts", () => {
    it("countComments returns comment count", () => {
      store.upsertIssue(makeIssue({ number: 1 }));
      expect(store.countComments()).toBe(0);
      store.upsertComment({
        id: 1,
        issueNumber: 1,
        author: "a",
        body: "b",
        createdAt: "2026-03-01T00:00:00Z",
        isMaintainer: false,
      });
      expect(store.countComments()).toBe(1);
    });

    it("countXrefs returns xref count", () => {
      expect(store.countXrefs()).toBe(0);
      store.upsertIssue(makeIssue({ number: 1 }));
      store.upsertXref({
        issueNumber: 1,
        prNumber: 2,
        prState: "open",
        prAuthor: "a",
        prTitle: "t",
        linkSource: "search",
      });
      expect(store.countXrefs()).toBe(1);
    });
  });
});
