import type { IssueRecord, IssuePrXref, Workability } from "../types.js";

export function resolveWorkability(params: {
  issue: IssueRecord;
  xrefs: IssuePrXref[];
  now?: Date;
}): Workability {
  const { issue, xrefs, now = new Date() } = params;

  if (issue.state === "closed") {
    return { status: "stale", reason: "Issue is closed" };
  }

  const openPr = xrefs.find((x) => x.prState === "open");
  if (issue.assignee || openPr) {
    return {
      status: "claimed",
      reason: issue.assignee
        ? `Assigned to @${issue.assignee}`
        : `Open PR #${openPr!.prNumber} by @${openPr!.prAuthor}`,
      claimedBy: issue.assignee ?? openPr!.prAuthor,
      openPrNumber: openPr?.prNumber ?? null,
    };
  }

  const updatedAt = new Date(issue.updatedAt);
  const daysSinceUpdate = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate > 90) {
    return { status: "stale", reason: `No activity for ${Math.round(daysSinceUpdate)} days` };
  }

  const hasLabels = issue.labels.length > 0;
  const hasBody = !!issue.body && issue.body.length > 50;
  if (!hasBody) {
    return { status: "unclear", reason: "Issue body is too short or missing" };
  }

  if (hasLabels && hasBody) {
    return { status: "ready", reason: "Labeled, spec present, no assignee, no open PR" };
  }

  return { status: "ready", reason: "No assignee, no open PR" };
}
