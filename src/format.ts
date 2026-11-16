/**
 * Token-lean text output. Everything Claude reads goes through here:
 * one header line per run, then optional pipe-delimited rows (no JSON keys repeated per item).
 */
import type { CollectResult } from "./collect.js";
import { displayPath } from "./config.js";
import type { DownloadResult } from "./download.js";
import type { Post } from "./parse.js";

export type Detail = "summary" | "compact" | "full";

export const kfmt = (n?: number) =>
  n == null ? "-" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(n);

const mb = (b: number) => (b >= 1e9 ? (b / 1e9).toFixed(2) + "GB" : (b / 1e6).toFixed(1) + "MB");

export function mediaCode(p: Post): string {
  const c = { p: 0, v: 0, g: 0 };
  for (const m of p.media) c[m.type === "photo" ? "p" : m.type === "video" ? "v" : "g"]++;
  return (["p", "v", "g"] as const).filter((k) => c[k]).map((k) => `${c[k]}${k}`).join("") || "-";
}

export function mediaTotals(posts: Post[]) {
  const c = { photo: 0, video: 0, gif: 0 };
  for (const p of posts) for (const m of p.media) c[m.type]++;
  return c;
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/https:\/\/t\.co\/\w+/g, "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function runHeader(o: {
  id: string;
  label: string;
  result: CollectResult;
  downloads?: DownloadResult[];
  outDir?: string;
}): string {
  const r = o.result;
  const t = mediaTotals(r.posts);
  const total = t.photo + t.video + t.gif;
  const lines = [
    `run ${o.id} · ${o.label} · ${r.posts.length} posts · ${total} media (${t.photo}p ${t.video}v ${t.gif}g) · stop=${r.stopReason} · ${(r.elapsedMs / 1000).toFixed(1)}s/${r.scrolls} scrolls`,
  ];
  if (o.downloads) lines.push(downloadLine(o.downloads, o.outDir));
  if (r.rateLimit) {
    const mins = Math.max(0, Math.round((r.rateLimit.reset - Date.now() / 1000) / 60));
    lines.push(`rate ${r.rateLimit.op}: ${r.rateLimit.remaining}/${r.rateLimit.limit} left, resets in ${mins}m`);
  }
  if (r.stopReason === "rate_limited") lines.push("⚠ rate limited by X — retry after reset, or pass rate_limit_wait_s.");
  return lines.join("\n");
}

export function downloadLine(d: DownloadResult[], outDir?: string): string {
  const n = (s: DownloadResult["status"]) => d.filter((x) => x.status === s).length;
  const bytes = d.reduce((a, x) => a + (x.status === "downloaded" ? (x.bytes ?? 0) : 0), 0);
  let line = `files: ${n("downloaded")} new, ${n("exists")} had, ${n("error")} failed, ${mb(bytes)}`;
  if (outDir) line += ` → ${displayPath(outDir)}/<handle>/<postId>_<n>.<ext>`;
  const errs = d.filter((x) => x.status === "error").slice(0, 3);
  for (const e of errs) line += `\n  ✗ ${e.post_id} ${e.type}: ${e.error}`;
  return line;
}

export function rows(posts: Post[], o: { textChars: number; limit: number; start?: number }): string {
  const start = o.start ?? 1;
  const shown = posts.slice(0, o.limit);
  const out = [`#|id|@author|date|likes|views|media|${o.textChars ? "text" : ""}`];
  shown.forEach((p, i) => {
    const flag = p.context === "retweeted" ? "↻" : p.context === "quoted" ? "❝" : "";
    out.push(
      [
        start + i,
        p.id,
        flag + p.author.handle,
        p.created_at?.slice(2, 10) ?? "-",
        kfmt(p.metrics?.likes),
        kfmt(p.metrics?.views),
        mediaCode(p),
        o.textChars ? oneLine(p.text, o.textChars) : "",
      ].join("|"),
    );
  });
  if (posts.length > shown.length) out.push(`…+${posts.length - shown.length} more (x_preview / run file)`);
  return out.join("\n");
}

/** Full detail: minified JSON without empty fields. */
export function fullJson(posts: Post[]): string {
  return JSON.stringify(
    posts.map((p) => ({
      id: p.id,
      url: p.url,
      author: p.author.handle,
      created_at: p.created_at,
      text: p.text,
      metrics: p.metrics,
      context: p.context !== "timeline" ? p.context : undefined,
      media: p.media.map((m) => ({ type: m.type, url: m.url, w: m.width, h: m.height, dur: m.duration_ms, alt: m.alt_text })),
    })),
  );
}
