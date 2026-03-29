export type RepoRef = { owner: string; name: string };

export type IssueState = "open" | "closed";

export type IssueRecord = {
  number: number;
  title: string;
  body: string | null;
  state: IssueState;
  author: string | null;
  assignee: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  commentCount: number;
};

export type IssueComment = {
  id: number;
  issueNumber: number;
  author: string;
  body: string;
  createdAt: string;
  isMaintainer: boolean;
};

export type PrRecord = {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  author: string | null;
  mergedBy: string | null;
  mergedAt: string | null;
  createdAt: string;
  labels: string[];
  linkedIssues: number[];
};

export type IssuePrXref = {
  issueNumber: number;
  prNumber: number;
  prState: "open" | "merged" | "closed";
  prAuthor: string | null;
  prTitle: string;
  linkSource: "closing_reference" | "body_mention" | "search";
};

export type MaintainerRole = "owner" | "merger" | "reviewer" | "triager" | "inactive";

export type MaintainerProfile = {
  login: string;
  role: MaintainerRole;
  modules: string[];
  mergeCount90d: number;
  issueReplyCount90d: number;
  avgResponseDays: number | null;
  lastActiveAt: string | null;
};

export type Workability =
  | { status: "ready"; reason: string }
  | { status: "claimed"; reason: string; claimedBy: string | null; openPrNumber: number | null }
  | { status: "blocked"; reason: string }
  | { status: "unclear"; reason: string }
  | { status: "stale"; reason: string };

export type MergeProbability = {
  score: number;
  confidence: "high" | "medium" | "low";
  label: "very likely" | "likely" | "uncertain" | "unlikely" | "very unlikely";
  topFactors: string[];
};

export type ModuleAffinity = {
  matched: boolean;
  modules: string[];
  score: number;
};

export type IssueSearchFilters = {
  state?: IssueState;
  labels?: string[];
};

export type ParsedSearchQuery = {
  text: string;
  filters: IssueSearchFilters;
};

export type SearchResult = {
  issue: IssueRecord;
  score: number;
  matchSource: "fts" | "vector" | "hybrid";
};

export type DiscoverResult = {
  issue: IssueRecord;
  contributability: number;
  mergeProbability: MergeProbability;
  finalScore: number;
  workability: Workability;
  moduleAffinity: ModuleAffinity;
  relatedPRs: IssuePrXref[];
};

export type IssueDetail = {
  issue: IssueRecord;
  workability: Workability;
  mergeProbability: MergeProbability;
  moduleAffinity: ModuleAffinity;
  maintainerActivity: MaintainerProfile[];
  relatedIssues: Array<{ number: number; title: string; similarity: number }>;
  relatedPRs: IssuePrXref[];
};

export type SyncSummary = {
  issues: { added: number; updated: number };
  comments: { synced: number };
  prs: { added: number; updated: number };
  maintainers: { identified: number };
  embeddings: { computed: number };
};

export interface IssueDataSource {
  listAllIssues(repo: RepoRef, since?: string): Promise<IssueRecord[]>;
  getIssueComments(repo: RepoRef, issueNumber: number): Promise<IssueComment[]>;
  listPullRequests(repo: RepoRef, since?: string): Promise<PrRecord[]>;
  searchPrsForIssue(repo: RepoRef, issueNumber: number): Promise<IssuePrXref[]>;
  getContributors(repo: RepoRef): Promise<string[]>;
  getRateLimitStatus(): Promise<{ remaining: number; limit: number; resetAt: string } | null>;
}
