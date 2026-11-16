import type { Page, Response } from "playwright";
import { config } from "./config.js";
import { extractPosts, type MediaType, type Post } from "./parse.js";

export const SOURCES = [
  "home",
  "following",
  "user",
  "user_media",
  "search",
  "bookmarks",
  "likes",
  "list",
  "post",
  "url",
] as const;
export type Source = (typeof SOURCES)[number];

export interface CollectOptions {
  source: Source;
  /** handle for user/user_media/likes, query for search, list id for list, URL/id for post/url */
  target?: string;
  searchMode?: "top" | "latest" | "media";
  maxPosts: number;
  maxScrolls: number;
  mediaOnly: boolean;
  mediaTypes?: MediaType[];
  includeQuoted: boolean;
  includeRetweets: boolean;
  /** Stop when posts get older than this ISO date (latest-first feeds only). */
  since?: string;
}

export interface CollectResult {
  url: string;
  posts: Post[];
  scrolls: number;
  apiResponses: number;
  stopReason: "max_posts" | "max_scrolls" | "end_of_feed" | "rate_limited" | "reached_since" | "single_post";
}

export class NotLoggedInError extends Error {
  constructor() {
    super(
      "Not logged in to X. Run `npx x-for-agents login` in a terminal (opens a browser window to sign in), " +
        "or import cookies with `npx x-for-agents import-cookies <file>`, or set X_AUTH_TOKEN and X_CT0.",
    );
  }
}

/** GraphQL operations that carry the feed for each source. */
const OPS: Record<Source, string[] | null> = {
  home: ["HomeTimeline"],
  following: ["HomeLatestTimeline"],
  user: ["UserTweets", "UserTweetsAndReplies"],
  user_media: ["UserMedia"],
  search: ["SearchTimeline"],
  bookmarks: ["Bookmarks", "BookmarkSearchTimeline"],
  likes: ["Likes"],
  list: ["ListLatestTweetsTimeline"],
  post: ["TweetDetail", "TweetResultByRestId"],
  url: null,
};

