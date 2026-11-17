/**
 * End-to-end test against a mock x.com: a fake infinite-scroll timeline whose page JS
 * fetches GraphQL pages (with real-shaped tweets + rate-limit headers) as you scroll,
 * plus a local media server. Exercises the real MCP tools, tab pool, parallel batch,
 * streaming downloads, filters, rate-limit stop, contact sheets and run/rows downloads.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xfa-e2e-"));
process.env.X_HOME = path.join(tmp, "home");
process.env.X_DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_PROJECT_DIR = path.join(tmp, "project");
process.env.X_SCROLL_DELAY_MS = "0";
process.env.X_RESPONSE_WAIT_MS = "800";
process.env.X_UI = "always";
fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR, { recursive: true });

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { buildServer, pool } = await import("../src/server.ts");

let media: http.Server;
let base = "";
let jpg: Buffer;
let client: InstanceType<typeof Client>;
const PAGE = 20;

function tweet(id: string, handle: string, i: number) {
  const photo = { media_key: `3_${id}`, type: "photo", url: "https://t.co/m", media_url_https: `${base}/m/${id}.jpg`, original_info: { width: 1200, height: 900 } };
  const video = {
    media_key: `7_${id}`, type: "video", url: "https://t.co/m", media_url_https: `${base}/m/${id}.jpg`, original_info: { width: 1280, height: 720 },
    video_info: { duration_millis: 12000, variants: [{ content_type: "video/mp4", bitrate: 2176000, url: `${base}/v/${id}.mp4` }] },
  };
  return {
    entryId: `tweet-${id}`,
    content: { itemContent: { tweet_results: { result: {
      __typename: "Tweet", rest_id: id,
      core: { user_results: { result: { rest_id: "1", core: { screen_name: handle } } } },
      views: { count: String(1000 * i) },
      legacy: {
        created_at: new Date(Date.UTC(2026, 10, 15) - Number(id.slice(-4)) * 60_000).toUTCString(),
        full_text: `${i % 2 ? "dog" : "cat"} post ${id} https://t.co/m`, favorite_count: i * 10, lang: "en",
        extended_entities: { media: i % 5 === 0 ? [photo, video] : [photo] },
      },
    } } } },
  };
}

function feedPage(op: string, target: string) {
  return `<!doctype html><html><body><div id="feed"></div><div id="s" style="height:10px"></div><script>
  let c = 0, busy = false, done = false;
  async function more() {
    if (busy || done) return; busy = true;
    const r = await fetch('/i/api/graphql/abc/${op}?c=' + c + '&t=${encodeURIComponent(target)}');
    if (r.status === 200) { const j = await r.json(); if (!j.n) done = true;
      for (let i = 0; i < j.n; i++) { const d = document.createElement('div'); d.style.height = '300px'; d.textContent = 'p'; feed.appendChild(d); }
      c++; }
    busy = false;
  }
  new IntersectionObserver((e) => { if (e[0].isIntersecting) more(); }).observe(document.getElementById('s'));
  </script></body></html>`;
}

before(async () => {
  media = http.createServer((req, res) => {
    setTimeout(() => {
      if (req.url!.startsWith("/m/")) res.writeHead(200, { "content-type": "image/jpeg" }).end(jpg);
      else if (req.url!.startsWith("/v/")) res.writeHead(200, { "content-type": "video/mp4" }).end(Buffer.alloc(50_000, 1));
      else res.writeHead(404).end();
    }, 15);
  });
  await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(media.address() as any).port}`;

  const ctx = await pool.context();
  // A real JPEG for thumbnails, rendered by the browser itself.
  const p = await ctx.newPage();
  await p.setContent('<div style="width:200px;height:200px;background:linear-gradient(45deg,#1d9bf0,#f91880)"></div>');
  jpg = (await p.locator("div").screenshot({ type: "jpeg" })) as Buffer;
  await p.close();

  await ctx.addCookies([{ name: "auth_token", value: "test", domain: ".x.com", path: "/", secure: true, sameSite: "None" }]);
  await ctx.route("https://x.com/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/i/api/graphql/")) {
      const op = u.pathname.split("/").pop()!;
      const c = Number(u.searchParams.get("c"));
      const t = u.searchParams.get("t")!;
      const headers = { "content-type": "application/json", "x-rate-limit-limit": "500", "x-rate-limit-remaining": String(500 - c), "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) };
      if (t === "slowpoke" && c >= 1) return route.fulfill({ status: 429, headers, body: "{}" });
      const pages = t === "short" ? 2 : 50;
      const n = c < pages ? PAGE : 0;
      const seed = [...t].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 90 + 10;
      const entries = Array.from({ length: n }, (_, i) => tweet(`${seed}${String(c).padStart(3, "0")}${String(i).padStart(4, "0")}`, t, i));
      await new Promise((r) => setTimeout(r, 60)); // network latency
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ n, data: { timeline: { instructions: [{ entries }] } } }) });
    }
    const seg = u.pathname.split("/").filter(Boolean);
    const op = u.pathname === "/home" ? "HomeTimeline" : seg[1] === "media" ? "UserMedia" : seg[0] === "search" ? "SearchTimeline" : "UserTweets";
    const target = op === "HomeTimeline" ? "home" : op === "SearchTimeline" ? u.searchParams.get("q")! : seg[0];
    return route.fulfill({ status: 200, contentType: "text/html", body: feedPage(op, target) });
  });

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(st);
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(ct);
});

after(async () => {
  await client?.close();
  await pool.close();
  media?.close();
});

const text = (r: any) => r.content.find((c: any) => c.type === "text").text as string;

test("tools are registered with the gallery UI", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["x_batch", "x_collect", "x_download", "x_preview", "x_status"]);
  const collect = tools.find((t) => t.name === "x_collect")!;
  assert.equal((collect._meta as any).ui.resourceUri, "ui://x-for-agents/gallery.html");
  const res = await client.readResource({ uri: "ui://x-for-agents/gallery.html" });
  assert.match((res.contents[0] as any).text, /globalThis\.McpApps=\{/);
  assert.equal((res.contents[0] as any).mimeType, "text/html;profile=mcp-app");
});

test("x_batch: 10 feeds in parallel tabs, streaming downloads into the project", async () => {
  const t0 = Date.now();
  const r: any = await client.callTool({
    name: "x_batch",
    arguments: { jobs: Array.from({ length: 10 }, (_, i) => ({ source: "user_media", target: `user${i}`, max_posts: 60 })), output_dir: "assets/x" },
  });
  const ms = Date.now() - t0;
  const out = text(r);
  console.log(out.split("\n").slice(0, 4).join("\n"), `\n(${ms}ms, ${out.length} chars)`);
  assert.match(out, /batch run r[0-9a-f]{8} .* 10 jobs · 600 posts/);
  assert.match(out, /files: 720 new, 0 had, 0 failed/); // 60 posts × (1 photo, +1 video every 5th)
  assert.equal(pool.stats.open, 10);
  const dir = path.join(process.env.CLAUDE_PROJECT_DIR!, "assets/x");
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(jpg|mp4)$/.test(String(f)));
  assert.equal(files.length, 720);
  assert.ok(r.structuredContent.items.length > 0, "gallery data when UI is supported");
  assert.ok(out.length < 1500, "batch summary stays small");
  const batchRun = out.match(/batch run (r[0-9a-f]{8})/)![1];
  assert.equal(r.structuredContent.run, batchRun, "gallery selections map to the combined run");
  const pv: any = await client.callTool({ name: "x_preview", arguments: { run: batchRun, rows: "1-12" } });
  assert.ok(pv.content.some((c: any) => c.type === "image"), "batch run is previewable");
});

test("more concurrent calls than tabs: extra calls queue for a free tab and all finish", async () => {
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      client.callTool({ name: "x_collect", arguments: { source: "user_media", target: `q${i}`, max_posts: 30, download: false, detail: "summary" } }),
    ),
  );
  for (const r of results) assert.match(text(r), /30 posts .* stop=max_posts/);
  assert.equal(pool.stats.open, 10, "never more than X_TABS tabs");
  assert.equal(pool.stats.busy, 0);
  assert.equal(pool.stats.queued, 0);
  console.log(`15 calls on 10 tabs: ${Date.now() - t0}ms`);
});

test("x_collect: filters, compact rows, preview image", async () => {
  const r: any = await client.callTool({ name: "x_collect", arguments: { source: "home", match: "cat", max_posts: 15, preview: true } });
  const out = text(r);
  const rows = out.split("\n").filter((l) => /^\d+\|/.test(l));
  assert.equal(rows.length, 15);
  assert.ok(rows.every((l) => l.includes("cat post")));
  const img = r.content.find((c: any) => c.type === "image");
  assert.ok(img && img.data.length > 1000);
  fs.writeFileSync(path.join(tmp, "sheet.jpg"), Buffer.from(img.data, "base64"));
  console.log("sheet:", path.join(tmp, "sheet.jpg"));
});

test("x_collect: stops on rate limit and on end of feed", async () => {
  const rl = text(await client.callTool({ name: "x_collect", arguments: { source: "user", target: "slowpoke", max_posts: 200, download: false, detail: "summary" } }));
  assert.match(rl, /stop=rate_limited/);
  assert.match(rl, /rate UserTweets: \d+\/500 left/);
  const eof = text(await client.callTool({ name: "x_collect", arguments: { source: "user", target: "short", max_posts: 500, download: false, detail: "summary" } }));
  assert.match(eof, /40 posts .* stop=end_of_feed/);
});

test("x_preview + x_download by run rows", async () => {
  const r = text(await client.callTool({ name: "x_collect", arguments: { source: "search", target: "sunsets", max_posts: 12, download: false, detail: "summary" } }));
  const run = r.match(/run (\S+)/)![1];
  const pv: any = await client.callTool({ name: "x_preview", arguments: { run, rows: "1-6" } });
  assert.ok(pv.content.some((c: any) => c.type === "image"));
  const dl = text(await client.callTool({ name: "x_download", arguments: { run, rows: "1,5", output_dir: "picked" } }));
  assert.match(dl, /files: 3 new/); // row 1 has photo+video, row 5 photo
  assert.ok(fs.existsSync(path.join(process.env.CLAUDE_PROJECT_DIR!, "picked")));
  const one = text(await client.callTool({ name: "x_download", arguments: { run, rows: "1b", output_dir: "one" } }));
  assert.match(one, /files: 1 new/);
  assert.match(one, /_2\.mp4/, "letter b = the post's second media (the video)");
});
