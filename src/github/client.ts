import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../workspace/git.js";
import type { Workspace } from "../workspace/manager.js";

export type GitHubErrorCode =
  | "GITHUB_NOT_CONFIGURED"
  | "GITHUB_INVALID_PATH"
  | "GITHUB_NOT_FOUND_OR_UNAUTHORIZED"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_BINARY_FILE"
  | "GITHUB_FILE_TOO_LARGE"
  | "GITHUB_UPSTREAM_ERROR";

export class GitHubError extends Error {
  constructor(public code: GitHubErrorCode, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubConfig {
  repository: string;
  defaultRef?: string;
  token?: string;
  apiBaseUrl?: string;
  workspaceRoot?: string;
  remoteUrl?: string;
}

export interface GitHubRepositoryInfo {
  repository: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  authenticated: boolean;
}

export interface GitHubDirectoryEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  sizeBytes: number;
  sha: string;
}

export interface GitHubReadFileResult {
  repository: string;
  ref: string;
  path: string;
  sha: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
}

type FetchLike = typeof fetch;

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

function normalizeRepository(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return REPOSITORY_RE.test(cleaned) ? cleaned : null;
}

function repositoryFromRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  const scp = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  const urlPath = (() => {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return null;
    }
  })();
  return normalizeRepository(scp?.[1] ?? urlPath ?? trimmed);
}

export function resolveGitHubConfig(workspace: Workspace): GitHubConfig | null {
  const configured = normalizeRepository(
    process.env.C2C_GITHUB_REPOSITORY ?? workspace.projectConfig.githubRepository
  );
  const origin = runGit(workspace.root, ["remote", "get-url", "origin"]);
  const repository = configured ?? (origin.ok ? repositoryFromRemote(origin.stdout) : null);
  if (!repository) return null;
  return {
    repository,
    defaultRef: process.env.C2C_GITHUB_REF ?? workspace.projectConfig.githubDefaultRef,
    token: process.env.C2C_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    apiBaseUrl: process.env.C2C_GITHUB_API_URL,
    workspaceRoot: workspace.root,
    // Use the canonical GitHub SSH endpoint. This also works when origin uses
    // a machine-specific SSH host alias that is unavailable to the bridge.
    remoteUrl: `git@github.com:${repository}.git`,
  };
}

function normalizePath(input: string): string {
  if (typeof input !== "string" || input.includes("\0")) {
    throw new GitHubError("GITHUB_INVALID_PATH", "Invalid GitHub path.");
  }
  const value = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!value) return "";
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new GitHubError("GITHUB_INVALID_PATH", "GitHub paths must be repository-relative and cannot contain '..'.");
  }
  return parts.join("/");
}

function textPage(
  text: string,
  opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number }
): Omit<GitHubReadFileResult, "repository" | "ref" | "path" | "sha" | "sizeBytes"> {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.floor(opts.startLine ?? 1));
  const maxLines = Math.min(HARD_MAX_LINES, Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES)));
  const endLimit = opts.endLine
    ? Math.min(Math.floor(opts.endLine), startLine + HARD_MAX_LINES - 1)
    : startLine + maxLines - 1;
  const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)));
  const selected: string[] = [];
  let collectedBytes = 0;
  let actualEnd = startLine - 1;
  for (let lineNo = startLine; lineNo <= Math.min(endLimit, totalLines); lineNo++) {
    const line = lines[lineNo - 1];
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (selected.length > 0 && collectedBytes + cost > maxBytes) break;
    selected.push(line);
    collectedBytes += cost;
    actualEnd = lineNo;
  }
  const remainingLines = Math.max(0, totalLines - actualEnd);
  return {
    totalLines,
    startLine: Math.min(startLine, Math.max(totalLines, 1)),
    endLine: actualEnd,
    truncated: remainingLines > 0,
    remainingLines,
    nextStartLine: remainingLines > 0 ? actualEnd + 1 : null,
    content: selected.join("\n"),
  };
}

