import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  IssueComment,
  IssueDataSource,
  IssueRecord,
  IssuePrXref,
  PrRecord,
  RepoRef,
} from "./types.js";

const execFileAsync = promisify(execFile);

const GH_MAX_BUFFER = 50 * 1024 * 1024;
const PAGE_SIZE = 100;
const DEFAULT_GH_API_ATTEMPTS = 3;
const DEFAULT_GH_API_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableGhApiError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    "connection reset by peer",
    "timed out",
    "timeout",
    "tls handshake timeout",
    "temporary failure",
    "eof",
    "connection refused",
    "too many requests",
    "http 429",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
  ].some((needle) => message.includes(needle));
}

export type GhCommandRunner = (args: string[]) => Promise<string>;
export type GhApiRunner = (path: string) => Promise<string>;

async function ghCommandRaw(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: GH_MAX_BUFFER });
  return stdout;
}

async function ghApiRaw(path: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["api", path], { maxBuffer: GH_MAX_BUFFER });
  return stdout;
}

export async function ghCommandJsonWithRetry<T>(
  args: string[],
  options: {
    runner?: GhCommandRunner;
    attempts?: number;
    backoffMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const runner = options.runner ?? ghCommandRaw;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_GH_API_ATTEMPTS);
  const backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_GH_API_BACKOFF_MS);
  const sleepFn = options.sleepFn ?? sleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const raw = await runner(args);
      return JSON.parse(raw) as T;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableGhApiError(error)) {
        throw error;
      }
      await sleepFn(backoffMs * attempt);
    }
  }
  throw lastError;
}

export async function ghApiJsonWithRetry<T>(
  path: string,
  options: {
    runner?: GhApiRunner;
    attempts?: number;
    backoffMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const runner = options.runner ?? ghApiRaw;
  return ghCommandJsonWithRetry<T>(["api", path], {
    runner: async (args) => {
      if (args[0] !== "api" || args[1] !== path) {
        throw new Error(`unexpected gh api args: ${args.join(" ")}`);
      }
      return runner(path);
    },
    attempts: options.attempts,
    backoffMs: options.backoffMs,
    sleepFn: options.sleepFn,
  });
}

async function collectPaginated<T>(
  pathBuilder: (page: number) => string,
  label?: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page += 1) {
    let pageItems: T[];
    try {
      pageItems = await ghApiJsonWithRetry<T[]>(pathBuilder(page));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("422") || msg.includes("cursor based pagination")) {
        if (label)
          process.stderr.write(`\n  ${label}: stopped at page ${page} (GitHub pagination limit)\n`);
        break;
      }
      throw error;
    }
    if (pageItems.length === 0) break;
    out.push(...pageItems);
    if (label) process.stderr.write(`\r  ${label}: ${out.length} fetched (page ${page})...`);
    if (pageItems.length < PAGE_SIZE) break;
  }
  if (label && out.length > 0) process.stderr.write(`\r  ${label}: ${out.length} total\n`);
  return out;
}

