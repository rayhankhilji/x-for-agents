/**
 * MCP App (ui:// resource) that renders collection results as a native media gallery
 * inside Claude chat / Claude Desktop / other MCP-Apps hosts. Hosts without UI support
 * ignore it and just show the text result.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import type { Post } from "./parse.js";

export const GALLERY_URI = "ui://riffler/gallery.html";
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

const ic = (n: string) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;

export function galleryHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X media</title>
<style>
:root{--bg:#fff;--fg:#0A0A14;--muted:#525369;--line:#DCDDE6;--card:#F6F6FC;--accent:#2B1DFF;--accent-hover:#2108D0;--on-accent:#fff;--acid:#D8FF3C;--ring:#0A0A14;--focus:#2B1DFF;--chip-on-bg:#0A0A14;--chip-on-fg:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0B0A1F;--fg:#fff;--muted:#C5C6D2;--line:#3A3B52;--card:#1F1F36;--accent:#BEB8FF;--accent-hover:#fff;--on-accent:#0A0A14;--ring:transparent;--focus:#D8FF3C;--chip-on-bg:#BEB8FF;--chip-on-fg:#0A0A14}}
:root[data-theme=dark]{--bg:#0B0A1F;--fg:#fff;--muted:#C5C6D2;--line:#3A3B52;--card:#1F1F36;--accent:#BEB8FF;--accent-hover:#fff;--on-accent:#0A0A14;--ring:transparent;--focus:#D8FF3C;--chip-on-bg:#BEB8FF;--chip-on-fg:#0A0A14}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
header{position:sticky;top:0;z-index:2;background:var(--bg);display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;min-width:0}
.mark{width:16px;height:16px;flex:none;fill:currentColor;color:var(--fg)}
header b{font-size:14px;font-weight:700;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.muted{color:var(--muted)}#sub{font-variant-numeric:tabular-nums}
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin-left:auto;align-items:center}
button{font:inherit;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:5px 8px;cursor:pointer;transition:background .12s,border-color .12s}
button:hover{border-color:var(--accent)}
button.on{background:var(--chip-on-bg);color:var(--chip-on-fg);border-color:var(--chip-on-bg)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:700;margin-left:4px}
button.primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}
button:disabled{opacity:.4;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;padding:12px}
.cell{position:relative;background:var(--card);border-radius:8px;overflow:hidden;cursor:pointer;border:1px solid var(--line)}
.cell.sel{border-color:transparent;outline:3px solid var(--acid);outline-offset:-3px;box-shadow:0 0 0 1px var(--ring)}
.cell.sel .meta{background:var(--card)}
.cell img,.cell video{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:var(--line)}
.badge,.dur{position:absolute;top:6px;background:#0A0A14e6;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"lnum" 1}
.badge{left:6px}.cell.sel .badge{background:var(--acid);color:#0A0A14}
.dur{right:6px;display:flex;align-items:center;gap:4px}.dur svg.i{width:12px;height:12px}
.meta{padding:6px 8px;display:flex;gap:6px;align-items:center;min-width:0}
.meta a{color:var(--fg);font-weight:700;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta a:hover{color:var(--accent);text-decoration:underline}
.meta .l{display:inline-flex;align-items:center;gap:3px;font-variant-numeric:tabular-nums}.meta .l svg.i{width:13px;height:13px}
.meta .r{margin-left:auto;display:flex;gap:4px}
.icon{border:none;background:none;padding:3px;color:var(--muted);border-radius:6px}.icon:hover{color:var(--accent)}
.empty{padding:40px;text-align:center;color:var(--muted);grid-column:1/-1}
</style></head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="m" viewBox="0 0 128 128"><path d="M90.92 69.26Q93.71 72.06 92.58 75Q91.45 77.93 87.5 78.13L71.34 78.91L84.21 108.94Q86.74 114.84 81.04 117.79L69.64 123.71Q66.93 125.11 64.43 124.27Q61.94 123.43 60.63 120.68L46.69 91.36L28.68 107.57Q25.75 110.21 22.87 108.93Q20 107.65 20 103.7V10.7Q20 6.68 22.95 5.46Q25.89 4.24 28.74 7.08ZM48 56H40V72H48ZM64 56H56V72H64Z"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8.5 8.5h.01"/><path d="M3 17l5.5-5.5L14 17l2-2 3.5 3.5"/></symbol>
<symbol id="i-video" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5Z"/></symbol>
<symbol id="i-collect" viewBox="0 0 24 24"><path d="M10 12H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3"/><path d="M11 10v11l3-2.5 2 3.7 2.3-1-2-3.7H20Z"/></symbol>
<symbol id="i-saved" viewBox="0 0 24 24"><path d="M3 12h5l1.5 2.5h5L16 12h5v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M7 12V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v7"/></symbol>
<symbol id="i-limits" viewBox="0 0 24 24"><path d="M6 18.5A9 9 0 1 1 21 12"/><path d="M17.5 12H21"/><path d="M12 12l4-4"/></symbol>
<symbol id="i-likes" viewBox="0 0 24 24"><path d="M12 19.4 4.8 12.2A4.5 4.5 0 1 1 12 6.9a4.5 4.5 0 1 1 7.2 5.3Z"/></symbol>
<symbol id="i-dl" viewBox="0 0 24 24"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></symbol>
</defs></svg>
<header><div class="brand"><svg class="mark" aria-hidden="true"><use href="#m"/></svg><b id="title">X media</b><span class="muted" id="sub"></span></div>
<div class="tabs"><button data-f="all" class="on">${ic("collect")}All</button><button data-f="photo">${ic("image")}Photos</button><button data-f="video">${ic("video")}Videos</button><button data-f="gif">${ic("limits")}GIFs</button>
<button id="send" class="primary" disabled>${ic("saved")}<span id="sendl">Use selected</span></button></div></header>
<div class="grid" id="grid"><div class="empty">Waiting for results…</div></div>
<script>${appBundle()}</script>
<script>
const { App } = globalThis.McpApps;
const app = new App({ name: "riffler-gallery", version: "0.3.0" }, {}, { autoResize: true });
let data = null, filter = "all"; const selected = new Set();
const $ = (s) => document.querySelector(s);
const fmt = (n) => n == null ? "" : n >= 1e6 ? (n/1e6).toFixed(1).replace(/\\.0$/,"")+"M" : n >= 1e3 ? (n/1e3).toFixed(1).replace(/\\.0$/,"")+"k" : ""+n;
const dur = (ms) => { if (!ms) return ""; const s = Math.round(ms/1000); return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); };
const ico = (n) => '<svg class="i" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
const IV = ico("video"), IL = ico("likes"), ID = ico("dl");
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
      '<span class="badge">' + key + '</span>' + (m.type !== "photo" ? '<span class="dur">' + (m.type === "gif" ? "GIF" : IV + dur(m.dur)) + "</span>" : "") +
      '<div class="meta"><a href="#" data-open="' + esc(it.url) + '" title="' + esc(it.text) + '">@' + esc(it.author) + '</a>' + (it.likes != null ? '<span class="muted l">' + IL + fmt(it.likes) + '</span>' : "") +
      '<span class="r"><button class="icon" title="Download" aria-label="Download" data-dl="' + esc(m.src) + '" data-name="' + esc(it.author + "_" + it.id + "_" + key) + '">' + ID + '</button></span></div></div>';
  }).join("");
  $("#send").disabled = !selected.size;
  $("#sendl").textContent = selected.size ? "Use " + selected.size + " selected" : "Use selected";
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
