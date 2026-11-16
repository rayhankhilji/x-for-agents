import os from "node:os";
import path from "node:path";

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

const home = expandHome(process.env.X_HOME ?? "~/.x-for-agents");

export const config = {
  /** Where the persistent browser profile (your X login) lives. */
  profileDir: path.join(home, "profile"),
  /** Where downloads + collection JSON go. */
  dataDir: expandHome(process.env.X_DATA_DIR ?? "~/x-for-agents-data"),
  /** Run headless after login. Set X_HEADLESS=false to watch it scroll. */
  headless: (process.env.X_HEADLESS ?? "true").toLowerCase() !== "false",
  /** Optional: use an installed browser instead of Playwright's Chromium ("chrome", "msedge"). */
  browserChannel: process.env.X_BROWSER_CHANNEL || undefined,
  /** Optional: explicit path to a Chromium/Chrome binary. */
  browserPath: process.env.X_BROWSER_PATH || undefined,
  /** Close the browser after this many ms with no tool calls. */
  idleCloseMs: Number(process.env.X_IDLE_CLOSE_MS ?? 5 * 60_000),
  /** Parallel media downloads. */
  downloadConcurrency: Number(process.env.X_DOWNLOAD_CONCURRENCY ?? 4),
  /** Base delay between scrolls (ms). Jitter is added on top. */
  scrollDelayMs: Number(process.env.X_SCROLL_DELAY_MS ?? 1200),
};

export const mediaDir = () => path.join(config.dataDir, "media");
export const collectionsDir = () => path.join(config.dataDir, "collections");
export const indexFile = () => path.join(config.dataDir, "posts.jsonl");
