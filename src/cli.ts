import { parseRepoRef, GhCliIssueDataSource } from "./github.js";
import { IssueLensStore, defaultDbPath } from "./store.js";
import { searchIssues } from "./store/search.js";
import { inferMaintainers } from "./store/maintainer.js";
import { buildDiscoverResults } from "./store/priority.js";
import { resolveWorkability } from "./store/workability.js";
import { computeMergeProbability } from "./store/merge-probability.js";
import { buildEmbeddingDocument } from "./lib/text.js";
import type { LocalEmbeddingProvider } from "./embedding.js";
import type { RepoRef, SyncSummary } from "./types.js";

type Command =
  | "init"
  | "sync"
  | "discover"
  | "search"
  | "show"
  | "related"
  | "xref"
  | "maintainers"
  | "status"
  | "config";

type ParsedArgs = {
  command: Command;
  repo: string;
  dbPath?: string;
  full: boolean;
  limit: number;
  json: boolean;
  query?: string;
  issueNumber?: number;
};

export class CliUsageError extends Error {
  constructor(
    public readonly output: string,
    public readonly exitCode: number,
    public readonly stream: "stdout" | "stderr" = "stderr",
  ) {
    super(output);
  }
}

const COMMANDS: Command[] = [
  "init",
  "sync",
  "discover",
  "search",
  "show",
  "related",
  "xref",
  "maintainers",
  "status",
  "config",
];

function usage(): string {
  return `issue-lens — AI-first Issue discovery for open source contributors

Usage: issue-lens <command> --repo <owner/name> [options]

Commands:
  init         Initialize local DB for a repo
  sync         Sync issues, comments, PRs, maintainers
  discover     Ranked issue recommendations (by final_score)
  search       Hybrid FTS + vector search
  show         Issue detail with workability + merge probability
  related      Related issues by semantic similarity
  xref         Issue → PR cross-references
  maintainers  Maintainer profiles and activity
  status       Sync status and index health
  config       View/edit contributor module config

Options:
  --repo <owner/name>  Target repository (required)
  --limit <N>          Max results (default: 20)
  --full               Full sync (ignore watermark)
  --json               JSON output (for AI agents)
  --db <path>          Custom DB path
  -h, --help           Show this help`;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    throw new CliUsageError(usage(), 0, "stdout");
  }

  const [commandRaw, ...rest] = argv;
  if (!COMMANDS.includes(commandRaw as Command)) {
    throw new CliUsageError(`Unknown command: ${commandRaw}\n\n${usage()}`, 1);
  }
  const command = commandRaw as Command;

  const args: ParsedArgs = {
    command,
    repo: "",
    full: false,
    limit: 20,
    json: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--repo") { args.repo = rest[++i] ?? ""; continue; }
    if (arg === "--limit") { args.limit = Number(rest[++i] ?? "20"); continue; }
    if (arg === "--db") { args.dbPath = rest[++i] ?? ""; continue; }
    if (arg === "--full") { args.full = true; continue; }
    if (arg === "--json") { args.json = true; continue; }
    positional.push(arg);
  }

  if (!args.repo) {
    throw new CliUsageError("--repo is required\n\n" + usage(), 1);
  }

  if (command === "search") {
    if (positional.length === 0) throw new CliUsageError("search requires a query", 1);
    args.query = positional.join(" ");
  }

  if (command === "show" || command === "related" || command === "xref") {
    if (positional.length !== 1 || Number.isNaN(Number(positional[0]))) {
      throw new CliUsageError(`${command} requires a numeric issue number`, 1);
    }
    args.issueNumber = Number(positional[0]);
  }

  if (!args.dbPath) args.dbPath = defaultDbPath(args.repo);
  return args;
}

type CommandContext = {
  args: ParsedArgs;
  repo: RepoRef;
  store: IssueLensStore;
  source: GhCliIssueDataSource;
};

function output(args: ParsedArgs, data: unknown, humanText?: string): void {
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(humanText ?? JSON.stringify(data, null, 2));
  }
}

async function handleInit(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  ctx.store.setMeta("repo", ctx.args.repo);
  output(ctx.args, { ok: true, repo: ctx.args.repo, dbPath: ctx.store.dbPath }, `Initialized issue-lens for ${ctx.args.repo}\nDB: ${ctx.store.dbPath}`);
  return 0;
}

