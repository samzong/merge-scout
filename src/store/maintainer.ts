import type { DatabaseSync } from "node:sqlite";
import type { MaintainerProfile, MaintainerRole } from "../types.js";

export function inferMaintainers(db: DatabaseSync): MaintainerProfile[] {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const mergersByMergedBy = db
    .prepare(
      `SELECT merged_by as login, COUNT(*) as cnt
       FROM pull_requests
       WHERE merged_by IS NOT NULL AND merged_at > ?
       GROUP BY merged_by`,
    )
    .all(ninetyDaysAgo) as Array<{ login: string; cnt: number }>;

  const mergersByAuthor = db
    .prepare(
      `SELECT author as login, COUNT(*) as cnt
       FROM pull_requests
       WHERE state = 'merged' AND author IS NOT NULL AND merged_at > ?
       GROUP BY author`,
    )
    .all(ninetyDaysAgo) as Array<{ login: string; cnt: number }>;

  const allTimeMergersByAuthor = db
    .prepare(
      `SELECT author as login, COUNT(*) as cnt
       FROM pull_requests
       WHERE state = 'merged' AND author IS NOT NULL
       GROUP BY author ORDER BY cnt DESC`,
    )
    .all() as Array<{ login: string; cnt: number }>;

  const mergeMap = new Map<string, number>();
  for (const m of mergersByMergedBy) mergeMap.set(m.login, (mergeMap.get(m.login) ?? 0) + m.cnt);
  for (const m of mergersByAuthor) mergeMap.set(m.login, (mergeMap.get(m.login) ?? 0) + m.cnt);

  const allTimeMergeMap = new Map(allTimeMergersByAuthor.map((m) => [m.login, m.cnt]));

  const recentPrAuthors = db
    .prepare(
      `SELECT author as login, MAX(merged_at) as last_at
       FROM pull_requests
       WHERE state = 'merged' AND author IS NOT NULL
       GROUP BY author`,
    )
    .all() as Array<{ login: string; last_at: string }>;
  const lastMergeMap = new Map(recentPrAuthors.map((r) => [r.login, r.last_at]));

  const allLogins = new Set([...mergeMap.keys(), ...allTimeMergeMap.keys()]);
  const profiles: MaintainerProfile[] = [];

  for (const login of allLogins) {
    const recentMergeCount = mergeMap.get(login) ?? 0;
    const allTimeMergeCount = allTimeMergeMap.get(login) ?? 0;
    const lastMergeAt = lastMergeMap.get(login) ?? null;

    const role = classifyRole(recentMergeCount, allTimeMergeCount, lastMergeAt, ninetyDaysAgo);
    if (role === "inactive" && allTimeMergeCount < 5) continue;

    profiles.push({
      login,
      role,
      modules: [],
      mergeCount90d: recentMergeCount,
      issueReplyCount90d: 0,
      avgResponseDays: null,
      lastActiveAt: lastMergeAt,
    });
  }

  return profiles.sort((a, b) => b.mergeCount90d - a.mergeCount90d);
}

function classifyRole(
  recentMergeCount: number,
  allTimeMergeCount: number,
  lastActiveAt: string | null,
  ninetyDaysAgo: string,
): MaintainerRole {
  if (lastActiveAt && lastActiveAt < ninetyDaysAgo) return "inactive";
  if (recentMergeCount >= 10) return "owner";
  if (recentMergeCount >= 3) return "merger";
  if (allTimeMergeCount >= 10) return "reviewer";
  if (recentMergeCount >= 1) return "reviewer";
  return "triager";
}
