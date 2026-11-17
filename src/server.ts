import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getUiCapability, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { BrowserPool, hasAuthCookie, whoAmI } from "./browser.js";
import { collect, postIdFrom, rateLimits, SOURCES, type CollectOptions, type CollectResult } from "./collect.js";
import { config, displayPath, resolveOutDir } from "./config.js";
import { downloadPosts, resolveFfmpeg, startDownloads, type DownloadResult } from "./download.js";
import { downloadLine, fullJson, kfmt, rows, runHeader, type Detail } from "./format.js";
import type { MediaType, Post } from "./parse.js";
import { cellsFor, renderSheet } from "./preview.js";
import { PostStore, type Run } from "./store.js";
import { GALLERY_URI, UI_CSP, UI_MIME, galleryData, galleryHtml } from "./ui.js";

export const pool = new BrowserPool();
const store = new PostStore();
const VERSION = "0.2.0";

// ---------------------------------------------------------------- schemas (kept terse: every word here costs tokens on every turn)

const mediaType = z.enum(["photo", "video", "gif"]);
const jobShape = {
  source: z.enum(SOURCES),
  target: z.string().optional().describe("handle | search query | list id | post/x.com URL"),
  search_mode: z.enum(["latest", "top", "media"]).optional(),
  max_posts: z.number().int().min(1).max(2000).optional().describe("default 40"),
  max_scrolls: z.number().int().min(0).max(1000).optional().describe("default 60"),
  media_types: z.array(mediaType).optional(),
  media_only: z.boolean().optional().describe("default true"),
  match: z.string().optional().describe("keywords a,b (any) or /regex/ on text+alt"),
  min_likes: z.number().optional(),
  min_views: z.number().optional(),
  min_size: z.number().optional().describe("min px of longest side"),
  min_duration_s: z.number().optional(),
  max_duration_s: z.number().optional(),
  lang: z.string().optional(),
  since: z.string().optional().describe("ISO date; stop past it"),
  include_retweets: z.boolean().optional().describe("default true"),
  include_quoted: z.boolean().optional(),
};
const jobSchema = z.object(jobShape);
type Job = z.infer<typeof jobSchema>;

const outputShape = {
  download: z.boolean().optional().describe("default true"),
  output_dir: z.string().optional().describe("relative = inside current project/repo"),
  detail: z.enum(["summary", "compact", "full"]).optional(),
  text_chars: z.number().int().min(0).max(2000).optional().describe("default 60"),
  preview: z.boolean().optional().describe("attach contact-sheet image"),
  rate_limit_wait_s: z.number().int().min(0).max(1800).optional().describe("wait for reset instead of stopping"),
};

// ---------------------------------------------------------------- helpers

function jobLabel(j: Job) {
  return j.target ? `${j.source} ${j.source.startsWith("user") || j.source === "likes" ? "@" + j.target.replace(/^@/, "") : j.target}` : j.source;
}

function toOptions(j: Job, rateLimitWaitS?: number): CollectOptions {
  return {
    source: j.source,
    target: j.target,
    searchMode: j.search_mode ?? "latest",
    maxPosts: j.max_posts ?? 40,
    maxScrolls: j.max_scrolls ?? 60,
    mediaOnly: j.media_only ?? true,
    mediaTypes: j.media_types as MediaType[] | undefined,
    includeQuoted: j.include_quoted ?? false,
    includeRetweets: j.include_retweets ?? true,
    match: j.match,
    minLikes: j.min_likes,
    minViews: j.min_views,
    minSize: j.min_size,
    minDurationS: j.min_duration_s,
    maxDurationS: j.max_duration_s,
    lang: j.lang,
    since: j.since,
    rateLimitWaitS,
  };
}

interface JobOutcome {
  id: string;
  label: string;
  result: CollectResult;
  downloads?: DownloadResult[];
  outDir: string;
  error?: string;
}