async function handleSync(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const { store, source, args } = ctx;
  const watermark = args.full ? undefined : store.getMeta("issue_sync_watermark") ?? undefined;

  process.stderr.write("Syncing issues...\n");
  const issues = await source.listAllIssues(ctx.repo, watermark);
  for (const issue of issues) store.upsertIssue(issue);

  process.stderr.write("Syncing PRs...\n");
  const prWatermark = args.full ? undefined : store.getMeta("pr_sync_watermark") ?? undefined;
  const prs = await source.listPullRequests(ctx.repo, prWatermark);
  for (const pr of prs) store.upsertPr(pr);

  process.stderr.write("Inferring maintainers...\n");
  const maintainers = inferMaintainers(store.db);
  for (const m of maintainers) store.upsertMaintainer(m);

  if (issues.length > 0) {
    store.setMeta("issue_sync_watermark", issues[issues.length - 1]!.updatedAt);
  }
  if (prs.length > 0) {
    store.setMeta("pr_sync_watermark", prs[prs.length - 1]!.createdAt);
  }
  store.setMeta("last_sync_at", new Date().toISOString());

  const summary: SyncSummary = {
    issues: { added: issues.length, updated: 0 },
    comments: { synced: 0 },
    prs: { added: prs.length, updated: 0 },
    maintainers: { identified: maintainers.length },
    embeddings: { computed: 0 },
  };

  output(args, summary, `Synced ${issues.length} issues, ${prs.length} PRs, ${maintainers.length} maintainers identified.`);
  return 0;
}

async function handleDiscover(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const { store, args } = ctx;
  const issues = store.getOpenIssues();
  const maintainers = store.getMaintainers();

  const modulesRows = store.db.prepare("SELECT pattern FROM contributor_modules").all() as Array<{ pattern: string }>;
  const modules = modulesRows.map((r) => r.pattern);

  const results = buildDiscoverResults({
    db: store.db,
    issues,
    maintainers,
    contributorModules: modules,
    limit: args.limit,
  });

  const data = {
    repo: args.repo,
    generatedAt: new Date().toISOString(),
    count: results.length,
    results: results.map((r) => ({
      number: r.issue.number,
      title: r.issue.title,
      url: r.issue.url,
      labels: r.issue.labels,
      workability: r.workability.status,
      contributability: Math.round(r.contributability),
      mergeProbability: r.mergeProbability,
      finalScore: Math.round(r.finalScore * 10) / 10,
      moduleAffinity: r.moduleAffinity,
    })),
  };

  if (args.json) {
    output(args, data);
  } else {
    console.log(`\nTop ${results.length} issues for ${args.repo}:\n`);
    for (const r of results) {
      const mp = r.mergeProbability.label;
      console.log(`  #${r.issue.number} [${r.workability.status}] ${r.issue.title}`);
      console.log(`    score: ${Math.round(r.finalScore)} | merge: ${mp} (${r.mergeProbability.score}) | labels: ${r.issue.labels.join(", ") || "none"}`);
    }
  }
  return 0;
}

async function handleSearch(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const { store, args } = ctx;

  let queryEmbedding: number[] | undefined;
  if (store.vectorAvailable) {
    try {
      const { createLocalEmbeddingProvider } = await import("./embedding.js");
      const provider = await createLocalEmbeddingProvider();
      queryEmbedding = await provider.embedQuery(args.query!);
    } catch {
      process.stderr.write("Vector search unavailable, falling back to FTS only\n");
    }
  }

  const results = searchIssues({
    db: store.db,
    query: args.query!,
    filters: {},
    limit: args.limit,
    queryEmbedding,
  });

  const data = {
    repo: args.repo,
    query: args.query,
    count: results.length,
    results: results.map((r) => ({
      number: r.issue.number,
      title: r.issue.title,
      url: r.issue.url,
      state: r.issue.state,
      labels: r.issue.labels,
      score: Math.round(r.score * 1000) / 1000,
      matchSource: r.matchSource,
    })),
  };

  if (args.json) {
    output(args, data);
  } else {
    console.log(`\nSearch: "${args.query}" (${results.length} results)\n`);
    for (const r of results) {
      console.log(`  #${r.issue.number} [${r.matchSource}] ${r.issue.title} (${r.issue.state})`);
    }
  }
  return results.length > 0 ? 0 : 2;
}

