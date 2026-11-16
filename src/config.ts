import os from "node:os";
import path from "node:path";

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

const num = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const home = expandHome(process.env.X_HOME ?? "~/.x-for-agents");

export const config = {
  home,
  /** Persistent browser profile (your X login). */
  profileDir: path.join(home, "profile"),
  /** Lazily-installed helper tools (ffmpeg, browser). */
  toolsDir: path.join(home, "tools"),
  /** Indexes and run JSON. */
  dataDir: expandHome(process.env.X_DATA_DIR ?? "~/x-for-agents-data"),
  /** Where media goes. Relative paths resolve against the project Claude Code is working in. */
  outputDir: process.env.X_OUTPUT_DIR || undefined,
  /** The project directory Claude Code launched us from. */
  projectDir: process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd(),
  headless: (process.env.X_HEADLESS ?? "true").toLowerCase() !== "false",
  browserChannel: process.env.X_BROWSER_CHANNEL || undefined,
  browserPath: process.env.X_BROWSER_PATH || undefined,
  /** Max concurrent tabs (all on the same logged-in account). */
  tabs: Math.min(20, Math.max(1, num(process.env.X_TABS, 10))),
  /** Don't load images/video/fonts in the scrolling tabs — we only need X's JSON. */
  blockMedia: (process.env.X_BLOCK_MEDIA ?? "true").toLowerCase() !== "false",
  /** Minimum pause after each scroll (ms). Scrolling is otherwise driven by X's responses arriving. */
  scrollDelayMs: num(process.env.X_SCROLL_DELAY_MS, 150),
  /** How long to wait for the next page of results after a scroll. */
  responseWaitMs: num(process.env.X_RESPONSE_WAIT_MS, 2500),
  downloadConcurrency: Math.max(1, num(process.env.X_DOWNLOAD_CONCURRENCY, 8)),
  idleCloseMs: num(process.env.X_IDLE_CLOSE_MS, 5 * 60_000),
};

export const collectionsDir = () => path.join(config.dataDir, "runs");
export const indexFile = () => path.join(config.dataDir, "posts.jsonl");

/** Resolve where media should be written. Relative paths land inside the current project/repo. */
export function resolveOutDir(dir?: string): string {
  const d = dir || config.outputDir;
  if (!d) return path.join(config.dataDir, "media");
  const e = expandHome(d);
  return path.isAbsolute(e) ? e : path.resolve(config.projectDir, e);
}

/** Show paths relative to the project when they're inside it (shorter = fewer tokens). */
export function displayPath(p: string): string {
  const rel = path.relative(config.projectDir, p);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  const h = os.homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}
