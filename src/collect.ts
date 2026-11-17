import type { Page, Response } from "playwright";
import { LOGIN_URL_RE } from "./browser.js";
import { config } from "./config.js";
import { extractPosts, type Media, type MediaType, type Post } from "./parse.js";

export const SOURCES = ["home", "following", "user", "user_media", "search", "bookmarks", "likes", "list", "post", "url"] as const;
export type Source = (typeof SOURCES)[number];

export interface Filters {
  mediaOnly: boolean;
  mediaTypes?: MediaType[];
  includeQuoted: boolean;
  includeRetweets: boolean;
  /** Case-insensitive keywords (comma-separated, any match) or /regex/flags, tested on text + alt text. */
  match?: string;
  minLikes?: number;
  minViews?: number;
  /** Media must be at least this many px on its longest side. */
  minSize?: number;
  minDurationS?: number;
  maxDurationS?: number;
  lang?: string;
  /** Drop posts older than this ISO date. */
  since?: string;
}

export interface CollectOptions extends Filters {
  source: Source;
  target?: string;
  searchMode?: "top" | "latest" | "media";
  maxPosts: number;
  maxScrolls: number;
  /** Wait for a rate-limit window to reset (up to this many seconds) instead of stopping. */
  rateLimitWaitS?: number;
  /** Called for each accepted post as soon as it's seen (lets downloads overlap with scrolling). */
  onPost?: (p: Post) => void;
}

export type StopReason = "max_posts" | "max_scrolls" | "end_of_feed" | "rate_limited" | "reached_since" | "single_post";

export interface CollectResult {
  url: string;
  posts: Post[];
  /** The same posts before media filters (what gets indexed, so later downloads can fetch everything). */
  unfiltered?: Post[];
  scrolls: number;
  apiResponses: number;
  stopReason: StopReason;
  elapsedMs: number;
  rateLimit?: RateLimit & { op: string };
}

export class NotLoggedInError extends Error {
  constructor() {
    super(
      "Not logged in to X. Locally: run `npx x-for-agents login`. Cloud/web Claude Code: set X_AUTH_TOKEN and X_CT0 " +
        "(cookies from your browser) in the environment, or `npx x-for-agents import-cookies <file>`.",
    );
  }
}

// ---------------------------------------------------------------- rate limits (shared by all tabs: same account)

export interface RateLimit {
  limit: number;
  remaining: number;
  /** epoch seconds */
  reset: number;
}
export const rateLimits = new Map<string, RateLimit>();

function trackRateLimit(op: string | undefined, resp: Response) {
  if (!op) return;
  const h = resp.headers();
  const remaining = Number(h["x-rate-limit-remaining"]);
  const limit = Number(h["x-rate-limit-limit"]);
  const reset = Number(h["x-rate-limit-reset"]);
  if (Number.isFinite(remaining) && Number.isFinite(reset)) rateLimits.set(op, { limit, remaining, reset });
}

// ---------------------------------------------------------------- URLs

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

