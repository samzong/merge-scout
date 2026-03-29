import type { DatabaseSync } from "node:sqlite";
import type {
  IssueRecord,
  DiscoverResult,
  MaintainerProfile,
  ModuleAffinity,
} from "../types.js";
import { resolveWorkability } from "./workability.js";
import { computeMergeProbability } from "./merge-probability.js";

export function computeContributability(params: {
  issue: IssueRecord;
  moduleAffinity: ModuleAffinity;
  maintainers: MaintainerProfile[];
  xrefHasOpenPr: boolean;
  now?: Date;
}): number {
  const { issue, moduleAffinity, maintainers, xrefHasOpenPr, now = new Date() } = params;
  let score = 0;

  for (const label of issue.labels) {
    const lower = label.toLowerCase();
    if (lower === "good first issue") score += 20;
    else if (lower === "help wanted") score += 15;
    else if (lower.includes("bug")) score += 10;
    else if (lower.includes("enhancement") || lower.includes("feature")) score += 5;
  }

  score += moduleAffinity.score * 25;

  const activeMaintainers = maintainers.filter(
    (m) => m.role === "merger" || m.role === "owner" || m.role === "reviewer",
  );
  if (activeMaintainers.length > 0) {
    score += Math.min(15, activeMaintainers.length * 5);
  }

  const bodyLen = issue.body?.length ?? 0;
  if (bodyLen > 200) score += 10;
  else if (bodyLen > 50) score += 5;

  const daysSinceUpdate =
    (now.getTime() - new Date(issue.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate < 7) score += 10;
  else if (daysSinceUpdate < 30) score += 5;

  if (issue.assignee) score -= 50;
  else if (xrefHasOpenPr) score -= 30;

  if (daysSinceUpdate > 90) score -= 20;
  if (issue.commentCount > 20) score -= 10;

  return Math.max(0, score);
}

export function buildDiscoverResults(params: {
  db: DatabaseSync;
  issues: IssueRecord[];
  maintainers: MaintainerProfile[];
  contributorModules: string[];
  limit: number;
}): DiscoverResult[] {
  const { db, issues, maintainers, contributorModules, limit } = params;

  const results: DiscoverResult[] = [];

  for (const issue of issues) {
    const xrefRows = db
      .prepare("SELECT * FROM issue_pr_xref WHERE issue_number = ?")
      .all(issue.number) as Array<Record<string, unknown>>;
    const xrefs = xrefRows.map((r) => ({
      issueNumber: r.issue_number as number,
      prNumber: r.pr_number as number,
      prState: r.pr_state as "open" | "merged" | "closed",
      prAuthor: (r.pr_author as string) ?? null,
      prTitle: r.pr_title as string,
      linkSource: r.link_source as "closing_reference" | "body_mention" | "search",
    }));

    const workability = resolveWorkability({ issue, xrefs });
    const moduleAffinity = computeModuleAffinity(issue, contributorModules);
    const xrefHasOpenPr = xrefs.some((x) => x.prState === "open");

    const contributability = computeContributability({
      issue,
      moduleAffinity,
      maintainers,
      xrefHasOpenPr,
    });

    const mergeProbability = computeMergeProbability({ db, issue, maintainers });
    const finalScore = (contributability * mergeProbability.score) / 100;

    results.push({
      issue,
      contributability,
      mergeProbability,
      finalScore,
      workability,
      moduleAffinity,
      relatedPRs: xrefs,
    });
  }

  results.sort((a, b) => b.finalScore - a.finalScore);
  return results.slice(0, limit);
}

function computeModuleAffinity(issue: IssueRecord, patterns: string[]): ModuleAffinity {
  if (patterns.length === 0) return { matched: false, modules: [], score: 0 };

  const text = `${issue.title} ${issue.body ?? ""} ${issue.labels.join(" ")}`.toLowerCase();
  const matched: string[] = [];

  for (const pattern of patterns) {
    const simplified = pattern.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\//g, " ").trim().toLowerCase();
    const keywords = simplified.split(/\s+/).filter((k) => k.length > 2);
    if (keywords.some((kw) => text.includes(kw))) {
      matched.push(pattern);
    }
  }

  const score = matched.length > 0 ? Math.min(1, matched.length / patterns.length + 0.3) : 0;
  return { matched: matched.length > 0, modules: matched, score };
}
