import { spawnSync } from "node:child_process";
import { Workspace, WorkspaceError } from "./manager.js";
import { runGit } from "./git.js";

export interface ActionResult {
  action: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 128 * 1024;

function clipped(value: string | null | undefined): string {
  const text = value ?? "";
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n[truncated]" : text;
}

export function runWorkspaceTask(workspace: Workspace, task: string): ActionResult {
  const allowed = new Set(["test", "build", "lint", "typecheck"]);
  if (!allowed.has(task)) throw new WorkspaceError("INVALID_PATH", `Task is not allowed: ${task}`);
  const project = workspace.detectProject();
  if (!project.scripts[task]) throw new WorkspaceError("FILE_NOT_FOUND", `No '${task}' script is defined`);
  const manager = project.packageManager ?? "npm";
  if (!new Set(["npm", "pnpm", "yarn", "bun"]).has(manager)) {
    throw new WorkspaceError("INVALID_PATH", `Unsupported package manager: ${manager}`);
  }
  const args = manager === "yarn" || manager === "bun" ? [task] : ["run", task];
  const result = spawnSync(manager, args, {
    cwd: workspace.root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    action: task,
    exitCode: result.status ?? 1,
    stdout: clipped(result.stdout),
    stderr: clipped(result.stderr || result.error?.message),
  };
}

export function gitStage(workspace: Workspace, paths: string[]): { staged: string[] } {
  if (paths.length === 0) throw new WorkspaceError("INVALID_PATH", "At least one path is required");
  const safe = paths.map((requested) => workspace.resolve(requested).rel);
  const result = runGit(workspace.root, ["add", "--", ...safe]);
  if (!result.ok) throw new Error(result.stderr || "git add failed");
  return { staged: safe };
}

export function gitCommit(workspace: Workspace, message: string): { commit: string; message: string } {
  const cleaned = message.trim();
  if (!cleaned || cleaned.length > 200 || /[\r\n]/.test(cleaned)) {
    throw new WorkspaceError("INVALID_PATH", "Commit message must be one line and 1-200 characters");
  }
  const result = runGit(workspace.root, ["commit", "-m", cleaned]);
  if (!result.ok) throw new Error(result.stderr || result.stdout || "git commit failed");
  const head = runGit(workspace.root, ["rev-parse", "--short", "HEAD"]);
  if (!head.ok) throw new Error(head.stderr || "Could not read commit id");
  return { commit: head.stdout.trim(), message: cleaned };
}