export class GitHubClient {
  readonly repository: string;
  readonly authenticated: boolean;
  private readonly token?: string;
  private readonly apiBaseUrl: string;
  private readonly defaultRef?: string;
  private readonly fetchImpl: FetchLike;
  private readonly workspaceRoot?: string;
  private readonly remoteUrl?: string;
  private gitDir?: string;

  constructor(config: GitHubConfig, fetchImpl: FetchLike = fetch) {
    const repository = normalizeRepository(config.repository);
    if (!repository) throw new GitHubError("GITHUB_NOT_CONFIGURED", "Configure GitHub as owner/repository.");
    this.repository = repository;
    this.token = config.token?.trim() || undefined;
    this.authenticated = Boolean(this.token || config.remoteUrl);
    this.defaultRef = config.defaultRef?.trim() || undefined;
    this.apiBaseUrl = (config.apiBaseUrl?.trim() || "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.workspaceRoot = config.workspaceRoot;
    this.remoteUrl = config.remoteUrl;
  }

  private canUseGit(): boolean {
    return !this.token && Boolean(this.workspaceRoot && this.remoteUrl);
  }

  private git(args: string[]) {
    if (!this.workspaceRoot) {
      throw new GitHubError("GITHUB_NOT_FOUND_OR_UNAUTHORIZED", `No Git transport is available for '${this.repository}'.`);
    }
    const result = runGit(this.workspaceRoot, args);
    if (!result.ok) {
      throw new GitHubError(
        "GITHUB_NOT_FOUND_OR_UNAUTHORIZED",
        `The existing Git/SSH credentials cannot read '${this.repository}'.`
      );
    }
    return result.stdout;
  }

  private defaultBranchFromGit(): string {
    const output = this.git(["ls-remote", "--symref", this.remoteUrl!, "HEAD"]);
    const match = output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m);
    return match?.[1]?.trim() || this.defaultRef || "main";
  }

  private fetchGitRef(ref: string): { gitDir: string; commit: string } {
    if (!this.gitDir) {
      this.gitDir = mkdtempSync(join(tmpdir(), "c2c-github-"));
      const init = runGit(this.gitDir, ["init", "--bare"]);
      if (!init.ok) throw new GitHubError("GITHUB_UPSTREAM_ERROR", "Could not initialize the GitHub read cache.");
    }
    const fetched = runGit(this.gitDir, ["fetch", "--quiet", "--depth=1", this.remoteUrl!, ref]);
    if (!fetched.ok) {
      throw new GitHubError(
        "GITHUB_NOT_FOUND_OR_UNAUTHORIZED",
        `The existing Git/SSH credentials cannot read '${this.repository}' at '${ref}'.`
      );
    }
    const commit = runGit(this.gitDir, ["rev-parse", "FETCH_HEAD"]);
    if (!commit.ok) throw new GitHubError("GITHUB_UPSTREAM_ERROR", "Could not resolve the fetched GitHub revision.");
    return { gitDir: this.gitDir, commit: commit.stdout.trim() };
  }

  private repositoryInfoFromGit(): GitHubRepositoryInfo {
    const defaultBranch = this.defaultBranchFromGit();
    return {
      repository: this.repository,
      defaultBranch,
      private: true,
      htmlUrl: `https://github.com/${this.repository}`,
      authenticated: true,
    };
  }