async function runJob(j: Job, out: { download?: boolean; output_dir?: string; rate_limit_wait_s?: number }): Promise<JobOutcome> {
  const id = store.newRunId();
  const label = jobLabel(j);
  const outDir = resolveOutDir(out.output_dir);
  const download = out.download ?? true;
  const opts = toOptions(j, out.rate_limit_wait_s);
  const early: Promise<DownloadResult>[] = [];
  const started = new Set<string>();
  if (download && j.source !== "post") {
    // Start downloading each post the moment it's seen, while the tab keeps scrolling.
    opts.onPost = (p) => {
      started.add(p.id);
      early.push(...startDownloads(p, { dir: outDir }));
    };
  }
  const result = await pool.withPage((page) => collect(page, opts));
  store.add(result.unfiltered ?? result.posts);
  let downloads: DownloadResult[] | undefined;
  if (download) {
    const rest = result.posts.filter((p) => !started.has(p.id));
    downloads = [...(await Promise.all(early)), ...(await downloadPosts(rest, { dir: outDir }))];
  }
  const run: Run = {
    id,
    label,
    created_at: new Date().toISOString(),
    url: result.url,
    stop: result.stopReason,
    posts: result.posts,
    files: downloads?.filter((d) => d.path).map((d) => ({ post: d.post_id, key: d.media_key, path: d.path })),
  };
  store.saveRun(run);
  return { id, label, result, downloads, outDir };
}

function localFileMap(run: Run): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of (run.files as { post: string; key: string; path: string }[] | undefined) ?? []) m.set(`${f.post}:${f.key}`, f.path);
  return m;
}

