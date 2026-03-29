import type { DatabaseSync } from "node:sqlite";
import type { IssueRecord, MaintainerProfile, MergeProbability } from "../types.js";

export function computeMergeProbability(params: {
  db: DatabaseSync;
  issue: IssueRecord;
  maintainers: MaintainerProfile[];
  now?: Date;
}): MergeProbability {
  const { db, issue, maintainers, now = new Date() } = params;
  let score = 50;
  const factors: string[] = [];

  const activeMergers = maintainers.filter((m) => m.role === "merger" || m.role === "owner");

  const maintainerReplied = checkMaintainerReplied(db, issue.number, maintainers);
  if (maintainerReplied) {
    score += 30;
    factors.push(`Maintainer ${maintainerReplied} replied on this issue`);
  }

  const maintainerLabeled = issue.labels.length > 0 && activeMergers.length > 0;
  if (maintainerLabeled) {
    score += 10;
    factors.push("Issue has been labeled (likely by maintainer)");
  }

  if (issue.assignee && maintainers.some((m) => m.login === issue.assignee)) {
    score += 20;
    factors.push(`Assigned by maintainer to @${issue.assignee}`);
  }

  const hasActiveMerger = activeMergers.some(
    (m) => m.lastActiveAt && new Date(m.lastActiveAt) > new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
  );
  if (hasActiveMerger) {
    score += 10;
    factors.push("Active merger exists in last 90 days");
  } else if (activeMergers.length === 0) {
    score -= 30;
    factors.push("No active mergers identified");
  }

  const labelMergeRate = computeLabelMergeRate(db, issue.labels);
  if (labelMergeRate !== null) {
    const rateBonus = Math.round(labelMergeRate * 15);
    score += rateBonus;
    factors.push(`Label merge rate: ${Math.round(labelMergeRate * 100)}%`);
  }

  const daysSinceCreation = (now.getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCreation > 30 && !maintainerReplied) {
    score -= 40;
    factors.push("No maintainer response after 30+ days");
  }

  if (issue.commentCount > 20) {
    score -= 10;
    factors.push(`High comment count (${issue.commentCount}) may indicate controversy`);
  }

  score = Math.max(0, Math.min(100, score));
  const topFactors = factors.slice(0, 3);

  return {
    score,
    confidence: score >= 70 || score <= 30 ? "high" : factors.length >= 3 ? "medium" : "low",
    label: scoreToLabel(score),
    topFactors,
  };
}

function checkMaintainerReplied(
  db: DatabaseSync,
  issueNumber: number,
  maintainers: MaintainerProfile[],
): string | null {
  if (maintainers.length === 0) return null;
  const placeholders = maintainers.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT author FROM issue_comments
       WHERE issue_number = ? AND author IN (${placeholders})
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(issueNumber, ...maintainers.map((m) => m.login)) as { author: string } | undefined;
  return row?.author ? `@${row.author}` : null;
}

function computeLabelMergeRate(db: DatabaseSync, labels: string[]): number | null {
  if (labels.length === 0) return null;
  let totalClosed = 0;
  let totalWithMergedPr = 0;

  for (const label of labels) {
    const closed = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM issues WHERE state = 'closed' AND labels LIKE ?`,
      )
      .get(`%"${label}"%`) as { cnt: number };

    const withPr = db
      .prepare(
        `SELECT COUNT(DISTINCT i.number) as cnt
         FROM issues i
         JOIN issue_pr_xref x ON x.issue_number = i.number
         WHERE i.state = 'closed' AND i.labels LIKE ? AND x.pr_state = 'merged'`,
      )
      .get(`%"${label}"%`) as { cnt: number };

    totalClosed += closed.cnt;
    totalWithMergedPr += withPr.cnt;
  }

  if (totalClosed < 5) return null;
  return totalWithMergedPr / totalClosed;
}

function scoreToLabel(score: number): MergeProbability["label"] {
  if (score >= 80) return "very likely";
  if (score >= 60) return "likely";
  if (score >= 40) return "uncertain";
  if (score >= 20) return "unlikely";
  return "very unlikely";
}
