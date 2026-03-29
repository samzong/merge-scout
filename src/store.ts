import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { requireNodeSqlite } from "./lib/sqlite.js";
import { loadSqliteVecExtension } from "./lib/sqlite-vec.js";
import type {
  IssueRecord,
  IssueComment,
  PrRecord,
  IssuePrXref,
  MaintainerProfile,
} from "./types.js";

export function defaultDbPath(repo: string): string {
  const safe = repo.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(homedir(), ".cache", "issue-lens", "repos", `${safe}.db`);
}

export class IssueLensStore {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  private initialized = false;
  vectorAvailable = false;

  constructor(params: { dbPath: string }) {
    this.dbPath = params.dbPath;
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.ensureSchema();
    const vecResult = await loadSqliteVecExtension({ db: this.db });
    this.vectorAvailable = vecResult.ok;
    if (vecResult.ok) this.ensureVectorTables();
    this.initialized = true;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        number INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL,
        author TEXT,
        assignee TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        url TEXT NOT NULL,
        comment_count INTEGER DEFAULT 0,
        maintainer_reply_count INTEGER DEFAULT 0,
        first_maintainer_reply_at TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_comments (
        id INTEGER PRIMARY KEY,
        issue_number INTEGER NOT NULL REFERENCES issues(number),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_maintainer INTEGER DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        number INTEGER PRIMARY KEY,
        title TEXT,
        state TEXT NOT NULL,
        author TEXT,
        merged_by TEXT,
        merged_at TEXT,
        created_at TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        linked_issues TEXT NOT NULL DEFAULT '[]'
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_pr_xref (
        issue_number INTEGER NOT NULL REFERENCES issues(number),
        pr_number INTEGER NOT NULL,
        pr_state TEXT NOT NULL,
        pr_author TEXT,
        pr_title TEXT NOT NULL,
        link_source TEXT NOT NULL,
        PRIMARY KEY (issue_number, pr_number)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maintainers (
        login TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        modules TEXT NOT NULL DEFAULT '[]',
        merge_count_90d INTEGER DEFAULT 0,
        issue_reply_count_90d INTEGER DEFAULT 0,
        avg_response_days REAL,
        last_active_at TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merge_probability_cache (
        issue_number INTEGER PRIMARY KEY REFERENCES issues(number),
        score INTEGER NOT NULL,
        confidence TEXT NOT NULL,
        label TEXT NOT NULL,
        top_factors TEXT NOT NULL DEFAULT '[]',
        computed_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contributor_modules (
        pattern TEXT PRIMARY KEY,
        label TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts
        USING fts5(title, body, content=issues, content_rowid=number)
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
        INSERT INTO issues_fts(rowid, title, body) VALUES (new.number, new.title, new.body);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, title, body) VALUES ('delete', old.number, old.title, old.body);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, title, body) VALUES ('delete', old.number, old.title, old.body);
        INSERT INTO issues_fts(rowid, title, body) VALUES (new.number, new.title, new.body);
      END
    `);
  }

  private ensureVectorTables(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS issues_vec USING vec0(embedding float[768])
      `);
    } catch {
      this.vectorAvailable = false;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM repo_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO repo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(key, value, value);
  }

  upsertIssue(issue: IssueRecord): void {
    this.db
      .prepare(
        `INSERT INTO issues (number, title, body, state, author, assignee, labels, created_at, updated_at, closed_at, url, comment_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET
           title=excluded.title, body=excluded.body, state=excluded.state,
           author=excluded.author, assignee=excluded.assignee, labels=excluded.labels,
           updated_at=excluded.updated_at, closed_at=excluded.closed_at,
           url=excluded.url, comment_count=excluded.comment_count`,
      )
      .run(
        issue.number,
        issue.title,
        issue.body,
        issue.state,
        issue.author,
        issue.assignee,
        JSON.stringify(issue.labels),
        issue.createdAt,
        issue.updatedAt,
        issue.closedAt,
        issue.url,
        issue.commentCount,
      );
  }

  upsertPr(pr: PrRecord): void {
    this.db
      .prepare(
        `INSERT INTO pull_requests (number, title, state, author, merged_by, merged_at, created_at, labels, linked_issues)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET
           title=excluded.title, state=excluded.state, author=excluded.author,
           merged_by=excluded.merged_by, merged_at=excluded.merged_at,
           labels=excluded.labels, linked_issues=excluded.linked_issues`,
      )
      .run(
        pr.number,
        pr.title,
        pr.state,
        pr.author,
        pr.mergedBy,
        pr.mergedAt,
        pr.createdAt,
        JSON.stringify(pr.labels),
        JSON.stringify(pr.linkedIssues),
      );
  }

  upsertComment(comment: IssueComment): void {
    this.db
      .prepare(
        `INSERT INTO issue_comments (id, issue_number, author, body, created_at, is_maintainer)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           body=excluded.body, is_maintainer=excluded.is_maintainer`,
      )
      .run(
        comment.id,
        comment.issueNumber,
        comment.author,
        comment.body,
        comment.createdAt,
        comment.isMaintainer ? 1 : 0,
      );
  }

  upsertXref(xref: IssuePrXref): void {
    this.db
      .prepare(
        `INSERT INTO issue_pr_xref (issue_number, pr_number, pr_state, pr_author, pr_title, link_source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_number, pr_number) DO UPDATE SET
           pr_state=excluded.pr_state, pr_author=excluded.pr_author,
           pr_title=excluded.pr_title, link_source=excluded.link_source`,
      )
      .run(
        xref.issueNumber,
        xref.prNumber,
        xref.prState,
        xref.prAuthor,
        xref.prTitle,
        xref.linkSource,
      );
  }

  upsertMaintainer(m: MaintainerProfile): void {
    this.db
      .prepare(
        `INSERT INTO maintainers (login, role, modules, merge_count_90d, issue_reply_count_90d, avg_response_days, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET
           role=excluded.role, modules=excluded.modules, merge_count_90d=excluded.merge_count_90d,
           issue_reply_count_90d=excluded.issue_reply_count_90d, avg_response_days=excluded.avg_response_days,
           last_active_at=excluded.last_active_at`,
      )
      .run(
        m.login,
        m.role,
        JSON.stringify(m.modules),
        m.mergeCount90d,
        m.issueReplyCount90d,
        m.avgResponseDays,
        m.lastActiveAt,
      );
  }

  getOpenIssues(since?: string): IssueRecord[] {
    if (since) {
      const rows = this.db
        .prepare(
          "SELECT * FROM issues WHERE state = 'open' AND updated_at > ? ORDER BY updated_at DESC",
        )
        .all(since) as Array<Record<string, unknown>>;
      return rows.map(rowToIssue);
    }
    const rows = this.db
      .prepare("SELECT * FROM issues WHERE state = 'open' ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToIssue);
  }

  getOpenIssuesWithComments(since?: string): IssueRecord[] {
    if (since) {
      const rows = this.db
        .prepare(
          `SELECT * FROM issues WHERE state = 'open' AND comment_count > 0
           AND updated_at > ? ORDER BY updated_at DESC`,
        )
        .all(since) as Array<Record<string, unknown>>;
      return rows.map(rowToIssue);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM issues WHERE state = 'open' AND comment_count > 0
         ORDER BY updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToIssue);
  }

  updateMaintainerReplyStats(issueNumber: number): void {
    this.db
      .prepare(
        `UPDATE issues SET
           maintainer_reply_count = (
             SELECT COUNT(*) FROM issue_comments
             WHERE issue_number = ? AND is_maintainer = 1
           ),
           first_maintainer_reply_at = (
             SELECT MIN(created_at) FROM issue_comments
             WHERE issue_number = ? AND is_maintainer = 1
           )
         WHERE number = ?`,
      )
      .run(issueNumber, issueNumber, issueNumber);
  }

  getIssue(number: number): IssueRecord | null {
    const row = this.db.prepare("SELECT * FROM issues WHERE number = ?").get(number) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToIssue(row) : null;
  }

  getMaintainers(): MaintainerProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM maintainers ORDER BY merge_count_90d DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToMaintainer);
  }

  getXrefsForIssue(issueNumber: number): IssuePrXref[] {
    const rows = this.db
      .prepare("SELECT * FROM issue_pr_xref WHERE issue_number = ?")
      .all(issueNumber) as Array<Record<string, unknown>>;
    return rows.map(rowToXref);
  }

  countIssues(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM issues").get() as { count: number };
    return row.count;
  }

  countPrs(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM pull_requests").get() as {
      count: number;
    };
    return row.count;
  }

