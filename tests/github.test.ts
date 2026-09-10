import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, resolveGitHubConfig } from "../src/github/client.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, git, makeGitRepo, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  delete process.env.C2C_GITHUB_REPOSITORY;
  delete process.env.C2C_GITHUB_REF;
  delete process.env.C2C_GITHUB_TOKEN;
  delete process.env.C2C_GITHUB_API_URL;
  for (const root of roots.splice(0)) cleanup(root);
});

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GitHub configuration", () => {
  it("derives owner/repository from an SSH alias origin", () => {
    const root = makeTmpDir("github-config");
    roots.push(root);
    makeGitRepo(root);
    git(root, "remote", "add", "origin", "leeia0219@editagi:leeia0219/UnityCapturePnP.git");
    const config = resolveGitHubConfig(new Workspace(root));
    expect(config?.repository).toBe("leeia0219/UnityCapturePnP");
  });

  it("allows an explicit repository and default ref", () => {
    const root = makeTmpDir("github-env");
    roots.push(root);
    makeGitRepo(root);
    process.env.C2C_GITHUB_REPOSITORY = "owner/repo";
    process.env.C2C_GITHUB_REF = "stable";
    const config = resolveGitHubConfig(new Workspace(root));
    expect(config?.repository).toBe("owner/repo");
    expect(config?.defaultRef).toBe("stable");
  });
});

describe("GitHubClient", () => {
  it("reads repository metadata, listings, and paginated file content", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      if (url.endsWith("/repos/owner/repo")) {
        return jsonResponse({ default_branch: "main", private: true, html_url: "https://github.com/owner/repo" });
      }
      if (url.includes("/contents/src?ref=main")) {
        return jsonResponse([{ path: "src/a.ts", type: "file", size: 12, sha: "abc" }]);
      }
      if (url.includes("/contents/src/a.ts?ref=main")) {
        return jsonResponse({
          path: "src/a.ts",
          type: "file",
          size: 18,
          sha: "abc",
          encoding: "base64",
          content: Buffer.from("one\ntwo\nthree\n").toString("base64"),
        });
      }
      return jsonResponse({ message: "not found" }, 404);
    };
    const client = new GitHubClient({ repository: "owner/repo", token: "secret" }, fetchImpl);
    const info = await client.repositoryInfo();
    expect(info.private).toBe(true);
    expect(info.authenticated).toBe(true);
    const listing = await client.listDirectory("src");
    expect(listing.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
    const file = await client.readFile("src/a.ts", undefined, { startLine: 2, endLine: 2 });
    expect(file.content).toBe("two");
    expect(file.nextStartLine).toBe(3);
    expect(calls.every((call) => call.auth === "Bearer secret")).toBe(true);
  });

  it("rejects traversal before making a request", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    const client = new GitHubClient({ repository: "owner/repo", defaultRef: "main" }, fetchImpl);
    await expect(client.readFile("../secret.txt")).rejects.toMatchObject({ code: "GITHUB_INVALID_PATH" });
    expect(called).toBe(false);
  });

  it("maps a private-repository 404 without returning the upstream body", async () => {
    const client = new GitHubClient(
      { repository: "owner/private", defaultRef: "main" },
      async () => jsonResponse({ message: "token details must not escape" }, 404)
    );
    const error = await client.repositoryInfo().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).code).toBe("GITHUB_NOT_FOUND_OR_UNAUTHORIZED");
    expect((error as Error).message).not.toContain("token details");
  });
});
