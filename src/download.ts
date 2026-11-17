import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EnvHttpProxyAgent, fetch, type Dispatcher } from "undici";
import { config, resolveOutDir } from "./config.js";
import type { Media, MediaType, Post } from "./parse.js";

export interface DownloadResult {
  post_id: string;
  author: string;
  media_key: string;
  type: MediaType;
  url: string;
  path?: string;
  bytes?: number;
  status: "downloaded" | "exists" | "error";
  error?: string;
}

const hasProxy = !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY);
const dispatcher: Dispatcher | undefined = hasProxy ? new EnvHttpProxyAgent() : undefined;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const log = (...a: unknown[]) => console.error("[riffler]", ...a);

function extFor(m: Media): string {
  if (m.type !== "photo") return "mp4";
  const fmt = m.url.match(/[?&]format=(\w+)/)?.[1] ?? m.url.match(/\.(\w+)(?:\?|$)/)?.[1];
  return fmt && /^(jpg|jpeg|png|webp|gif)$/i.test(fmt) ? fmt.toLowerCase() : "jpg";
}

export function mediaPath(post: Post, m: Media, baseDir: string): string {
  const handle = post.author.handle.replace(/[^\w-]/g, "_") || "unknown";
  return path.join(baseDir, handle, `${post.id}_${(m.index ?? 0) + 1}.${extFor(m)}`);
}

// ---------------------------------------------------------------- concurrency

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
const slots = new Semaphore(config.downloadConcurrency);
const inflight = new Map<string, Promise<DownloadResult>>();

// ---------------------------------------------------------------- ffmpeg (only needed for HLS-only videos)

let ffmpegPath: string | null | undefined;
let ffmpegSetup: Promise<string | null> | null = null;
let installTried = false;

function works(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(bin, ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

function staticFfmpeg(): string | null {
  try {
    const req = createRequire(path.join(config.toolsDir, "package.json"));
    const p = req("ffmpeg-static") as string | null;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Find ffmpeg; if missing, try to install a static build into ~/.riffler/tools. Returns null if impossible. */
export function resolveFfmpeg(opts: { install?: boolean } = { install: true }): Promise<string | null> {
  if (ffmpegPath !== undefined && (ffmpegPath || !opts.install || installTried)) return Promise.resolve(ffmpegPath);
  if (ffmpegSetup) return ffmpegSetup;
  ffmpegSetup = (async () => {
    for (const c of [process.env.X_FFMPEG, "ffmpeg", staticFfmpeg()]) if (c && (await works(c))) return (ffmpegPath = c);
    if (!opts.install) return (ffmpegPath = null);
    installTried = true;
    log("ffmpeg needed for an HLS-only video; installing a static build (one-time)…");
    fs.mkdirSync(config.toolsDir, { recursive: true });
    if (!fs.existsSync(path.join(config.toolsDir, "package.json")))
      fs.writeFileSync(path.join(config.toolsDir, "package.json"), '{"name":"riffler-tools","private":true}');
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(npm, ["install", "--no-audit", "--no-fund", "--prefix", config.toolsDir, "ffmpeg-static@5"], {
        stdio: "ignore",
        shell: process.platform === "win32",
      });
      const t = setTimeout(() => p.kill(), 180_000);
      p.on("error", () => resolve(false));
      p.on("exit", (code) => {
        clearTimeout(t);
        resolve(code === 0);
      });
    });
    const p = ok ? staticFfmpeg() : null;
    ffmpegPath = p && (await works(p)) ? p : null;
    log(ffmpegPath ? `ffmpeg ready: ${ffmpegPath}` : "ffmpeg install failed; HLS-only videos will be skipped.");
    return ffmpegPath;
  })().finally(() => (ffmpegSetup = null));
  return ffmpegSetup;
}

// ---------------------------------------------------------------- fetchers

async function fetchToFile(url: string, dest: string): Promise<number> {
  const signal = AbortSignal.timeout(config.downloadTimeoutMs);
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(url, { dispatcher, signal, headers: { "user-agent": UA, referer: "https://x.com/" } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp), { signal });
    fs.renameSync(tmp, dest);
    return fs.statSync(dest).size;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if ((e as Error).name === "TimeoutError" || signal.aborted) throw new Error(`timed out after ${config.downloadTimeoutMs / 1000}s`);
    throw e;
  }
}

async function hlsToFile(url: string, dest: string): Promise<number> {
  const bin = await resolveFfmpeg();
  if (!bin) throw new Error("HLS-only video and ffmpeg unavailable");
  const tmp = `${dest}.part.mp4`;
  await new Promise<void>((resolve, reject) => {
    const p = spawn(bin, ["-y", "-loglevel", "error", "-i", url, "-c", "copy", "-movflags", "+faststart", tmp], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), config.downloadTimeoutMs);
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("exit", (code, sig) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(sig === "SIGKILL" ? "ffmpeg timed out" : `ffmpeg: ${err.slice(0, 200)}`));
    });
  }).catch((e) => {
    fs.rmSync(tmp, { force: true });
    throw e;
  });
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}

async function downloadOne(post: Post, m: Media, baseDir: string): Promise<DownloadResult> {
  const dest = mediaPath(post, m, baseDir);
  const base = { post_id: post.id, author: post.author.handle, media_key: m.key, type: m.type, url: m.url };
  if (fs.existsSync(dest)) return { ...base, path: dest, bytes: fs.statSync(dest).size, status: "exists" };
  const running = inflight.get(dest);
  // Someone else is already fetching this file: share it, but don't count it twice.
  if (running) return running.then((r) => (r.status === "downloaded" ? { ...r, status: "exists" } : r));
  const job = slots.run(async (): Promise<DownloadResult> => {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const bytes = /\.m3u8(\?|$)/.test(m.url) ? await hlsToFile(m.url, dest) : await fetchToFile(m.url, dest);
      return { ...base, path: dest, bytes, status: "downloaded" };
    } catch (e) {
      if (m.type !== "photo" && m.hls_url && m.hls_url !== m.url) {
        try {
          return { ...base, path: dest, bytes: await hlsToFile(m.hls_url, dest), status: "downloaded" };
        } catch {
          /* fall through to original error */
        }
      }
      return { ...base, status: "error", error: (e as Error).message };
    }
  });
  inflight.set(dest, job);
  const cleanup = () => void inflight.delete(dest);
  job.then(cleanup, cleanup);
  return job;
}

/** Start downloading one post's media now; returns the promises (used to overlap downloads with scrolling). */
export function startDownloads(post: Post, opts: { types?: MediaType[]; dir?: string } = {}): Promise<DownloadResult>[] {
  const baseDir = resolveOutDir(opts.dir);
  return post.media.filter((m) => !opts.types || opts.types.includes(m.type)).map((m) => downloadOne(post, m, baseDir));
}

export async function downloadPosts(posts: Post[], opts: { types?: MediaType[]; dir?: string } = {}): Promise<DownloadResult[]> {
  return Promise.all(posts.flatMap((p) => startDownloads(p, opts)));
}
