import { describe, it, expect } from "vitest";
import { computeContributability } from "./priority.js";
import type { IssueRecord, MaintainerProfile, ModuleAffinity } from "../types.js";

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number: 1,
    title: "Test issue",
    body: "A".repeat(250),
    state: "open",
    author: "user1",
    assignee: null,
    labels: [],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-25T00:00:00Z",
    closedAt: null,
    url: "https://github.com/test/test/issues/1",
    commentCount: 0,
    ...overrides,
  };
}

const noAffinity: ModuleAffinity = { matched: false, modules: [], score: 0 };
const now = new Date("2026-03-29T12:00:00Z");

describe("computeContributability", () => {
  it("gives base score for plain issue with body and recency", () => {
    const score = computeContributability({
      issue: makeIssue(),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    expect(score).toBe(20);
  });

  it("adds points for good first issue label", () => {
    const score = computeContributability({
      issue: makeIssue({ labels: ["good first issue"] }),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    expect(score).toBeGreaterThanOrEqual(35);
  });

  it("adds points for bug + help wanted labels", () => {
    const withBoth = computeContributability({
      issue: makeIssue({ labels: ["bug", "help wanted"] }),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    const plain = computeContributability({
      issue: makeIssue(),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    expect(withBoth - plain).toBe(25);
  });

  it("penalizes assigned issues", () => {
    const assigned = computeContributability({
      issue: makeIssue({ assignee: "someone" }),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    expect(assigned).toBe(0);
  });

  it("penalizes issues with open PR", () => {
    const withPr = computeContributability({
      issue: makeIssue(),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: true,
      now,
    });
    const without = computeContributability({
      issue: makeIssue(),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    expect(without - withPr).toBe(20);
  });

  it("adds module affinity bonus", () => {
    const withModule = computeContributability({
      issue: makeIssue(),
      moduleAffinity: { matched: true, modules: ["src/core/**"], score: 0.8 },
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    const without = computeContributability({
      issue: makeIssue(),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    expect(withModule - without).toBe(20);
  });

  it("adds maintainer activity bonus", () => {
    const maintainer: MaintainerProfile = {
      login: "alice",
      role: "merger",
      modules: [],
      mergeCount90d: 10,
      issueReplyCount90d: 5,
      avgResponseDays: 2,
      lastActiveAt: "2026-03-28T00:00:00Z",
    };
    const withMaintainer = computeContributability({
      issue: makeIssue(),
      moduleAffinity: noAffinity,
      maintainers: [maintainer],
      xrefHasOpenPr: false,
      now,
    });
    const without = computeContributability({
      issue: makeIssue(),
      moduleAffinity: noAffinity,
      maintainers: [],
      xrefHasOpenPr: false,
      now,
    });
    expect(withMaintainer).toBeGreaterThan(without);
  });
});
