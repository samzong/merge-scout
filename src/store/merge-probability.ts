import type { DatabaseSync } from "node:sqlite";
import type { IssueRecord, MaintainerProfile, MergeProbability } from "../types.js";

export function computeMergeProbability(params: {
  db: DatabaseSync;
  issue: IssueRecord;
  maintainers: MaintainerProfile[];
  now?: Date;
}): MergeProbability {
  const { db, issue, maintainers, now = new Date() } = params;
  let score = 30;
  const factors: string[] = [];

  const activeMergers = maintainers.filter((m) => m.role === "merger" || m.role === "owner");

  const replyStats = getMaintainerReplyStats(db, issue.number);

  if (replyStats.firstReplyAt) {
    const responseMs =
      new Date(replyStats.firstReplyAt).getTime() - new Date(issue.createdAt).getTime();
    const responseDays = responseMs / (1000 * 60 * 60 * 24);

    let responseBonus: number;
    let speed: string;
    if (responseDays <= 3) {
      responseBonus = 25;
      speed = `${Math.round(responseDays * 24)}h`;
    } else if (responseDays <= 7) {
      responseBonus = 20;
      speed = `${Math.round(responseDays)}d`;
    } else if (responseDays <= 14) {
      responseBonus = 15;
      speed = `${Math.round(responseDays)}d`;
    } else if (responseDays <= 30) {
      responseBonus = 10;
      speed = `${Math.round(responseDays)}d`;
    } else {
      responseBonus = 5;
      speed = `${Math.round(responseDays)}d`;
    }
    score += responseBonus;
    factors.push(`Maintainer replied in ${speed} by @${replyStats.firstAuthor}`);

    if (replyStats.count >= 4) {
      score += 8;
      factors.push(`${replyStats.count} maintainer replies (strong engagement)`);
    } else if (replyStats.count >= 2) {
      score += 5;
      factors.push(`${replyStats.count} maintainer replies`);
    }
  }

  if (issue.labels.length > 0) {
    score += 5;
  }

  if (issue.assignee && maintainers.some((m) => m.login === issue.assignee)) {
    score += 5;
    factors.push(`Assigned to @${issue.assignee}`);
  }

  const hasActiveMerger = activeMergers.some(
    (m) =>
      m.lastActiveAt &&
      new Date(m.lastActiveAt) > new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
  );
  if (hasActiveMerger) {
    score += 8;
    factors.push("Active merger in last 90 days");
  } else if (activeMergers.length === 0) {
    score -= 25;
    factors.push("No active mergers identified");
  }

  const labelMergeRate = computeLabelMergeRate(db, issue.labels);
  if (labelMergeRate !== null) {
    const rateBonus = Math.round(labelMergeRate * 12);
    score += rateBonus;
    factors.push(`Label merge rate: ${Math.round(labelMergeRate * 100)}%`);
  }

  const daysSinceCreation =
    (now.getTime() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCreation > 30 && !replyStats.firstReplyAt) {
    score -= 20;
    factors.push("No maintainer response after 30+ days");
  }

  if (issue.commentCount > 20) {
    score -= 5;
    factors.push(`High comment count (${issue.commentCount})`);
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

type ReplyStats = {
  count: number;
  firstReplyAt: string | null;
  firstAuthor: string | null;
};

function getMaintainerReplyStats(db: DatabaseSync, issueNumber: number): ReplyStats {
  const row = db
    .prepare(
      `SELECT maintainer_reply_count, first_maintainer_reply_at FROM issues WHERE number = ?`,
    )
    .get(issueNumber) as
    | {
        maintainer_reply_count: number;
        first_maintainer_reply_at: string | null;
      }
    | undefined;

  if (!row || !row.first_maintainer_reply_at) {
    return { count: 0, firstReplyAt: null, firstAuthor: null };
  }

  const author = db
    .prepare(
      `SELECT author FROM issue_comments
       WHERE issue_number = ? AND is_maintainer = 1
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(issueNumber) as { author: string } | undefined;

  return {
    count: row.maintainer_reply_count,
    firstReplyAt: row.first_maintainer_reply_at,
    firstAuthor: author?.author ?? null,
  };
}

function computeLabelMergeRate(db: DatabaseSync, labels: string[]): number | null {
  if (labels.length === 0) return null;
  let totalClosed = 0;
  let totalWithMergedPr = 0;

  for (const label of labels) {
    const closed = db
      .prepare(`SELECT COUNT(*) as cnt FROM issues WHERE state = 'closed' AND labels LIKE ?`)
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
