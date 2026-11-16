import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EnvHttpProxyAgent, fetch, type Dispatcher } from "undici";
import { config, mediaDir } from "./config.js";
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

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function extFor(m: Media): string {
  if (m.type !== "photo") return "mp4";
  const fmt = m.url.match(/[?&]format=(\w+)/)?.[1] ?? m.url.match(/\.(\w+)(?:\?|$)/)?.[1];
  return fmt && /^(jpg|jpeg|png|webp|gif)$/i.test(fmt) ? fmt.toLowerCase() : "jpg";
}

export function mediaPath(post: Post, m: Media, index: number, baseDir = mediaDir()): string {
  const handle = post.author.handle.replace(/[^\w-]/g, "_") || "unknown";
  return path.join(baseDir, handle, `${post.id}_${index + 1}.${extFor(m)}`);
}

async function fetchToFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url, {
    dispatcher,
    headers: { "user-agent": UA, referer: "https://x.com/" },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}

let ffmpegAvailable: boolean | undefined;
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable;
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

async function hlsToFile(url: string, dest: string): Promise<number> {
  if (!(await hasFfmpeg())) throw new Error("video is HLS-only and ffmpeg is not installed");
  const tmp = `${dest}.part.mp4`;
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", url, "-c", "copy", tmp], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`))));
  });
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}

async function downloadOne(post: Post, m: Media, index: number, baseDir?: string): Promise<DownloadResult> {
  const dest = mediaPath(post, m, index, baseDir);
  const base = { post_id: post.id, author: post.author.handle, media_key: m.key, type: m.type, url: m.url };
  if (fs.existsSync(dest)) return { ...base, path: dest, bytes: fs.statSync(dest).size, status: "exists" };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const isHls = /\.m3u8(\?|$)/.test(m.url);
    const bytes = isHls ? await hlsToFile(m.url, dest) : await fetchToFile(m.url, dest);
    return { ...base, path: dest, bytes, status: "downloaded" };
  } catch (e) {
    // Last resort for videos: try the HLS playlist.
    if (m.type !== "photo" && m.hls_url && m.hls_url !== m.url) {
      try {
        const bytes = await hlsToFile(m.hls_url, dest);
        return { ...base, path: dest, bytes, status: "downloaded" };
      } catch {
        /* report original error */
      }
    }
    return { ...base, status: "error", error: (e as Error).message };
  }
}

export async function downloadPosts(
  posts: Post[],
  opts: { types?: MediaType[]; dir?: string } = {},
): Promise<DownloadResult[]> {
  const jobs: Array<() => Promise<DownloadResult>> = [];
  for (const post of posts) {
    post.media.forEach((m, i) => {
      if (opts.types && !opts.types.includes(m.type)) return;
      jobs.push(() => downloadOne(post, m, i, opts.dir));
    });
  }
  const results: DownloadResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, config.downloadConcurrency) }, worker));
  return results;
}
