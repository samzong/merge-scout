import type { DatabaseSync } from "node:sqlite";
import { buildFtsQuery, bm25RankToScore } from "../lib/hybrid.js";
import type { IssueRecord, SearchResult, IssueSearchFilters } from "../types.js";

const VECTOR_FALLBACK_WEIGHT = 0.6;
const DEFAULT_SEARCH_LIMIT = 20;

type FtsRow = { number: number; rank: number };
type VecRow = { number: number; distance: number };

export function searchIssues(params: {
  db: DatabaseSync;
  query: string;
  filters: IssueSearchFilters;
  limit?: number;
  queryEmbedding?: number[];
}): SearchResult[] {
  const { db, query, filters, queryEmbedding } = params;
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;

  const ftsQuery = buildFtsQuery(query);
  const keywordHits = ftsQuery ? searchFts(db, ftsQuery, filters, limit * 2) : [];
  const vectorHits = queryEmbedding ? searchVector(db, queryEmbedding, filters, limit * 2) : [];

  return rankSearchResults(db, keywordHits, vectorHits, limit);
}

function searchFts(
  db: DatabaseSync,
  ftsQuery: string,
  filters: IssueSearchFilters,
  limit: number,
): FtsRow[] {
  let sql = `
    SELECT f.rowid as number, f.rank as rank
    FROM issues_fts f
    JOIN issues i ON i.number = f.rowid
    WHERE issues_fts MATCH ?
  `;
  const args: Array<string | number | null | Buffer> = [ftsQuery];

  if (filters.state) {
    sql += " AND i.state = ?";
    args.push(filters.state);
  }
  if (filters.labels && filters.labels.length > 0) {
    for (const label of filters.labels) {
      sql += " AND i.labels LIKE ?";
      args.push(`%"${label}"%`);
    }
  }
  sql += ` ORDER BY f.rank LIMIT ?`;
  args.push(limit);

  return db.prepare(sql).all(...args) as FtsRow[];
}

function searchVector(
  db: DatabaseSync,
  embedding: number[],
  filters: IssueSearchFilters,
  limit: number,
): VecRow[] {
  try {
    const blob = new Float32Array(embedding).buffer;
    let sql = `
      SELECT v.rowid as number, v.distance as distance
      FROM issues_vec v
      JOIN issues i ON i.number = v.rowid
      WHERE v.embedding MATCH ?
    `;
    const args: Array<string | number | null | Buffer> = [Buffer.from(blob)];

    if (filters.state) {
      sql += " AND i.state = ?";
      args.push(filters.state);
    }

    sql += ` ORDER BY v.distance LIMIT ?`;
    args.push(limit);

    return db.prepare(sql).all(...args) as VecRow[];
  } catch {
    return [];
  }
}

function rankSearchResults(
  db: DatabaseSync,
  keywordHits: FtsRow[],
  vectorHits: VecRow[],
  limit: number,
): SearchResult[] {
  const scoreMap = new Map<number, { textScore: number; vectorScore: number }>();

  for (const hit of keywordHits) {
    const existing = scoreMap.get(hit.number) ?? { textScore: 0, vectorScore: 0 };
    existing.textScore = bm25RankToScore(hit.rank);
    scoreMap.set(hit.number, existing);
  }

  for (const hit of vectorHits) {
    const existing = scoreMap.get(hit.number) ?? { textScore: 0, vectorScore: 0 };
    existing.vectorScore = 1 / (1 + hit.distance);
    scoreMap.set(hit.number, existing);
  }

  const hasKeywordHits = keywordHits.length > 0;
  const entries = [...scoreMap.entries()].map(([number, scores]) => {
    const score = hasKeywordHits
      ? scores.textScore > 0
        ? scores.textScore
        : scores.vectorScore * VECTOR_FALLBACK_WEIGHT
      : scores.vectorScore;
    const matchSource: SearchResult["matchSource"] =
      scores.textScore > 0 && scores.vectorScore > 0
        ? "hybrid"
        : scores.textScore > 0
          ? "fts"
          : "vector";
    return { number, score, matchSource };
  });

  entries.sort((a, b) => b.score - a.score);

  const results: SearchResult[] = [];
  for (const entry of entries.slice(0, limit)) {
    const row = db.prepare("SELECT * FROM issues WHERE number = ?").get(entry.number) as
      | Record<string, unknown>
      | undefined;
    if (!row) continue;
    results.push({
      issue: rowToIssue(row),
      score: entry.score,
      matchSource: entry.matchSource,
    });
  }
  return results;
}

function rowToIssue(row: Record<string, unknown>): IssueRecord {
  return {
    number: row.number as number,
    title: row.title as string,
    body: (row.body as string) ?? null,
    state: (row.state as string) === "open" ? "open" : "closed",
    author: (row.author as string) ?? null,
    assignee: (row.assignee as string) ?? null,
    labels: JSON.parse((row.labels as string) || "[]"),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string) ?? null,
    url: row.url as string,
    commentCount: (row.comment_count as number) ?? 0,
  };
}
