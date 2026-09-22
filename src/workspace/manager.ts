import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { IgnoreRules } from "./ignore.js";
import { readJsonIfExists } from "../config/paths.js";

export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_EXISTS"
  | "TEXT_NOT_FOUND"
  | "TEXT_NOT_UNIQUE";

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);

export interface ReadFileResult {
  path: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
}

export interface WriteFileResult {
  path: string;
  format: string;
  bytesWritten: number;
  created: boolean;
}

export interface ReadImageResult {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sizeBytes: number;
  data: string;
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ProjectConfig {
  name?: string;
  maxIterations?: number;
  githubRepository?: string;
  githubDefaultRef?: string;
}

function parseProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const config: ProjectConfig = {};
  if (typeof raw.name === "string") config.name = raw.name;
  if (typeof raw.maxIterations === "number") config.maxIterations = raw.maxIterations;
  if (typeof raw.githubRepository === "string") config.githubRepository = raw.githubRepository;
  if (typeof raw.githubDefaultRef === "string") config.githubDefaultRef = raw.githubDefaultRef;
  return config;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export class Workspace {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly ignoreRules: IgnoreRules;
  readonly projectConfig: ProjectConfig;

  constructor(rootInput: string) {
    const resolved = path.resolve(rootInput);
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootInput}`);
    }
    this.root = real;
    this.id = createHash("sha256").update(normCase(real)).digest("hex").slice(0, 12);
    this.ignoreRules = new IgnoreRules(real);
    this.projectConfig = parseProjectConfig(readJsonIfExists<unknown>(path.join(real, ".c2c.json")));
    this.name = this.projectConfig.name ?? path.basename(real);
  }

  private contains(candidate: string): boolean {
    const r = normCase(this.root);
    const c = normCase(candidate);
    return c === r || c.startsWith(r + path.sep);
  }

  private isSensitiveCanonical(candidate: string): boolean {
    const parts = path.resolve(candidate).split(path.sep).filter(Boolean);
    const start = parts[0]?.endsWith(":") ? 1 : 0;
    for (let index = start; index < parts.length; index++) {
      const suffix = parts.slice(index).join("/");
      if (this.ignoreRules.isSensitive(suffix) || this.ignoreRules.isSensitive(suffix + "/")) return true;
    }
    return false;
  }

  /**
   * Canonicalize a path by realpath-ing its deepest existing ancestor.
   * This follows symlinks/junctions and also handles not-yet-existing leaves.
   */
  private canonicalize(abs: string): string {
    let current = abs;
    const suffix: string[] = [];
    for (;;) {
      try {
        const real = fs.realpathSync.native(current);
        return suffix.length > 0 ? path.join(real, ...suffix) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return abs;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Resolve a lexical path inside the workspace to its canonical target.
   * Links may target external paths; direct external input and traversal do not.
   */
  resolve(requested: string, opts: { allowSensitive?: boolean } = {}): { abs: string; rel: string } {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    let p = requested.trim();
    if (p === "" || p === "/") p = ".";
    // Normalize separators so Windows-style input behaves identically everywhere.
    p = p.replace(/\\/g, "/");
    // Strip a "workspace:/" alias prefix if the model echoes it back.
    p = p.replace(/^workspace:\/*/i, "");
    if (p === "") p = ".";

    const lexical = path.resolve(this.root, p);
    if (!this.contains(lexical)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path is outside the connected workspace: ${requested}`
      );
    }
    const canonical = this.canonicalize(lexical);
    const rel = path.relative(this.root, lexical).split(path.sep).join("/");
    if (rel.startsWith("..")) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path is outside the connected workspace: ${requested}`);
    }
    if (!opts.allowSensitive && rel !== "" && (this.ignoreRules.isSensitive(rel) || this.isSensitiveCanonical(canonical))) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        `ACCESS_DENIED_SENSITIVE_FILE: '${rel}' matches the sensitive-file policy and cannot be read.`
      );
    }
    return { abs: canonical, rel };
  }

  private async isBinary(abs: string): Promise<boolean> {
    const fd = await fs.promises.open(abs, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await fd.close();
    }
  }

  async readFile(
    requested: string,
    opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number } = {}
  ): Promise<ReadFileResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    }
    if (!stat.isFile()) {
      throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
    }
    if (await this.isBinary(abs)) {
      throw new WorkspaceError("BINARY_FILE", `Binary file (${stat.size} bytes): ${rel}. Content is not returned.`);
    }

    const startLine = Math.max(1, Math.floor(opts.startLine ?? 1));
    const maxLines = Math.min(HARD_MAX_LINES, Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES)));
    const endLimit = opts.endLine
      ? Math.min(Math.floor(opts.endLine), startLine + HARD_MAX_LINES - 1)
      : startLine + maxLines - 1;
    const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)));

    const lines: string[] = [];
    let totalLines = 0;
    let collectedBytes = 0;
    let byteTruncated = false;
    let actualEnd = startLine - 1;

    const stream = fs.createReadStream(abs, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      totalLines++;
      if (totalLines >= startLine && totalLines <= endLimit && !byteTruncated) {
        const cost = Buffer.byteLength(line, "utf8") + 1;
        if (collectedBytes + cost > maxBytes && lines.length > 0) {
          byteTruncated = true;
        } else {
          lines.push(line);
          collectedBytes += cost;
          actualEnd = totalLines;
        }
      }
    }
    rl.close();

    const remaining = Math.max(0, totalLines - actualEnd);
    return {
      path: rel,
      sizeBytes: stat.size,
      totalLines,
      startLine: Math.min(startLine, Math.max(totalLines, 1)),
      endLine: actualEnd,
      truncated: remaining > 0,
      remainingLines: remaining,
      nextStartLine: remaining > 0 ? actualEnd + 1 : null,
      content: lines.join("\n"),
    };
  }

  async writeFile(
    requested: string,
    content: string,
    format: string,
    overwrite = false
  ): Promise<WriteFileResult> {
    if (typeof content !== "string") throw new WorkspaceError("INVALID_PATH", "Content must be text");
    const normalizedFormat = format.trim().toLowerCase();
    const allowed = new Set(["markdown", "text", "json", "yaml"]);
    if (!allowed.has(normalizedFormat)) throw new WorkspaceError("INVALID_PATH", "Unsupported document format");
    const { abs, rel } = this.resolve(requested);
    const allowedExtension = /\.(md|markdown|txt|json|ya?ml)$/i.test(rel);
    if (!allowedExtension) throw new WorkspaceError("INVALID_PATH", "Only documentation text files may be written");
    let existed = false;
    try {
      const stat = await fs.promises.stat(abs);
      existed = stat.isFile();
      if (!existed) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
    }
    if (existed && !overwrite) throw new WorkspaceError("FILE_EXISTS", `File already exists: ${rel}; set overwrite=true`);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, { encoding: "utf8", flag: "w" });
    return { path: rel, format: normalizedFormat, bytesWritten: Buffer.byteLength(content, "utf8"), created: !existed };
  }

  async readImage(requested: string, maxBytes = 5 * 1024 * 1024): Promise<ReadImageResult> {
    const { abs, rel } = this.resolve(requested);
    const mimeByExtension: Record<string, ReadImageResult["mimeType"]> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    const mimeType = mimeByExtension[path.extname(rel).toLowerCase()];
    if (!mimeType) throw new WorkspaceError("INVALID_PATH", "Unsupported image format");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    }
    if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
    if (stat.size > maxBytes) throw new WorkspaceError("FILE_TOO_LARGE", `Image exceeds ${maxBytes} bytes: ${rel}`);
    return { path: rel, mimeType, sizeBytes: stat.size, data: (await fs.promises.readFile(abs)).toString("base64") };
  }

  async updateText(requested: string, oldText: string, newText: string): Promise<WriteFileResult> {
    if (!oldText) throw new WorkspaceError("INVALID_PATH", "old_text must not be empty");
    const { abs, rel } = this.resolve(requested);
    const content = await fs.promises.readFile(abs, "utf8").catch(() => {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    });
    const first = content.indexOf(oldText);
    if (first < 0) throw new WorkspaceError("TEXT_NOT_FOUND", `old_text was not found in ${rel}`);
    if (content.indexOf(oldText, first + oldText.length) >= 0) {
      throw new WorkspaceError("TEXT_NOT_UNIQUE", `old_text occurs more than once in ${rel}`);
    }
    const updated = content.slice(0, first) + newText + content.slice(first + oldText.length);
    await fs.promises.writeFile(abs, updated, "utf8");
    return { path: rel, format: "text", bytesWritten: Buffer.byteLength(updated), created: false };
  }

  async updateJson(requested: string, updates: Record<string, unknown>): Promise<WriteFileResult> {
    const { abs, rel } = this.resolve(requested);
    if (!rel.toLowerCase().endsWith(".json")) throw new WorkspaceError("INVALID_PATH", "update_json requires a .json file");
    const raw = await fs.promises.readFile(abs, "utf8").catch(() => {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    });
    const value = JSON.parse(raw) as Record<string, unknown>;
    for (const [dottedPath, nextValue] of Object.entries(updates)) {
      const parts = dottedPath.split(".").filter(Boolean);
      if (parts.length === 0 || parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype")) {
        throw new WorkspaceError("INVALID_PATH", `Invalid JSON field path: ${dottedPath}`);
      }
      let cursor: Record<string, unknown> = value;
      for (const part of parts.slice(0, -1)) {
        const child = cursor[part];
        if (!child || typeof child !== "object" || Array.isArray(child)) cursor[part] = {};
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts.at(-1)!] = nextValue;
    }
    const output = JSON.stringify(value, null, 2) + "\n";
    await fs.promises.writeFile(abs, output, "utf8");
    return { path: rel, format: "json", bytesWritten: Buffer.byteLength(output), created: false };
  }

  async createSourceFile(requested: string, content: string): Promise<WriteFileResult> {
    const { abs, rel } = this.resolve(requested);
    if (!/\.(c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|kt|php|py|rb|rs|sh|sql|swift|ts|tsx|vue|xml)$/i.test(rel)) {
      throw new WorkspaceError("INVALID_PATH", "Unsupported source file extension");
    }
    try {
      await fs.promises.stat(abs);
      throw new WorkspaceError("FILE_EXISTS", `File already exists: ${rel}`);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
    return { path: rel, format: "source", bytesWritten: Buffer.byteLength(content), created: true };
  }

  async moveFile(from: string, to: string): Promise<{ from: string; to: string }> {
    const source = this.resolve(from);
    const destination = this.resolve(to);
    const stat = await fs.promises.stat(source.abs).catch(() => {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${source.rel}`);
    });
    if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${source.rel}`);
    try {
      await fs.promises.stat(destination.abs);
      throw new WorkspaceError("FILE_EXISTS", `Destination already exists: ${destination.rel}`);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
    }
    await fs.promises.mkdir(path.dirname(destination.abs), { recursive: true });
    await fs.promises.rename(source.abs, destination.abs);
    return { from: source.rel, to: destination.rel };
  }

  async listDirectory(
    requested: string,
    opts: { depth?: number; limit?: number; offset?: number } = {}
  ): Promise<ListDirectoryResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${rel || "."}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${rel}`);
    }
    const depth = Math.min(4, Math.max(1, Math.floor(opts.depth ?? 1)));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const all: DirEntry[] = [];
    const visited = new Set<string>();
    const walk = async (dirAbs: string, dirRel: string, level: number): Promise<void> => {
      const visitKey = normCase(this.canonicalize(dirAbs));
      if (visited.has(visitKey)) return;
      visited.add(visitKey);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (this.ignoreRules.isHidden(childRel) || this.ignoreRules.isHidden(childRel + "/")) continue;
        let child: { abs: string; rel: string };
        let childStat: fs.Stats;
        try {
          child = this.resolve(childRel);
          childStat = await fs.promises.stat(child.abs);
        } catch {
          continue;
        }
        if (childStat.isDirectory()) {
          all.push({ path: childRel + "/", type: "dir" });
          if (level < depth) await walk(child.abs, childRel, level + 1);
        } else if (childStat.isFile()) {
          all.push({ path: childRel, type: "file", sizeBytes: childStat.size });
        }
        if (all.length >= offset + limit + 2000) return; // hard cap for huge trees
      }
    };
    await walk(abs, rel, 1);

    const page = all.slice(offset, offset + limit);
    return {
      path: rel || ".",
      entries: page,
      total: all.length,
      offset,
      limit,
      hasMore: offset + page.length < all.length,
    };
  }

  /** Lightweight project detection for workspace_info. */
  detectProject(): {
    projectType: string;
    languages: string[];
    frameworks: string[];
    packageManager: string | null;
    scripts: Record<string, string>;
  } {
    const has = (f: string): boolean => fs.existsSync(path.join(this.root, f));
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    let projectType = "unknown";
    let packageManager: string | null = null;
    let scripts: Record<string, string> = {};

    if (has("package.json")) {
      projectType = "node";
      languages.add("JavaScript");
      const rawPackage = readJsonIfExists<unknown>(path.join(this.root, "package.json"));
      const pkg = rawPackage && typeof rawPackage === "object" && !Array.isArray(rawPackage)
        ? rawPackage as Record<string, unknown>
        : {};
      scripts = stringRecord(pkg.scripts);
      const deps = { ...stringRecord(pkg.dependencies), ...stringRecord(pkg.devDependencies) };
      const known: Record<string, string> = {
        next: "Next.js",
        react: "React",
        vue: "Vue",
        svelte: "Svelte",
        express: "Express",
        fastify: "Fastify",
        "@nestjs/core": "NestJS",
        electron: "Electron",
        vitest: "Vitest",
        jest: "Jest",
      };
      for (const [dep, label] of Object.entries(known)) {
        if (deps[dep]) frameworks.add(label);
      }
      if (has("pnpm-lock.yaml")) packageManager = "pnpm";
      else if (has("yarn.lock")) packageManager = "yarn";
      else if (has("bun.lockb") || has("bun.lock")) packageManager = "bun";
      else if (has("package-lock.json")) packageManager = "npm";
    }
    if (has("tsconfig.json")) languages.add("TypeScript");
    if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
      languages.add("Python");
      if (projectType === "unknown") projectType = "python";
    }
    if (has("Cargo.toml")) {
      languages.add("Rust");
      if (projectType === "unknown") projectType = "rust";
    }
    if (has("go.mod")) {
      languages.add("Go");
      if (projectType === "unknown") projectType = "go";
    }
    if (has("Package.swift")) {
      languages.add("Swift");
      if (projectType === "unknown") projectType = "swift";
    }
    return {
      projectType,
      languages: [...languages],
      frameworks: [...frameworks],
      packageManager,
      scripts,
    };
  }
}