  private async requestJson(pathname: string): Promise<Record<string, unknown> | Record<string, unknown>[]> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${pathname}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "codex-with-chatgpt",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) {
      throw new GitHubError(
        "GITHUB_NOT_FOUND_OR_UNAUTHORIZED",
        `GitHub repository content was not found or the server-side credential cannot access '${this.repository}'.`
      );
    }
    if (response.status === 401 || response.status === 403) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0";
      throw new GitHubError(
        limited ? "GITHUB_RATE_LIMITED" : "GITHUB_NOT_FOUND_OR_UNAUTHORIZED",
        limited
          ? "GitHub API rate limit reached."
          : `The server-side GitHub credential cannot access '${this.repository}'.`
      );
    }
    if (!response.ok) {
      throw new GitHubError("GITHUB_UPSTREAM_ERROR", `GitHub API returned HTTP ${response.status}.`);
    }
    return (await response.json()) as Record<string, unknown> | Record<string, unknown>[];
  }

  async repositoryInfo(): Promise<GitHubRepositoryInfo> {
    let data: Record<string, unknown>;
    try {
      data = await this.requestJson(`/repos/${this.repository}`) as Record<string, unknown>;
    } catch (error) {
      if (this.canUseGit() && error instanceof GitHubError && error.code === "GITHUB_NOT_FOUND_OR_UNAUTHORIZED") {
        return this.repositoryInfoFromGit();
      }
      throw error;
    }
    return {
      repository: this.repository,
      defaultBranch: typeof data.default_branch === "string" ? data.default_branch : this.defaultRef ?? "main",
      private: data.private === true,
      htmlUrl: typeof data.html_url === "string" ? data.html_url : `https://github.com/${this.repository}`,
      authenticated: this.authenticated,
    };
  }

  async listDirectory(pathInput = "", refInput?: string): Promise<{
    repository: string; ref: string; path: string; entries: GitHubDirectoryEntry[];
  }> {
    const path = normalizePath(pathInput);
    const ref = refInput?.trim() || this.defaultRef || (await this.repositoryInfo()).defaultBranch;
    const suffix = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
    let data: Record<string, unknown> | Record<string, unknown>[];
    try {
      data = await this.requestJson(`/repos/${this.repository}/contents${suffix}?ref=${encodeURIComponent(ref)}`);
    } catch (error) {
      if (this.canUseGit() && error instanceof GitHubError && error.code === "GITHUB_NOT_FOUND_OR_UNAUTHORIZED") {
        const { gitDir, commit } = this.fetchGitRef(ref);
        const treeish = path ? `${commit}:${path}` : commit;
        const listing = runGit(gitDir, ["ls-tree", "-z", "-l", treeish]);
        if (!listing.ok) throw new GitHubError("GITHUB_INVALID_PATH", `'${path || "."}' is not a GitHub directory.`);
        const entries = listing.stdout.split("\0").filter(Boolean).map((line) => {
          const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/s);
          if (!match) throw new GitHubError("GITHUB_UPSTREAM_ERROR", "Git returned an invalid directory entry.");
          const [, mode, type, sha, size, name] = match;
          const entryPath = path ? `${path}/${name}` : name;
          const entryType = mode === "120000" ? "symlink" : type === "tree" ? "dir" : type === "commit" ? "submodule" : "file";
          return { path: entryPath, type: entryType, sizeBytes: size === "-" ? 0 : Number(size), sha } as GitHubDirectoryEntry;
        });
        return { repository: this.repository, ref, path: path || ".", entries };
      }
      throw error;
    }
    if (!Array.isArray(data)) {
      throw new GitHubError("GITHUB_INVALID_PATH", `'${path || "."}' is not a GitHub directory.`);
    }
    const entries = data.map((item) => ({
      path: typeof item.path === "string" ? item.path : "",
      type: item.type === "dir" || item.type === "symlink" || item.type === "submodule" ? item.type : "file",
      sizeBytes: typeof item.size === "number" ? item.size : 0,
      sha: typeof item.sha === "string" ? item.sha : "",
    })) satisfies GitHubDirectoryEntry[];
    return { repository: this.repository, ref, path: path || ".", entries };
  }

  async readFile(
    pathInput: string,
    refInput?: string,
    opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number } = {}
  ): Promise<GitHubReadFileResult> {
    const path = normalizePath(pathInput);
    if (!path) throw new GitHubError("GITHUB_INVALID_PATH", "A repository-relative file path is required.");
    const ref = refInput?.trim() || this.defaultRef || (await this.repositoryInfo()).defaultBranch;
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    let metadata: Record<string, unknown> | Record<string, unknown>[];
    try {
      metadata = await this.requestJson(
        `/repos/${this.repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
      );
    } catch (error) {
      if (this.canUseGit() && error instanceof GitHubError && error.code === "GITHUB_NOT_FOUND_OR_UNAUTHORIZED") {
        const { gitDir, commit } = this.fetchGitRef(ref);
        const object = `${commit}:${path}`;
        const sizeResult = runGit(gitDir, ["cat-file", "-s", object]);
        if (!sizeResult.ok) throw new GitHubError("GITHUB_INVALID_PATH", `'${path}' is not a GitHub file.`);
        const size = Number(sizeResult.stdout.trim());
        if (size > HARD_MAX_FILE_BYTES) {
          throw new GitHubError("GITHUB_FILE_TOO_LARGE", `GitHub file is larger than ${HARD_MAX_FILE_BYTES} bytes.`);
        }
        const contentResult = runGit(gitDir, ["show", object]);
        if (!contentResult.ok) throw new GitHubError("GITHUB_INVALID_PATH", `'${path}' is not a GitHub file.`);
        const bytes = Buffer.from(contentResult.stdout, "utf8");
        if (bytes.subarray(0, 8192).includes(0)) {
          throw new GitHubError("GITHUB_BINARY_FILE", `Binary GitHub file (${bytes.length} bytes): ${path}.`);
        }
        const shaResult = runGit(gitDir, ["rev-parse", object]);
        return {
          repository: this.repository,
          ref,
          path,
          sha: shaResult.ok ? shaResult.stdout.trim() : "",
          sizeBytes: bytes.length,
          ...textPage(bytes.toString("utf8"), opts),
        };
      }
      throw error;
    }
    if (Array.isArray(metadata) || metadata.type !== "file") {
      throw new GitHubError("GITHUB_INVALID_PATH", `'${path}' is not a GitHub file.`);
    }
    const size = typeof metadata.size === "number" ? metadata.size : 0;
    if (size > HARD_MAX_FILE_BYTES) {
      throw new GitHubError("GITHUB_FILE_TOO_LARGE", `GitHub file is larger than ${HARD_MAX_FILE_BYTES} bytes.`);
    }
    const sha = typeof metadata.sha === "string" ? metadata.sha : "";
    let content = typeof metadata.content === "string" ? metadata.content : "";
    let encoding = typeof metadata.encoding === "string" ? metadata.encoding : "";
    if ((!content || encoding !== "base64") && sha) {
      const blob = await this.requestJson(`/repos/${this.repository}/git/blobs/${encodeURIComponent(sha)}`);
      if (Array.isArray(blob)) throw new GitHubError("GITHUB_UPSTREAM_ERROR", "GitHub returned an invalid blob response.");
      content = typeof blob.content === "string" ? blob.content : "";
      encoding = typeof blob.encoding === "string" ? blob.encoding : "";
    }
    if (!content || encoding !== "base64") {
      throw new GitHubError("GITHUB_UPSTREAM_ERROR", "GitHub did not return readable file content.");
    }
    const bytes = Buffer.from(content.replace(/\s/g, ""), "base64");
    if (bytes.length > HARD_MAX_FILE_BYTES) {
      throw new GitHubError("GITHUB_FILE_TOO_LARGE", `GitHub file is larger than ${HARD_MAX_FILE_BYTES} bytes.`);
    }
    if (bytes.subarray(0, 8192).includes(0)) {
      throw new GitHubError("GITHUB_BINARY_FILE", `Binary GitHub file (${bytes.length} bytes): ${path}.`);
    }
    return {
      repository: this.repository,
      ref,
      path,
      sha,
      sizeBytes: bytes.length,
      ...textPage(bytes.toString("utf8"), opts),
    };
  }
}
