/**
 * Contact sheets: many thumbnails rendered into ONE small JPEG, each labelled with its row
 * number (+ letter for multi-media posts). Lets Claude visually recognise/curate dozens of
 * items for roughly the token cost of a single image.
 */
import fs from "node:fs";
import type { BrowserPool } from "./browser.js";
import type { Post } from "./parse.js";

export interface SheetCell {
  label: string;
  thumb: string;
  type: string;
  dur?: number;
}

export function cellsFor(posts: Post[], startRow = 1, localFiles?: Map<string, string>): SheetCell[] {
  const cells: SheetCell[] = [];
  posts.forEach((p, i) =>
    p.media.forEach((m, j) => {
      const local = m.type === "photo" ? localFiles?.get(`${p.id}:${m.key}`) : undefined;
      let thumb = m.thumbnail ?? m.url;
      if (local && fs.existsSync(local) && fs.statSync(local).size < 3_000_000) {
        const ext = local.endsWith(".png") ? "png" : local.endsWith(".webp") ? "webp" : "jpeg";
        thumb = `data:image/${ext};base64,${fs.readFileSync(local).toString("base64")}`;
      }
      cells.push({
        label: `${startRow + i}${p.media.length > 1 ? "abcdefgh"[j] ?? "" : ""}`,
        thumb,
        type: m.type,
        dur: m.duration_ms,
      });
    }),
  );
  return cells;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function renderSheet(pool: BrowserPool, cells: SheetCell[], o: { cols?: number; cell?: number } = {}): Promise<Buffer> {
  const cols = o.cols ?? 6;
  const size = o.cell ?? 170;
  const html = `<!doctype html><html><head><style>
    body{margin:0;background:#111;font:600 13px system-ui,sans-serif}
    .g{display:grid;grid-template-columns:repeat(${cols},${size}px);gap:3px;padding:3px;width:max-content}
    .c{position:relative;width:${size}px;height:${size}px;background:#222;overflow:hidden}
    .c img{width:100%;height:100%;object-fit:cover}
    .l{position:absolute;top:3px;left:3px;background:#000c;color:#fff;padding:0 5px;border-radius:4px}
    .t{position:absolute;bottom:3px;right:3px;background:#1d9bf0;color:#fff;padding:0 5px;border-radius:4px;font-size:11px}
  </style></head><body><div class="g">${cells
    .map((c) => {
      const s = c.dur ? Math.round(c.dur / 1000) : 0;
      const tag = c.type === "video" ? `▶ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : c.type === "gif" ? "GIF" : "";
      return `<div class="c"><img src="${esc(c.thumb)}"><span class="l">${esc(c.label)}</span>${tag ? `<span class="t">${tag}</span>` : ""}</div>`;
    })
    .join("")}</div></body></html>`;

  return pool.withScratchPage(async (page) => {
    await page.setViewportSize({ width: cols * (size + 3) + 3, height: 600 });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page
      .waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 10_000 })
      .catch(() => undefined);
    const el = await page.$(".g");
    return (await el!.screenshot({ type: "jpeg", quality: 62 })) as Buffer;
  });
}