async function handleShow(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const { store, args } = ctx;
  const issue = store.getIssue(args.issueNumber!);
  if (!issue) {
    process.stderr.write(`Issue #${args.issueNumber} not found in local index. Run sync first.\n`);
    return 1;
  }
  const xrefs = store.getXrefsForIssue(issue.number);
  const maintainers = store.getMaintainers();
  const workability = resolveWorkability({ issue, xrefs });
  const mergeProbability = computeMergeProbability({ db: store.db, issue, maintainers });

  const data = {
    ...issue,
    workability,
    mergeProbability,
    relatedPRs: xrefs,
    maintainerActivity: maintainers.filter(
      (m) => m.role === "merger" || m.role === "owner",
    ),
  };
  output(args, data, formatIssueDetail(data));
  return 0;
}

async function handleXref(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const xrefs = ctx.store.getXrefsForIssue(ctx.args.issueNumber!);
  output(ctx.args, { issueNumber: ctx.args.issueNumber, prs: xrefs });
  return 0;
}

async function handleMaintainers(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const maintainers = ctx.store.getMaintainers();
  output(ctx.args, { repo: ctx.args.repo, maintainers });
  return 0;
}

async function handleStatus(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const { store, args, source } = ctx;
  const rateLimit = await source.getRateLimitStatus();
  const data = {
    repo: args.repo,
    dbPath: store.dbPath,
    issueCount: store.countIssues(),
    prCount: store.countPrs(),
    maintainerCount: store.getMaintainers().length,
    vectorAvailable: store.vectorAvailable,
    lastSyncAt: store.getMeta("last_sync_at"),
    rateLimit,
  };
  output(args, data);
  return 0;
}

async function handleConfig(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  const rows = ctx.store.db
    .prepare("SELECT pattern, label FROM contributor_modules")
    .all() as Array<{ pattern: string; label: string | null }>;
  output(ctx.args, { modules: rows }, rows.length > 0
    ? `Contributor modules:\n${rows.map((r) => `  ${r.pattern}${r.label ? ` (${r.label})` : ""}`).join("\n")}`
    : "No contributor modules configured. Use: issue-lens config --repo <repo> add <pattern>");
  return 0;
}

async function handleRelated(ctx: CommandContext): Promise<number> {
  await ctx.store.init();
  output(ctx.args, { issueNumber: ctx.args.issueNumber, related: [] }, "Related issues (vector search required — run sync with embeddings first)");
  return 0;
}

const commandHandlers: Record<Command, (ctx: CommandContext) => Promise<number>> = {
  init: handleInit,
  sync: handleSync,
  discover: handleDiscover,
  search: handleSearch,
  show: handleShow,
  related: handleRelated,
  xref: handleXref,
  maintainers: handleMaintainers,
  status: handleStatus,
  config: handleConfig,
};

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const repo = parseRepoRef(args.repo);
    const store = new IssueLensStore({ dbPath: args.dbPath! });
    const source = new GhCliIssueDataSource();
    return await commandHandlers[args.command]({ args, repo, store, source });
  } catch (error) {
    if (error instanceof CliUsageError) {
      if (error.stream === "stdout") console.log(error.output);
      else console.error(error.output);
      return error.exitCode;
    }
    throw error;
  }
}

function formatIssueDetail(data: Record<string, unknown>): string {
  const issue = data as unknown as { number: number; title: string; state: string; labels: string[]; url: string; workability: { status: string; reason: string }; mergeProbability: { score: number; label: string; topFactors: string[] } };
  return [
    `#${issue.number} ${issue.title}`,
    `State: ${issue.state} | Workability: ${issue.workability.status}`,
    `Merge probability: ${issue.mergeProbability.label} (${issue.mergeProbability.score}/100)`,
    `  ${issue.mergeProbability.topFactors.join("\n  ")}`,
    `Labels: ${issue.labels.join(", ") || "none"}`,
    `URL: ${issue.url}`,
  ].join("\n");
}