/** "1-10,14,20b" → row numbers (letters ignored; whole post selected). */
function parseRows(spec: string | undefined, max: number): number[] {
  if (!spec) return Array.from({ length: max }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
    const r = part.match(/^(\d+)[a-h]?(?:-(\d+)[a-h]?)?$/);
    if (!r) continue;
    const a = Number(r[1]);
    const b = r[2] ? Number(r[2]) : a;
    for (let i = Math.max(1, a); i <= Math.min(b, max); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Selection for downloads: "2a,5,9-12" → posts from the run, trimmed to the lettered media
 * where a letter is given (letters match the labels on contact sheets and in the gallery).
 */
export function selectFromRun(posts: Post[], spec?: string): Post[] {
  const rowsWanted = parseRows(spec, posts.length);
  const letters = new Map<number, Set<number>>();
  let wholeRows = new Set<number>();
  for (const part of (spec ?? "").split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)([a-h])$/);
    if (m) letters.set(Number(m[1]), (letters.get(Number(m[1])) ?? new Set()).add(m[2].charCodeAt(0) - 97));
    else for (const n of parseRows(part, posts.length)) wholeRows.add(n);
  }
  if (!spec) wholeRows = new Set(rowsWanted);
  return rowsWanted.map((n) => {
    const p = posts[n - 1];
    const pick = letters.get(n);
    if (!pick || wholeRows.has(n)) return p;
    return { ...p, media: p.media.filter((_, j) => pick.has(j)) };
  });
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function buildServer(): McpServer {
  const server = new McpServer({ name: "x-for-agents", version: VERSION });
  const wantsUi = () =>
    process.env.X_UI === "always" || (process.env.X_UI !== "never" && !!getUiCapability(server.server.getClientCapabilities() as any));
  const ui = { ui: { resourceUri: GALLERY_URI } };

  registerAppResource(server, "X media gallery", GALLERY_URI, { description: "Gallery for x-for-agents results" }, async () => ({
    contents: [{ uri: GALLERY_URI, mimeType: UI_MIME, text: galleryHtml(), _meta: { ui: { csp: UI_CSP } } }],
  }));

  async function preview(posts: Post[], startRow: number, run?: Run, cols?: number): Promise<Content | null> {
    const cells = cellsFor(posts, startRow, run ? localFileMap(run) : undefined);
    if (!cells.length) return null;
    const jpg = await renderSheet(pool, cells.slice(0, 60), { cols: cols ?? (cells.length <= 12 ? 4 : 6) });
    return { type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" };
  }

  // ------------------------------------------------------------ x_collect
  registerAppTool(
    server,
    "x_collect",
    {
      title: "Collect from X",
      description:
        "Scroll an X feed on the user's logged-in account (headless, fast) and collect posts + download media (orig-size images, best MP4). " +
        "Sources: home, following, user, user_media (best for all of someone's media), search (X operators ok), bookmarks, likes, list, post, url. " +
        "Filters run server-side, so prefer them over reading results. Output rows are numbered for x_preview/x_download. " +
        "For several feeds at once use x_batch (parallel tabs).",
      inputSchema: { ...jobShape, ...outputShape },
      _meta: ui,
    },
    async (a: any) => {
      try {
        const o = await runJob(a, a);
        const detail: Detail = a.detail ?? "compact";
        const content: Content[] = [{ type: "text", text: renderOutcome(o, detail, a.text_chars ?? 60) }];
        if (a.preview) {
          const img = await preview(o.result.posts, 1, store.getRun(o.id), undefined);
          if (img) content.push(img);
        }
        return {
          content,
          ...(wantsUi() ? { structuredContent: galleryData(o.id, o.label, o.result.posts, o.result.stopReason) as any } : {}),
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ------------------------------------------------------------ x_batch
  registerAppTool(
    server,
    "x_batch",
    {
      title: "Collect from many X feeds in parallel",
      description: `Run up to 50 x_collect jobs concurrently across ${config.tabs} browser tabs on the same account. One summary line per job by default.`,
      inputSchema: { jobs: z.array(jobSchema).min(1).max(50), ...outputShape },
      _meta: ui,
    },
    async (a: any) => {
      const t0 = Date.now();
      const outcomes = await Promise.all(
        (a.jobs as Job[]).map((j) =>
          runJob(j, a).catch(
            (e): JobOutcome => ({
              id: "-",
              label: jobLabel(j),
              outDir: resolveOutDir(a.output_dir),
              error: (e as Error).message,
              result: { url: "", posts: [], scrolls: 0, apiResponses: 0, stopReason: "end_of_feed", elapsedMs: 0 },
            }),
          ),
        ),
      );
      const detail: Detail = a.detail ?? "summary";
      const allPosts = outcomes.flatMap((o) => o.result.posts);
      const allDl = outcomes.flatMap((o) => o.downloads ?? []);
      // One combined run, so preview labels and gallery selections map to real rows.
      const batchId = store.newRunId();
      store.saveRun({
        id: batchId,
        label: `batch of ${outcomes.length}`,
        created_at: new Date().toISOString(),
        jobs: outcomes.map((o) => o.id),
        posts: allPosts,
        files: allDl.filter((d) => d.path).map((d) => ({ post: d.post_id, key: d.media_key, path: d.path })),
      });
      const head = `batch run ${batchId} (rows = all jobs in order) · ${outcomes.length} jobs · ${allPosts.length} posts · ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        (a.download ?? true ? "\n" + downloadLine(allDl, resolveOutDir(a.output_dir)) : "");
      const body = outcomes
        .map((o) => (o.error ? `✗ ${o.label}: ${o.error}` : renderOutcome(o, detail, a.text_chars ?? 60, true)))
        .join(detail === "summary" ? "\n" : "\n\n");
      const content: Content[] = [{ type: "text", text: `${head}\n${body}` }];
      if (a.preview) {
        const img = await preview(allPosts.slice(0, 60), 1, store.getRun(batchId));
        if (img) content.push(img);
      }
      return {
        content,
        ...(wantsUi() ? { structuredContent: galleryData(batchId, `Batch · ${outcomes.length} feeds`, allPosts) as any } : {}),
      };
    },
  );

  // ------------------------------------------------------------ x_preview
  registerAppTool(
    server,
    "x_preview",
    {
      title: "Contact sheet of collected media",
      description:
        "Render a run's media as ONE labelled thumbnail grid image (cheap way to see/judge up to 60 items). Labels = row number (+letter for multi-media posts).",
      inputSchema: {
        run: z.string().describe("run id from x_collect/x_batch"),
        rows: z.string().optional().describe('e.g. "1-30" (default first 30)'),
        cols: z.number().int().min(2).max(10).optional(),
      },
      _meta: ui,
    },
    async (a) => {
      try {
        const run = store.getRun(a.run);
        if (!run) throw new Error(`unknown run ${a.run}`);
        const sel = parseRows(a.rows ?? "1-30", run.posts.length);
        const posts = sel.map((n) => run.posts[n - 1]);
        // Labels must reflect original row numbers even for sparse selections.
        const cells = posts.flatMap((p, i) => cellsFor([p], sel[i], localFileMap(run)));
        const jpg = await renderSheet(pool, cells.slice(0, 60), { cols: a.cols ?? (cells.length <= 12 ? 4 : 6) });
        return {
          content: [
            { type: "text" as const, text: `run ${run.id} · ${run.label} · rows ${a.rows ?? "1-30"} · ${cells.length} items` },
            { type: "image" as const, data: jpg.toString("base64"), mimeType: "image/jpeg" },
          ],
          ...(wantsUi() ? { structuredContent: galleryData(run.id, run.label, posts) as any } : {}),
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ------------------------------------------------------------ x_download
  server.registerTool(
    "x_download",
    {
      title: "Download media",
      description: "Download media for rows of a run (e.g. after reviewing x_preview) or for post ids/URLs. Use output_dir to put files in the repo.",
      inputSchema: {
        run: z.string().optional(),
        rows: z.string().optional().describe('e.g. "2,5b,9-12" (letter = one media of that post)'),
        posts: z.array(z.string()).max(500).optional().describe("post ids/URLs"),
        media_types: z.array(mediaType).optional(),
        output_dir: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const posts: Post[] = [];
        if (a.run) {
          const run = store.getRun(a.run);
          if (!run) throw new Error(`unknown run ${a.run}`);
          posts.push(...selectFromRun(run.posts, a.rows));
        }
        const missing: string[] = [];
        for (const ref of a.posts ?? []) {
          const id = postIdFrom(ref);
          const p = store.get(id);
          p ? posts.push(p) : missing.push(id);
        }
        await Promise.all(
          missing.map((id) =>
            pool
              .withPage((page) =>
                collect(page, { ...toOptions({ source: "post", target: id }), mediaOnly: false, maxPosts: 2, maxScrolls: 0 }),
              )
              .then((r) => {
                const p = r.posts.find((x) => x.id === id);
                if (p) {
                  store.add([p]);
                  posts.push(p);
                }
              })
              .catch(() => undefined),
          ),
        );
        if (!posts.length) throw new Error("nothing to download (give run+rows or posts)");
        const outDir = resolveOutDir(a.output_dir);
        const d = await downloadPosts(posts, { types: a.media_types as MediaType[] | undefined, dir: outDir });
        const notFound = missing.filter((id) => !posts.some((p) => p.id === id));
        const files = d.filter((x) => x.path).map((x) => displayPath(x.path!));
        return {
          content: [
            {
              type: "text" as const,
              text: [downloadLine(d, outDir), notFound.length ? `not found: ${notFound.join(",")}` : "", files.length <= 40 ? files.join("\n") : ""]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ------------------------------------------------------------ x_status
  server.registerTool(
    "x_status",
    { title: "X status", description: "Login state, account, tabs, rate limits, ffmpeg, output dir.", inputSchema: {} },
    async () => {
      try {
        const who = await pool.withPage(async (page, ctx) => ({ ...(await whoAmI(page)), cookie: await hasAuthCookie(ctx) }));
        const ff = await resolveFfmpeg({ install: false });
        const rl = [...rateLimits.entries()]
          .map(([op, r]) => `${op} ${r.remaining}/${r.limit} (reset ${Math.max(0, Math.round((r.reset - Date.now() / 1000) / 60))}m)`)
          .join(", ");
        const lines = [
          who.loggedIn ? `logged in as @${who.handle}` : `NOT logged in (${who.cookie ? "cookie present but rejected" : "no auth cookie"})`,
          `tabs ${pool.stats.open}/${pool.stats.max} open, ${pool.stats.busy} busy`,
          `output ${displayPath(resolveOutDir())} · index ${kfmt(store.size())} posts`,
          `ffmpeg ${ff ? "ok" : "not installed (auto-installs if an HLS-only video needs it)"}`,
          rl ? `rate limits: ${rl}` : "",
          who.loggedIn ? "" : "fix: local → `npx x-for-agents login`; cloud/web → set X_AUTH_TOKEN + X_CT0 env vars",
        ];
        return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

function renderOutcome(o: JobOutcome, detail: Detail, textChars: number, inBatch = false): string {
  if (detail === "summary" && inBatch) {
    const r = o.result;
    const files = o.downloads ? ` · ${o.downloads.filter((d) => d.status !== "error").length} files` : "";
    const media = r.posts.reduce((n, p) => n + p.media.length, 0);
    return `${o.id} · ${o.label} · ${r.posts.length} posts · ${media} media${files} · ${r.stopReason} · ${(r.elapsedMs / 1000).toFixed(1)}s`;
  }
  const head = runHeader({ id: o.id, label: o.label, result: o.result, downloads: inBatch ? undefined : o.downloads, outDir: o.outDir });
  if (detail === "summary") return head;
  if (detail === "full") return head + "\n" + fullJson(o.result.posts);
  return head + "\n" + rows(o.result.posts, { textChars, limit: 50 });
}

function fail(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error)?.message ?? String(e)}` }] };
}

export async function serveStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await pool.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  transport.onclose = () => void shutdown();
  // The stdio transport doesn't notice the client going away; without this the orphaned
  // server keeps the browser profile locked and the next launch fails.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  await server.connect(transport);
  console.error(`[x-for-agents] MCP ready · tabs=${config.tabs} · output=${displayPath(resolveOutDir())}`);
}