const cleanHandle = (h: string) =>
  h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "").split(/[/?#]/)[0];

export function postIdFrom(input: string): string {
  const m = input.match(/status(?:es)?\/(\d+)/) ?? input.trim().match(/^(\d{5,})$/);
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
      return `https://x.com/i/lists/${t.match(/lists\/(\d+)/)?.[1] ?? t}`;
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

const operationName = (url: string) => url.match(/\/i\/api\/graphql\/[^/]+\/([A-Za-z]+)/)?.[1];

// ---------------------------------------------------------------- filters

function matcher(spec?: string): ((s: string) => boolean) | undefined {
  if (!spec?.trim()) return undefined;
  const re = spec.match(/^\/(.+)\/([a-z]*)$/);
  if (re) {
    // Drop g/y: a stateful regex would skip every other post.
    const flags = [...new Set((re[2] + "i").replace(/[gy]/g, ""))].join("");
    let r: RegExp;
    try {
      r = new RegExp(re[1], flags);
    } catch (e) {
      throw new Error(`invalid match regex ${spec}: ${(e as Error).message}`);
    }
    return (s) => r.test(s);
  }
  const terms = spec.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  return (s) => {
    const l = s.toLowerCase();
    return terms.some((t) => l.includes(t));
  };
}

/** Returns the post with only the media that pass, or null if the post is filtered out. */
export function applyFilters(p: Post, f: Filters, test = matcher(f.match)): Post | null {
  if (p.context === "quoted" && !f.includeQuoted) return null;
  if (p.context === "retweeted" && !f.includeRetweets) return null;
  if (f.lang && p.lang && p.lang !== f.lang) return null;
  if (f.minLikes && (p.metrics?.likes ?? 0) < f.minLikes) return null;
  if (f.minViews && (p.metrics?.views ?? 0) < f.minViews) return null;
  if (f.since && p.created_at && Date.parse(p.created_at) < Date.parse(f.since)) return null;
  if (test && !test([p.text, ...p.media.map((m) => m.alt_text ?? "")].join("\n"))) return null;
  const media = p.media.filter((m: Media) => {
    if (f.mediaTypes && !f.mediaTypes.includes(m.type)) return false;
    if (f.minSize && Math.max(m.width ?? 0, m.height ?? 0) < f.minSize) return false;
    const dur = (m.duration_ms ?? 0) / 1000;
    if (m.type === "video" && f.minDurationS && dur < f.minDurationS) return false;
    if (m.type === "video" && f.maxDurationS && dur > f.maxDurationS) return false;
    return true;
  });
  if (f.mediaOnly && media.length === 0) return null;
  return media.length === p.media.length ? p : { ...p, media };
}

// ---------------------------------------------------------------- collector

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function collect(page: Page, o: CollectOptions): Promise<CollectResult> {
  const started = Date.now();
  const url = sourceUrl(o);
  const ops = OPS[o.source];
  const test = matcher(o.match);
  const sinceMs = o.since ? Date.parse(o.since) : NaN;
  if (o.since && Number.isNaN(sinceMs)) throw new Error(`since must be an ISO date, got "${o.since}"`);
  // Only feeds in date order can stop early on `since`; elsewhere it just filters.
  const chronological =
    ["following", "user", "user_media", "list"].includes(o.source) || (o.source === "search" && (o.searchMode ?? "latest") === "latest");

  const cookies = await page.context().cookies("https://x.com");
  if (!cookies.some((c) => c.name === "auth_token" && c.value)) throw new NotLoggedInError();

  const accepted: Post[] = []; // feed posts that pass filters, in order
  const seen = new Set<string>();
  const raw = new Map<string, Post>(); // every feed post, unfiltered
  const fallback = new Map<string, Post>(); // posts from other operations (used if X renames ops)
  const pending = new Set<Promise<void>>();
  let apiResponses = 0;
  let feedResponses = 0;
  let rateLimited = false;
  let oldestTimelineMs = Infinity;
  let lastOp: string | undefined;
  let done = false; // once finished, late responses must not change the result

  const accept = (p: Post) => {
    if (done || seen.has(p.id)) return;
    seen.add(p.id);
    if (p.context === "timeline" && !p.pinned && p.created_at) oldestTimelineMs = Math.min(oldestTimelineMs, Date.parse(p.created_at));
    const kept = applyFilters(p, o, test);
    if (!kept || accepted.length >= o.maxPosts) return;
    accepted.push(kept);
    o.onPost?.(kept);
  };

  const onResponse = (resp: Response) => {
    const rurl = resp.url();
    if (!rurl.includes("/i/api/graphql/")) return;
    const op = operationName(rurl);
    const isFeed = !ops || (!!op && ops.includes(op));
    if (isFeed) {
      trackRateLimit(op, resp);
      lastOp = op;
    }
    if (resp.status() === 429) {
      if (isFeed) rateLimited = true;
      return;
    }
    if (!resp.ok()) return;
    const task = (async () => {
      try {
        const json: unknown = await resp.json();
        if (done) return;
        apiResponses++;
        const posts = extractPosts(json);
        if (isFeed) {
          feedResponses++;
          for (const p of posts) if (!raw.has(p.id)) raw.set(p.id, p);
          if (o.source !== "post") posts.forEach(accept);
        } else for (const p of posts) if (!fallback.has(p.id)) fallback.set(p.id, p);
      } catch {
        /* unreadable or unexpected payload: skip it */
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const waitForFeed = async (since: number, timeout: number) => {
    const end = Date.now() + timeout;
    while (feedResponses === since && !rateLimited && Date.now() < end) await sleep(40);
    if (pending.size) await Promise.race([Promise.allSettled([...pending]), sleep(1000)]);
  };

  const finish = (stopReason: StopReason, scrolls: number): CollectResult => {
    if (feedResponses === 0 && fallback.size) {
      // The feed's own operation never answered (X probably renamed it): use what the page loaded.
      for (const p of fallback.values()) {
        raw.set(p.id, p);
        accept(p);
      }
    }
    done = true;
    const posts = [...accepted];
    const rl = lastOp ? rateLimits.get(lastOp) : undefined;
    return {
      url,
      posts,
      unfiltered: posts.map((p) => raw.get(p.id) ?? p),
      scrolls,
      apiResponses,
      stopReason,
      elapsedMs: Date.now() - started,
      rateLimit: rl && lastOp ? { op: lastOp, ...rl } : undefined,
    };
  };

  page.on("response", onResponse);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        break;
      } catch (e) {
        if (attempt >= 3) throw new Error(`couldn't load ${url}: ${(e as Error).message.split("\n")[0]}`);
        await sleep(1000 * attempt);
      }
    }
    if (LOGIN_URL_RE.test(page.url())) throw new NotLoggedInError();

    if (o.source === "following" || o.source === "home") {
      // X remembers the last Home tab per profile, so always pick the one we want.
      const tab = page.getByRole("tab", { name: o.source === "following" ? /^Following$/ : /^For you$/ }).first();
      const selected = await tab.getAttribute("aria-selected", { timeout: 15_000 }).catch(() => null);
      if (selected !== "true") await tab.click({ timeout: 5_000 }).catch(() => undefined);
    }

    await waitForFeed(0, 20_000);
    if (LOGIN_URL_RE.test(page.url())) throw new NotLoggedInError();

    if (o.source === "post") {
      const id = postIdFrom(o.target!);
      const all = [...raw.values(), ...fallback.values()];
      const main = all.find((p) => p.id === id);
      const quoted = main?.quoted_post_id ? all.find((p) => p.id === main.quoted_post_id) : undefined;
      const posts = [main, quoted].filter((p): p is Post => !!p);
      return { ...finish("single_post", 0), posts, unfiltered: posts };
    }

    let scrolls = 0;
    let stalls = 0;
    while (true) {
      if (accepted.length >= o.maxPosts) return finish("max_posts", scrolls);
      if (scrolls >= o.maxScrolls) return finish("max_scrolls", scrolls);
      if (chronological && oldestTimelineMs < sinceMs) return finish("reached_since", scrolls);
      if (rateLimited) {
        const rl = lastOp ? rateLimits.get(lastOp) : undefined;
        const waitS = rl ? rl.reset - Date.now() / 1000 + 2 : Infinity;
        if (!o.rateLimitWaitS || waitS > o.rateLimitWaitS) return finish("rate_limited", scrolls);
        await sleep(waitS * 1000);
        rateLimited = false;
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      }

      const before = feedResponses;
      // Jump to the bottom: X's virtualised timeline fetches the next page as soon as its sentinel is visible.
      await page.mouse.wheel(0, 4000).catch(() => undefined);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => undefined);
      scrolls++;
      await waitForFeed(before, config.responseWaitMs);
      if (config.scrollDelayMs) await sleep(config.scrollDelayMs);

      if (feedResponses === before) {
        stalls++;
        const retry = page.getByRole("button", { name: /^Retry$/ });
        if (await retry.count()) await retry.first().click().catch(() => undefined);
        // Nudge up then down — sometimes the sentinel needs to re-enter the viewport.
        await page.mouse.wheel(0, -1500).catch(() => undefined);
        if (stalls >= 4) return finish("end_of_feed", scrolls);
      } else stalls = 0;
    }
  } finally {
    done = true;
    page.off("response", onResponse);
  }
}
