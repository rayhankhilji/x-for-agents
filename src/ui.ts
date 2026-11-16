/**
 * MCP App (ui:// resource) that renders collection results as a native media gallery
 * inside Claude chat / Claude Desktop / other MCP-Apps hosts. Hosts without UI support
 * ignore it and just show the text result.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import type { Post } from "./parse.js";

export const GALLERY_URI = "ui://x-for-agents/gallery.html";
export const UI_MIME = "text/html;profile=mcp-app";
export const UI_CSP = {
  resourceDomains: ["https://pbs.twimg.com", "https://video.twimg.com", "https://abs.twimg.com"],
};

export interface GalleryItem {
  n: number;
  id: string;
  url: string;
  author: string;
  date?: string;
  text: string;
  likes?: number;
  views?: number;
  media: { type: string; thumb?: string; src: string; w?: number; h?: number; dur?: number }[];
}

export interface GalleryData {
  run: string;
  label: string;
  stop?: string;
  items: GalleryItem[];
  total: number;
}

export function galleryData(run: string, label: string, posts: Post[], stop?: string, max = 120): GalleryData {
  return {
    run,
    label,
    stop,
    total: posts.length,
    items: posts.slice(0, max).map((p, i) => ({
      n: i + 1,
      id: p.id,
      url: p.url,
      author: p.author.handle,
      date: p.created_at?.slice(0, 10),
      text: p.text.slice(0, 160),
      likes: p.metrics?.likes,
      views: p.metrics?.views,
      media: p.media.map((m) => ({ type: m.type, thumb: m.thumbnail, src: m.url, w: m.width, h: m.height, dur: m.duration_ms })),
    })),
  };
}

let bundle: string | undefined;
function appBundle(): string {
  if (bundle) return bundle;
  const require = createRequire(import.meta.url);
  const file = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
  const src = fs.readFileSync(file, "utf8");
  // Turn the module's trailing `export{a as B,...}` into a global so it can live in an inline <script>.
  bundle = src.replace(/export\s*\{([^}]*)\}\s*;?\s*$/, (_, list: string) => {
    const pairs = list.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [local, , exported] = s.split(/\s+/);
      return `${exported ?? local}:${local}`;
    });
    return `globalThis.McpApps={${pairs.join(",")}};`;
  });
  return bundle;
}

export function galleryHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X media</title>
<style>
:root{--bg:#fff;--fg:#0f1419;--muted:#536471;--line:#eff3f4;--card:#f7f9f9;--accent:#1d9bf0;--sel:#1d9bf033}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#000;--fg:#e7e9ea;--muted:#71767b;--line:#2f3336;--card:#16181c;--sel:#1d9bf044}}
:root[data-theme=dark]{--bg:#000;--fg:#e7e9ea;--muted:#71767b;--line:#2f3336;--card:#16181c;--sel:#1d9bf044}
*{box-sizing:border-box}body{margin:0;font-variant-ligatures:none;font-feature-settings:"calt" 0;background:var(--bg);color:var(--fg);font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}
header b{font-size:14px}.muted{color:var(--muted)}
.tabs{display:flex;gap:4px;margin-left:auto}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 10px;cursor:pointer}
button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.4;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;padding:12px}
.cell{position:relative;background:var(--card);border-radius:10px;overflow:hidden;border:2px solid transparent;cursor:pointer}
.cell.sel{border-color:var(--accent);background:var(--sel)}
.cell img,.cell video{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#0001}
.badge{position:absolute;top:6px;left:6px;background:#000b;color:#fff;border-radius:6px;padding:1px 6px;font-size:11px;font-weight:600}
.dur{position:absolute;top:6px;right:6px;background:#000b;color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.meta{padding:6px 8px;display:flex;gap:6px;align-items:center;min-width:0}
.meta a{color:var(--fg);font-weight:600;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta .r{margin-left:auto;display:flex;gap:4px}
.icon{border:none;background:none;padding:2px 4px;color:var(--muted)}
.empty{padding:40px;text-align:center;color:var(--muted)}
</style></head>
<body>
<header><b id="title">X media</b><span class="muted" id="sub"></span>
<div class="tabs"><button data-f="all" class="on">All</button><button data-f="photo">Photos</button><button data-f="video">Videos</button><button data-f="gif">GIFs</button>
<button id="send" class="primary" disabled>Use selected</button></div></header>
<div class="grid" id="grid"><div class="empty">Waiting for results…</div></div>
<script>${appBundle()}</script>
<script>
const { App } = globalThis.McpApps;
const app = new App({ name: "x-for-agents-gallery", version: "0.2.0" }, {}, { autoResize: true });
let data = null, filter = "all"; const selected = new Set();
const $ = (s) => document.querySelector(s);
const fmt = (n) => n == null ? "" : n >= 1e6 ? (n/1e6).toFixed(1).replace(/\\.0$/,"")+"M" : n >= 1e3 ? (n/1e3).toFixed(1).replace(/\\.0$/,"")+"k" : ""+n;
const dur = (ms) => { if (!ms) return ""; const s = Math.round(ms/1000); return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function cells() {
  const out = [];
  for (const it of data.items) it.media.forEach((m, j) => { if (filter === "all" || m.type === filter) out.push({ it, m, j, key: it.n + (it.media.length > 1 ? "abcdefgh"[j] : "") }); });
  return out;
}
function render() {
  if (!data) return;
  $("#title").textContent = data.label;
  $("#sub").textContent = data.total + " posts · run " + data.run + (data.stop ? " · " + data.stop : "");
  const list = cells();
  if (!list.length) { $("#grid").innerHTML = '<div class="empty">No media.</div>'; return; }
  $("#grid").innerHTML = list.map(({ it, m, key }) => {
    const vis = m.type === "photo" ? '<img loading="lazy" src="' + esc(m.thumb || m.src) + '">'
      : '<video preload="none" playsinline muted ' + (m.type === "gif" ? "loop autoplay " : "controls ") + 'poster="' + esc(m.thumb) + '" src="' + esc(m.src) + '"></video>';
    return '<div class="cell' + (selected.has(key) ? " sel" : "") + '" data-k="' + key + '">' + vis +
      '<span class="badge">' + key + '</span>' + (m.type !== "photo" ? '<span class="dur">' + (m.type === "gif" ? "GIF" : "▶ " + dur(m.dur)) + "</span>" : "") +
      '<div class="meta"><a href="#" data-open="' + esc(it.url) + '" title="' + esc(it.text) + '">@' + esc(it.author) + '</a><span class="muted">♥' + fmt(it.likes) + '</span>' +
      '<span class="r"><button class="icon" title="Download" data-dl="' + esc(m.src) + '" data-name="' + esc(it.author + "_" + it.id + "_" + key) + '">⬇</button></span></div></div>';
  }).join("");
  $("#send").disabled = !selected.size;
  $("#send").textContent = selected.size ? "Use " + selected.size + " selected" : "Use selected";
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-f],[data-open],[data-dl],.cell,#send");
  if (!t) return;
  if (t.dataset.f) { filter = t.dataset.f; document.querySelectorAll("[data-f]").forEach((b) => b.classList.toggle("on", b === t)); render(); return; }
  if (t.dataset.open) { e.preventDefault(); app.openLink({ url: t.dataset.open }).catch(() => {}); return; }
  if (t.dataset.dl) {
    e.stopPropagation(); const src = t.dataset.dl; const ext = src.includes(".mp4") ? "mp4" : src.includes("format=png") ? "png" : "jpg";
    app.downloadFile({ contents: [{ type: "resource_link", uri: src, name: t.dataset.name + "." + ext, mimeType: ext === "mp4" ? "video/mp4" : "image/" + (ext === "jpg" ? "jpeg" : ext) }] }).catch(() => window.open(src, "_blank"));
    return;
  }
  if (t.id === "send") {
    const keys = [...selected].join(", ");
    await app.sendMessage({ role: "user", content: [{ type: "text", text: "From X run " + data.run + ", use these items: " + keys }] }).catch(() => {});
    return;
  }
  if (t.classList.contains("cell") && e.target.tagName !== "VIDEO") { const k = t.dataset.k; selected.has(k) ? selected.delete(k) : selected.add(k); render(); }
});
app.ontoolresult = (r) => { if (r.structuredContent && r.structuredContent.items) { data = r.structuredContent; selected.clear(); render(); } };
app.onhostcontextchanged = (c) => { if (c && c.theme) document.documentElement.dataset.theme = c.theme; };
app.connect().then(() => { const c = app.getHostContext(); if (c && c.theme) document.documentElement.dataset.theme = c.theme; }).catch(() => {});
</script></body></html>`;
}