  countComments(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM issue_comments").get() as {
      count: number;
    };
    return row.count;
  }

  countXrefs(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM issue_pr_xref").get() as {
      count: number;
    };
    return row.count;
  }

  buildXrefsFromPrLinks(): number {
    const prs = this.db
      .prepare(
        "SELECT number, title, state, author, linked_issues FROM pull_requests WHERE linked_issues != '[]'",
      )
      .all() as Array<{
      number: number;
      title: string;
      state: string;
      author: string | null;
      linked_issues: string;
    }>;

    let count = 0;
    for (const pr of prs) {
      const linked: number[] = JSON.parse(pr.linked_issues);
      const prState = pr.state as "open" | "merged" | "closed";
      for (const issueNumber of linked) {
        this.upsertXref({
          issueNumber,
          prNumber: pr.number,
          prState,
          prAuthor: pr.author,
          prTitle: pr.title,
          linkSource: "closing_reference",
        });
        count++;
      }
    }
    return count;
  }
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

function rowToMaintainer(row: Record<string, unknown>): MaintainerProfile {
  return {
    login: row.login as string,
    role: row.role as MaintainerProfile["role"],
    modules: JSON.parse((row.modules as string) || "[]"),
    mergeCount90d: (row.merge_count_90d as number) ?? 0,
    issueReplyCount90d: (row.issue_reply_count_90d as number) ?? 0,
    avgResponseDays: (row.avg_response_days as number) ?? null,
    lastActiveAt: (row.last_active_at as string) ?? null,
  };
}

function rowToXref(row: Record<string, unknown>): IssuePrXref {
  return {
    issueNumber: row.issue_number as number,
    prNumber: row.pr_number as number,
    prState: row.pr_state as IssuePrXref["prState"],
    prAuthor: (row.pr_author as string) ?? null,
    prTitle: row.pr_title as string,
    linkSource: row.link_source as IssuePrXref["linkSource"],
  };
}
