import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserSession, hasAuthCookie, whoAmI } from "./browser.js";
import { collect, postIdFrom, SOURCES, type CollectResult } from "./collect.js";
import { config, mediaDir } from "./config.js";
import { downloadPosts, type DownloadResult } from "./download.js";
import type { MediaType, Post } from "./parse.js";
import { PostStore } from "./store.js";

const session = new BrowserSession();
const store = new PostStore();

const mediaTypeEnum = z.enum(["photo", "video", "gif"]);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error)?.message ?? String(e)}` }] };
}

function summarize(posts: Post[], downloads: DownloadResult[], textChars: number) {
  const byKey = new Map(downloads.map((d) => [`${d.post_id}:${d.media_key}`, d]));
  return posts.map((p) => ({
    id: p.id,
    url: p.url,
    author: p.author.handle,
    created_at: p.created_at,
    ...(textChars > 0 && p.text ? { text: p.text.length > textChars ? p.text.slice(0, textChars) + "…" : p.text } : {}),
    ...(p.context !== "timeline" ? { context: p.context } : {}),
    ...(p.retweeted_by ? { retweeted_by: p.retweeted_by } : {}),
    likes: p.metrics?.likes,
    views: p.metrics?.views,
    media: p.media.map((m) => {
      const d = byKey.get(`${p.id}:${m.key}`);
      return {
        type: m.type,
        ...(d?.path ? { file: d.path } : { url: m.url }),
        ...(d?.status === "error" ? { error: d.error } : {}),
        ...(m.duration_ms ? { duration_s: Math.round(m.duration_ms / 1000) } : {}),
        ...(m.width ? { size: `${m.width}x${m.height}` } : {}),
      };
    }),
  }));
}

function mediaCounts(posts: Post[]) {
  const c = { photo: 0, video: 0, gif: 0 };
  for (const p of posts) for (const m of p.media) c[m.type]++;
  return c;
}

function downloadCounts(d: DownloadResult[]) {
  return {
    downloaded: d.filter((x) => x.status === "downloaded").length,
    already_had: d.filter((x) => x.status === "exists").length,
    failed: d.filter((x) => x.status === "error").length,
    bytes: d.reduce((n, x) => n + (x.bytes ?? 0), 0),
  };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "x-for-agents", version: "0.1.0" });

  server.registerTool(
    "x_status",
    {
      title: "X login status",
      description:
        "Check whether the browser is signed in to X and which account. Run this first if other tools report a login problem.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await session.withPage(async (page, ctx) => {
          const cookie = await hasAuthCookie(ctx);
          const who = await whoAmI(page);
          return { ...who, has_auth_cookie: cookie };
        });
        return ok({
          logged_in: res.loggedIn,
          account: res.handle ? `@${res.handle}` : undefined,
          has_auth_cookie: res.has_auth_cookie,
          data_dir: config.dataDir,
          posts_indexed: store.size(),
          ...(res.loggedIn
            ? {}
            : { how_to_login: "In a terminal: `npx x-for-agents login` (or `import-cookies <file>`), then retry." }),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "x_collect",
    {
      title: "Scroll X and collect media",
      description: [
        "Open an X feed with the user's logged-in account, scroll it, and collect posts with their images/videos.",
        "By default only posts that contain media are kept and all media is downloaded to disk (full-resolution images, highest-bitrate MP4s).",
        "Sources: home (For You), following, user (a profile's posts), user_media (a profile's Media tab — best for grabbing everything someone posted),",
        "search (target = query, supports X operators like 'from:nasa filter:videos'), bookmarks, likes (target = your handle), list (target = list id/URL), url (any x.com URL).",
        "Returns a compact summary with local file paths; the full JSON is saved to `saved_to`. Downloaded images can be viewed with the Read tool.",
      ].join(" "),
      inputSchema: {
        source: z.enum(SOURCES).describe("Which feed to scroll."),
        target: z.string().optional().describe("Handle, search query, list id, or URL depending on source."),
        search_mode: z.enum(["top", "latest", "media"]).optional().describe("For source=search. Default latest."),
        max_posts: z.number().int().min(1).max(1000).default(40).describe("Stop after this many matching posts."),
        max_scrolls: z.number().int().min(0).max(500).default(60).describe("Hard cap on scroll steps."),
        media_only: z.boolean().default(true).describe("Keep only posts that have media."),
        media_types: z.array(mediaTypeEnum).optional().describe("Restrict to these media types, e.g. ['video']."),
        download: z.boolean().default(true).describe("Download the media files to disk."),
        include_retweets: z.boolean().default(true),
        include_quoted: z.boolean().default(false).describe("Also keep posts that only appear as quotes."),
        since: z.string().optional().describe("ISO date; stop once the feed scrolls past it (works best on latest-first feeds)."),
        output_dir: z.string().optional().describe(`Where to save media. Default ${mediaDir()}`),
        text_chars: z.number().int().min(0).max(4000).default(140).describe("Characters of post text to include in the response (0 = none)."),
      },
    },
    async (a) => {
      try {
        const result: CollectResult = await session.withPage((page) =>
          collect(page, {
            source: a.source,
            target: a.target,
            searchMode: a.search_mode ?? "latest",
            maxPosts: a.max_posts,
            maxScrolls: a.max_scrolls,
            mediaOnly: a.media_only,
            mediaTypes: a.media_types as MediaType[] | undefined,
            includeQuoted: a.include_quoted,
            includeRetweets: a.include_retweets,
            since: a.since,
          }),
        );
        store.add(result.posts);
        const downloads = a.download
          ? await downloadPosts(result.posts, { types: a.media_types as MediaType[] | undefined, dir: a.output_dir })
          : [];
        const savedTo = store.saveCollection(`${a.source}_${a.target ?? ""}`, { ...result, downloads });
        return ok({
          source: a.source,
          url: result.url,
          stop_reason: result.stopReason,
          scrolls: result.scrolls,
          posts: result.posts.length,
          media: mediaCounts(result.posts),
          ...(a.download ? { downloads: downloadCounts(downloads), media_dir: a.output_dir ?? mediaDir() } : {}),
          saved_to: savedTo,
          ...(result.stopReason === "rate_limited"
            ? { warning: "X returned 429 (rate limited). Wait 15+ minutes before scrolling again." }
            : {}),
          items: summarize(result.posts, downloads, a.text_chars),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "x_get_post",
    {
      title: "Get one X post",
      description: "Fetch a single post (by URL or id) with its media, and optionally download the media. Also returns the post it quotes, if any.",
      inputSchema: {
        post: z.string().describe("Post URL (https://x.com/user/status/123…) or numeric id."),
        download: z.boolean().default(true),
        output_dir: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const result = await session.withPage((page) =>
          collect(page, {
            source: "post",
            target: a.post,
            maxPosts: 2,
            maxScrolls: 0,
            mediaOnly: false,
            includeQuoted: true,
            includeRetweets: true,
          }),
        );
        if (!result.posts.length) throw new Error("Post not found (deleted, protected, or not visible to this account).");
        store.add(result.posts);
        const downloads = a.download ? await downloadPosts(result.posts, { dir: a.output_dir }) : [];
        return ok({
          ...(a.download ? { downloads: downloadCounts(downloads) } : {}),
          items: summarize(result.posts, downloads, 4000),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "x_download",
    {
      title: "Download media for posts",
      description:
        "Download media for posts already collected (by id/URL). Posts not in the local index are fetched from X first. Use this after x_collect with download=false.",
      inputSchema: {
        posts: z.array(z.string()).min(1).max(500).describe("Post ids or URLs."),
        media_types: z.array(mediaTypeEnum).optional(),
        output_dir: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const posts: Post[] = [];
        const missing: string[] = [];
        for (const ref of a.posts) {
          const id = postIdFrom(ref);
          const p = store.get(id);
          if (p) posts.push(p);
          else missing.push(id);
        }
        for (const id of missing) {
          const r = await session.withPage((page) =>
            collect(page, {
              source: "post",
              target: id,
              maxPosts: 1,
              maxScrolls: 0,
              mediaOnly: false,
              includeQuoted: false,
              includeRetweets: true,
            }),
          );
          const p = r.posts.find((x) => x.id === id);
          if (p) {
            store.add([p]);
            posts.push(p);
          }
        }
        const downloads = await downloadPosts(posts, { types: a.media_types as MediaType[] | undefined, dir: a.output_dir });
        return ok({
          ...downloadCounts(downloads),
          not_found: missing.filter((id) => !posts.some((p) => p.id === id)),
          files: downloads.map((d) => ({ post: d.post_id, type: d.type, file: d.path, status: d.status, error: d.error })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export async function serveStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  transport.onclose = () => void shutdown();
  await server.connect(transport);
  console.error(`x-for-agents MCP server ready (data: ${config.dataDir})`);
}