const cleanHandle = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "").split(/[/?#]/)[0];

export function postIdFrom(input: string): string {
  const m = input.match(/status(?:es)?\/(\d+)/) ?? input.match(/^(\d{5,})$/);
  if (!m) throw new Error(`Can't find a post id in "${input}"`);
  return m[1];
}

export function sourceUrl(o: Pick<CollectOptions, "source" | "target" | "searchMode">): string {
  const need = (what: string) => {
    if (!o.target?.trim()) throw new Error(`source "${o.source}" needs target (${what})`);
    return o.target.trim();
  };
  switch (o.source) {
    case "home":
    case "following":
      return "https://x.com/home";
    case "user":
      return `https://x.com/${cleanHandle(need("a handle"))}`;
    case "user_media":
      return `https://x.com/${cleanHandle(need("a handle"))}/media`;
    case "likes":
      return `https://x.com/${cleanHandle(need("your handle"))}/likes`;
    case "search": {
      const f = o.searchMode === "top" ? "" : o.searchMode === "media" ? "&f=media" : "&f=live";
      return `https://x.com/search?q=${encodeURIComponent(need("a search query"))}&src=typed_query${f}`;
    }
    case "bookmarks":
      return "https://x.com/i/bookmarks";
    case "list": {
      const t = need("a list id or URL");
      const id = t.match(/lists\/(\d+)/)?.[1] ?? t;
      return `https://x.com/i/lists/${id}`;
    }
    case "post":
      return `https://x.com/i/status/${postIdFrom(need("a post URL or id"))}`;
    case "url": {
      const t = need("an x.com URL");
      if (!/^https:\/\/(www\.)?(x|twitter)\.com\//.test(t)) throw new Error("target must be an https://x.com/ URL");
      return t.replace("twitter.com", "x.com");
    }
  }
}

function operationName(url: string): string | undefined {
  return url.match(/\/i\/api\/graphql\/[^/]+\/([A-Za-z]+)/)?.[1];
}

function passes(p: Post, o: CollectOptions): boolean {
  if (p.context === "quoted" && !o.includeQuoted) return false;
  if (p.context === "retweeted" && !o.includeRetweets) return false;
  const media = o.mediaTypes ? p.media.filter((m) => o.mediaTypes!.includes(m.type)) : p.media;
  if (o.mediaOnly && media.length === 0) return false;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.floor(Math.random() * base * 0.8);

export async function collect(page: Page, o: CollectOptions): Promise<CollectResult> {
  const url = sourceUrl(o);
  const ops = OPS[o.source];
  const primary = new Map<string, Post>(); // from the feed's own operation
  const secondary = new Map<string, Post>(); // anything else (fallback if X renames ops)
  const pending = new Set<Promise<void>>();
  let apiResponses = 0;
  let rateLimited = false;
  const sinceMs = o.since ? Date.parse(o.since) : NaN;

  const onResponse = (resp: Response) => {
    const rurl = resp.url();
    if (!rurl.includes("/i/api/graphql/")) return;
    if (resp.status() === 429) {
      rateLimited = true;
      return;
    }
    if (!resp.ok()) return;
    const op = operationName(rurl);
    const task = (async () => {
      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        return;
      }
      apiResponses++;
      const target = !ops || (op && ops.includes(op)) ? primary : secondary;
      for (const p of extractPosts(json)) if (!target.has(p.id)) target.set(p.id, p);
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const matching = () => {
    const pool = primary.size || !secondary.size ? primary : secondary;
    return [...pool.values()].filter((p) => passes(p, o));
  };

  const cookies = await page.context().cookies("https://x.com");
  if (!cookies.some((c) => c.name === "auth_token" && c.value)) throw new NotLoggedInError();

  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(1500);
    if (/\/(login|i\/flow\/login|i\/flow\/signup)/.test(page.url())) throw new NotLoggedInError();

    if (o.source === "following") {
      const tab = page.getByRole("tab", { name: /^Following$/ });
      await tab.first().click({ timeout: 15_000 }).catch(() => undefined);
    }

    // Wait for the first batch of posts (or give up after ~20s).
    for (let i = 0; i < 40 && primary.size + secondary.size === 0 && !rateLimited; i++) await sleep(500);
    if (primary.size + secondary.size === 0) {
      const loginWall = await page.locator('[data-testid="loginButton"], input[autocomplete="username"]').count();
      if (loginWall) throw new NotLoggedInError();
    }

    if (o.source === "post") {
      await Promise.allSettled([...pending]);
      const id = postIdFrom(o.target!);
      const all = [...primary.values(), ...secondary.values()];
      const main = all.find((p) => p.id === id);
      const quoted = main?.quoted_post_id ? all.find((p) => p.id === main.quoted_post_id) : undefined;
      return {
        url,
        posts: [main, quoted].filter((p): p is Post => !!p),
        scrolls: 0,
        apiResponses,
        stopReason: "single_post",
      };
    }

    let scrolls = 0;
    let stalls = 0;
    let lastCount = matching().length;
    let stopReason: CollectResult["stopReason"] = "max_scrolls";

    while (scrolls < o.maxScrolls) {
      if (lastCount >= o.maxPosts) {
        stopReason = "max_posts";
        break;
      }
      if (rateLimited) {
        stopReason = "rate_limited";
        break;
      }
      if (!Number.isNaN(sinceMs)) {
        const posts = matching();
        const oldest = posts.filter((p) => p.context === "timeline" && p.created_at).at(-1);
        if (oldest && Date.parse(oldest.created_at!) < sinceMs) {
          stopReason = "reached_since";
          break;
        }
      }

      await page.mouse.wheel(0, 1800 + Math.floor(Math.random() * 1400));
      scrolls++;
      await sleep(jitter(config.scrollDelayMs));

      // X sometimes shows "Something went wrong. Try reloading." with a Retry button.
      const retry = page.getByRole("button", { name: /^Retry$/ });
      if (await retry.count()) await retry.first().click().catch(() => undefined);

      const count = matching().length;
      if (count === lastCount) {
        stalls++;
        // Nudge: jump to the very bottom to trigger the next page.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
        if (stalls >= 6) {
          stopReason = "end_of_feed";
          break;
        }
      } else {
        stalls = 0;
      }
      lastCount = count;
    }

    await Promise.race([Promise.allSettled([...pending]), sleep(3000)]);
    let posts = matching();
    if (!Number.isNaN(sinceMs)) posts = posts.filter((p) => !p.created_at || Date.parse(p.created_at) >= sinceMs || p.context !== "timeline");
    return { url, posts: posts.slice(0, o.maxPosts), scrolls, apiResponses, stopReason };
  } finally {
    page.off("response", onResponse);
  }
}
