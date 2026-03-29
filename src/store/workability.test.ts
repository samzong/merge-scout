import { describe, it, expect } from "vitest";
import { resolveWorkability } from "./workability.js";
import type { IssueRecord, IssuePrXref } from "../types.js";

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number: 1,
    title: "Test issue",
    body: "A sufficiently long body with enough detail to pass the clarity check for workability",
    state: "open",
    author: "user1",
    assignee: null,
    labels: ["bug"],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-25T00:00:00Z",
    closedAt: null,
    url: "https://github.com/test/test/issues/1",
    commentCount: 0,
    ...overrides,
  };
}

const now = new Date("2026-03-29T12:00:00Z");

describe("resolveWorkability", () => {
  it("returns ready for open issue with labels and body", () => {
    const result = resolveWorkability({ issue: makeIssue(), xrefs: [], now });
    expect(result.status).toBe("ready");
  });

  it("returns claimed when issue has assignee", () => {
    const result = resolveWorkability({
      issue: makeIssue({ assignee: "alice" }),
      xrefs: [],
      now,
    });
    expect(result.status).toBe("claimed");
    expect(result).toHaveProperty("claimedBy", "alice");
  });

  it("returns claimed when open PR exists", () => {
    const xref: IssuePrXref = {
      issueNumber: 1,
      prNumber: 42,
      prState: "open",
      prAuthor: "bob",
      prTitle: "fix: something",
      linkSource: "closing_reference",
    };
    const result = resolveWorkability({ issue: makeIssue(), xrefs: [xref], now });
    expect(result.status).toBe("claimed");
    expect(result).toHaveProperty("openPrNumber", 42);
  });

  it("returns stale for closed issue", () => {
    const result = resolveWorkability({
      issue: makeIssue({ state: "closed" }),
      xrefs: [],
      now,
    });
    expect(result.status).toBe("stale");
  });

  it("returns stale for issue with no activity > 90 days", () => {
    const result = resolveWorkability({
      issue: makeIssue({ updatedAt: "2025-11-01T00:00:00Z" }),
      xrefs: [],
      now,
    });
    expect(result.status).toBe("stale");
  });

  it("returns unclear when body is too short", () => {
    const result = resolveWorkability({
      issue: makeIssue({ body: "short" }),
      xrefs: [],
      now,
    });
    expect(result.status).toBe("unclear");
  });

  it("ignores merged PRs for claimed status", () => {
    const xref: IssuePrXref = {
      issueNumber: 1,
      prNumber: 42,
      prState: "merged",
      prAuthor: "bob",
      prTitle: "fix: something",
      linkSource: "closing_reference",
    };
    const result = resolveWorkability({ issue: makeIssue(), xrefs: [xref], now });
    expect(result.status).toBe("ready");
  });
});
