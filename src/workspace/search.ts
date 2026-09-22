import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Workspace } from "./manager.js";

export interface SearchOptions {
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  regex?: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  matchCount: number;
  truncated: boolean;
  engine: "ripgrep" | "node";
}

const RG_CANDIDATES = [
  "rg",
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
];

let cachedRg: string | null | undefined;

export function findRipgrep(): string | null {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  if (cachedRg !== undefined) return cachedRg;
  if (process.env.C2C_RG_PATH) {
    cachedRg = process.env.C2C_RG_PATH;
    return cachedRg;
  }
  for (const candidate of RG_CANDIDATES) {
    try {
      const result = spawnSync(candidate, ["--version"], {
        stdio: "ignore",
        timeout: 3000,
        windowsHide: true,
      });
      if (result.status === 0) {
        cachedRg = candidate;
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  cachedRg = null;
  return null;
}

/** For tests. */
export function resetRipgrepCache(): void {
  cachedRg = undefined;
}

async function searchWithRipgrep(
  ws: Workspace,
  rgBin: string,
  searchAbs: string,
  searchRel: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const args = ["--follow", "--json", "--max-filesize", "2M", "--max-count", "20"];
  if (!opts.regex) args.push("-F");
  args.push("--smart-case");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("--", opts.query, searchAbs);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(rgBin, args, { cwd: ws.root, windowsHide: true });
    const matches: SearchMatch[] = [];
    let truncated = false;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (matches.length >= limit) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      try {
        const event = JSON.parse(line) as {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (event.type !== "match" || !event.data?.path?.text) return;
        const eventPath = path.resolve(event.data.path.text);
        const fromSearch = path.relative(searchAbs, eventPath).split(path.sep).join("/");
        const rel = searchRel ? [searchRel, fromSearch === "." ? "" : fromSearch].filter(Boolean).join("/") : path.relative(ws.root, eventPath).split(path.sep).join("/");
        if (rel.startsWith("..") || ws.ignoreRules.isHidden(rel)) return;
        try { ws.resolve(rel); } catch { return; }
        matches.push({
          path: rel,
          line: event.data.line_number ?? 0,
          text: (event.data.lines?.text ?? "").trimEnd().slice(0, 500),
        });
      } catch {
        // ignore malformed json lines
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      resolvePromise({ matches, matchCount: matches.length, truncated, engine: "ripgrep" });
    });
  });
}

async function searchWithNode(
  ws: Workspace,
  searchAbs: string,
  searchRel: string,
  opts: SearchOptions,
  limit: number
): Promise<SearchResult> {
  const matcher = opts.regex ? new RegExp(opts.query, "i") : null;
  const needle = opts.query.toLowerCase();
  const globRegex = opts.glob ? globToRegex(opts.glob) : null;
  const matches: SearchMatch[] = [];
  let truncated = false;
  const visited = new Set<string>();

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (truncated) return;
    let realDir: string;
    try { realDir = await fs.promises.realpath(dirAbs); } catch { return; }
    const visitKey = process.platform === "win32" || process.platform === "darwin" ? realDir.toLowerCase() : realDir;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (ws.ignoreRules.isHidden(childRel) || ws.ignoreRules.isHidden(childRel + "/")) continue;
      let childAbs: string;
      let stat: fs.Stats;
      try {
        childAbs = ws.resolve(childRel).abs;
        stat = await fs.promises.stat(childAbs);
      } catch { continue; }
      if (stat.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (stat.isFile()) {
        if (globRegex && !globRegex.test(childRel)) continue;
        if (stat.size > 2 * 1024 * 1024) continue;
        let content: string;
        try {
          content = await fs.promises.readFile(childAbs, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(needle);
          if (hit) {
            matches.push({ path: childRel, line: i + 1, text: line.trimEnd().slice(0, 500) });
            if (matches.length >= limit) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
  };

  await walk(searchAbs, searchRel);
  return { matches, matchCount: matches.length, truncated, engine: "node" };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

export async function searchWorkspace(ws: Workspace, opts: SearchOptions): Promise<SearchResult> {
  if (!opts.query || opts.query.length < 2) {
    return { matches: [], matchCount: 0, truncated: false, engine: "node" };
  }
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const { abs, rel } = ws.resolve(opts.path ?? ".");
  const rg = findRipgrep();
  if (rg) {
    try {
      return await searchWithRipgrep(ws, rg, abs, rel, opts, limit);
    } catch {
      // fall through to node engine
    }
  }
  return searchWithNode(ws, abs, rel, opts, limit);
}