export function parseRepoRef(value: string): RepoRef {
  const trimmed = value.trim();
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid repo '${value}'. Expected owner/name.`);
  }
  return { owner: match[1]!, name: match[2]! };
}

type RestIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  assignee: { login: string } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  comments: number;
  pull_request?: unknown;
};

type RestPr = {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  user: { login: string } | null;
  merged_by: { login: string } | null;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  body: string | null;
};

type RestComment = {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
};

type RestRateLimit = {
  rate: { remaining: number; limit: number; reset: number };
};

function toIssueRecord(raw: RestIssue): IssueRecord {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state === "open" ? "open" : "closed",
    author: raw.user?.login ?? null,
    assignee: raw.assignee?.login ?? null,
    labels: raw.labels.map((l) => l.name).sort(),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
    url: raw.html_url,
    commentCount: raw.comments,
  };
}

function toPrRecord(raw: RestPr): PrRecord {
  const closingIssues = extractLinkedIssues(raw.body);
  return {
    number: raw.number,
    title: raw.title,
    state: raw.merged_at ? "merged" : raw.state === "open" ? "open" : "closed",
    author: raw.user?.login ?? null,
    mergedBy: raw.merged_by?.login ?? null,
    mergedAt: raw.merged_at,
    createdAt: raw.created_at,
    labels: raw.labels.map((l) => l.name).sort(),
    linkedIssues: closingIssues,
  };
}

function extractLinkedIssues(body: string | null): number[] {
  if (!body) return [];
  const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  const numbers: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    numbers.push(Number(match[1]));
  }
  return [...new Set(numbers)];
}

export class GhCliIssueDataSource implements IssueDataSource {
  async listAllIssues(repo: RepoRef, since?: string): Promise<IssueRecord[]> {
    const sinceParam = since ? `&since=${since}` : "";
    const raw = await collectPaginated<RestIssue>(
      (page) =>
        `repos/${repo.owner}/${repo.name}/issues?state=all&per_page=${PAGE_SIZE}&page=${page}&sort=updated&direction=desc${sinceParam}`,
    );
    const issues = raw.filter((item) => !item.pull_request);
    process.stderr.write(
      `  ${issues.length} issues (${raw.length - issues.length} PRs filtered out)\n`,
    );
    return issues.map(toIssueRecord);
  }

  async getIssueComments(repo: RepoRef, issueNumber: number): Promise<IssueComment[]> {
    const raw = await collectPaginated<RestComment>(
      (page) =>
        `repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`,
    );
    return raw.map((c) => ({
      id: c.id,
      issueNumber,
      author: c.user?.login ?? "unknown",
      body: c.body,
      createdAt: c.created_at,
      isMaintainer: false,
    }));
  }

  async listPullRequests(repo: RepoRef, since?: string): Promise<PrRecord[]> {
    if (!since) {
      const raw = await collectPaginated<RestPr>(
        (page) =>
          `repos/${repo.owner}/${repo.name}/pulls?state=all&per_page=${PAGE_SIZE}&page=${page}&sort=updated&direction=desc`,
      );
      process.stderr.write(`  ${raw.length} PRs\n`);
      return raw.map(toPrRecord);
    }

    const sinceDate = new Date(since);
    const out: RestPr[] = [];
    for (let page = 1; ; page += 1) {
      let pageItems: RestPr[];
      try {
        pageItems = await ghApiJsonWithRetry<RestPr[]>(
          `repos/${repo.owner}/${repo.name}/pulls?state=all&per_page=${PAGE_SIZE}&page=${page}&sort=updated&direction=desc`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("422") || msg.includes("cursor based pagination")) break;
        throw error;
      }
      if (pageItems.length === 0) break;

      let staleCount = 0;
      for (const pr of pageItems) {
        if (new Date(pr.updated_at) > sinceDate) {
          out.push(pr);
        } else {
          staleCount++;
        }
      }

      process.stderr.write(`\r  pulls: ${out.length} new (page ${page})...`);
      if (staleCount === pageItems.length) break;
      if (pageItems.length < PAGE_SIZE) break;
    }

    process.stderr.write(`\r  ${out.length} new PRs\n`);
    return out.map(toPrRecord);
  }

  async searchPrsForIssue(repo: RepoRef, issueNumber: number): Promise<IssuePrXref[]> {
    type SearchResult = {
      items: Array<{
        number: number;
        title: string;
        state: string;
        user: { login: string } | null;
        pull_request?: { merged_at: string | null };
      }>;
    };
    const result = await ghApiJsonWithRetry<SearchResult>(
      `search/issues?q=${encodeURIComponent(`repo:${repo.owner}/${repo.name} is:pr #${issueNumber}`)}&per_page=20`,
    );
    return result.items.map((item) => ({
      issueNumber,
      prNumber: item.number,
      prState: item.pull_request?.merged_at ? "merged" : item.state === "open" ? "open" : "closed",
      prAuthor: item.user?.login ?? null,
      prTitle: item.title,
      linkSource: "search" as const,
    }));
  }

  async getContributors(repo: RepoRef): Promise<string[]> {
    type Contributor = { login: string };
    const raw = await collectPaginated<Contributor>(
      (page) => `repos/${repo.owner}/${repo.name}/contributors?per_page=${PAGE_SIZE}&page=${page}`,
      "contributors",
    );
    return raw.map((c) => c.login);
  }

  async getRateLimitStatus() {
    try {
      const data = await ghApiJsonWithRetry<RestRateLimit>("rate_limit");
      return {
        remaining: data.rate.remaining,
        limit: data.rate.limit,
        resetAt: new Date(data.rate.reset * 1000).toISOString(),
      };
    } catch {
      return null;
    }
  }
}

type TreeEntry = { path: string; type: string };

export type TreeInfo = {
  directories: string[];
  codeownersPath: string | null;
  ownersDirs: string[];
};

export async function fetchRepoTree(repo: RepoRef): Promise<TreeInfo> {
  type TreeResponse = { tree: TreeEntry[] };
  const data = await ghApiJsonWithRetry<TreeResponse>(
    `repos/${repo.owner}/${repo.name}/git/trees/HEAD?recursive=1`,
  );
  const directories = data.tree.filter((e) => e.type === "tree").map((e) => e.path);
  const blobs = data.tree.filter((e) => e.type === "blob");

  const codeownersLocations = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
  const codeownersPath = codeownersLocations.find((p) => blobs.some((b) => b.path === p)) ?? null;

  const ownersDirs = blobs
    .filter((e) => e.path === "OWNERS" || e.path.endsWith("/OWNERS"))
    .map((e) => (e.path === "OWNERS" ? "" : e.path.slice(0, -"/OWNERS".length)));

  return { directories, codeownersPath, ownersDirs };
}

export async function fetchFileContent(repo: RepoRef, path: string): Promise<string | null> {
  try {
    type ContentResponse = { content: string; encoding: string };
    const data = await ghApiJsonWithRetry<ContentResponse>(
      `repos/${repo.owner}/${repo.name}/contents/${path}`,
    );
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return data.content;
  } catch {
    return null;
  }
}
