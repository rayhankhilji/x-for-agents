/**
 * Turns X's internal GraphQL JSON (HomeTimeline, UserTweets, UserMedia,
 * SearchTimeline, TweetDetail, Bookmarks, Likes, ListLatestTweetsTimeline, ...)
 * into flat Post objects with direct, highest-quality media URLs.
 *
 * The walker is deliberately schema-agnostic: it looks for tweet-shaped
 * objects anywhere in the payload, so it survives X reshuffling timeline
 * instruction formats.
 */

export type MediaType = "photo" | "video" | "gif";

export interface Media {
  key: string;
  /** Position in the post (stable even when filters drop siblings). */
  index: number;
  type: MediaType;
  /** Best direct URL: original-size image, or highest-bitrate MP4. */
  url: string;
  /** HLS playlist, used as a fallback when no MP4 variant exists. */
  hls_url?: string;
  /** Small preview image (~680px) for every media type. */
  thumbnail?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  bitrate?: number;
  alt_text?: string;
}

export interface Post {
  id: string;
  url: string;
  author: { handle: string; name?: string; id?: string };
  created_at?: string;
  text: string;
  lang?: string;
  media: Media[];
  metrics?: {
    likes?: number;
    reposts?: number;
    replies?: number;
    quotes?: number;
    bookmarks?: number;
    views?: number;
  };
  /** How this post appeared in the feed. */
  context: "timeline" | "quoted" | "retweeted";
  retweeted_by?: string;
  /** Pinned to the top of a profile (out of date order). */
  pinned?: boolean;
  quoted_post_id?: string;
  reply_to?: string;
  sensitive?: boolean;
}

type Json = any;

function unwrapTweet(t: Json): Json | null {
  if (!t || typeof t !== "object") return null;
  if (t.__typename === "TweetWithVisibilityResults" && t.tweet) return t.tweet;
  if (t.__typename === "TweetTombstone" || t.__typename === "TweetUnavailable") return null;
  return t;
}

function isTweet(o: Json): boolean {
  if (!o || typeof o !== "object" || typeof o.rest_id !== "string") return false;
  if (o.__typename && o.__typename !== "Tweet") return false;
  const L = o.legacy;
  // User objects also have rest_id + legacy.entities; only tweets have full_text and no screen_name.
  return !!L && typeof L === "object" && typeof L.full_text === "string" && !("screen_name" in L);
}

function isoDate(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function bestImageUrl(mediaUrl: string): string {
  // https://pbs.twimg.com/media/ABC.jpg -> https://pbs.twimg.com/media/ABC?format=jpg&name=orig
  const m = mediaUrl.match(/^(https:\/\/pbs\.twimg\.com\/media\/[^.?]+)\.(\w+)/);
  if (m) return `${m[1]}?format=${m[2]}&name=orig`;
  return mediaUrl;
}

function smallUrl(mediaUrl: string): string {
  const m = mediaUrl.match(/^(https:\/\/pbs\.twimg\.com\/[^?]+?)\.(jpg|jpeg|png|webp)(\?.*)?$/);
  return m ? `${m[1]}?format=${m[2] === "png" ? "png" : "jpg"}&name=small` : mediaUrl;
}

export function parseMedia(m: Json, index = 0): Media | null {
  if (!m || !m.media_url_https) return null;
  const key = String(m.media_key ?? m.id_str ?? m.media_url_https);
  const base = {
    key,
    index,
    thumbnail: smallUrl(m.media_url_https),
    width: m.original_info?.width,
    height: m.original_info?.height,
    alt_text: m.ext_alt_text || undefined,
  };
  if (m.type === "photo") {
    return { ...base, type: "photo", url: bestImageUrl(m.media_url_https) };
  }
  if (m.type === "video" || m.type === "animated_gif") {
    const variants: Json[] = m.video_info?.variants ?? [];
    const mp4s = variants
      .filter((v) => v.content_type === "video/mp4" && v.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const hls = variants.find((v) => (v.content_type ?? "").includes("mpegURL"))?.url;
    const best = mp4s[0];
    if (!best && !hls) return null;
    return {
      ...base,
      type: m.type === "video" ? "video" : "gif",
      url: best?.url ?? hls,
      hls_url: hls,
      bitrate: best?.bitrate,
      duration_ms: m.video_info?.duration_millis,
    };
  }
  return null;
}

function cleanText(text: string, mediaUrls: string[]): string {
  let out = text;
  for (const u of mediaUrls) out = out.split(u).join("");
  return out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function parseTweet(raw: Json, context: Post["context"] = "timeline"): Post | null {
  const t = unwrapTweet(raw);
  if (!t || !isTweet(t)) return null;
  const L = t.legacy;
  const user = unwrapUser(t.core?.user_results?.result);
  const handle: string = user?.core?.screen_name ?? user?.legacy?.screen_name ?? "unknown";
  const name: string | undefined = user?.core?.name ?? user?.legacy?.name;

  const rawMedia: Json[] = L.extended_entities?.media ?? L.entities?.media ?? [];
  const media = rawMedia.map((m, i) => parseMedia(m, i)).filter((x): x is Media => !!x);
  const mediaTco = rawMedia.map((m) => m.url).filter(Boolean);

  const fullText: string = t.note_tweet?.note_tweet_results?.result?.text ?? L.full_text ?? "";
  const views = t.views?.count != null ? Number(t.views.count) : undefined;

  return {
    id: t.rest_id,
    url: `https://x.com/${handle}/status/${t.rest_id}`,
    author: { handle, name, id: user?.rest_id },
    created_at: isoDate(L.created_at),
    text: cleanText(fullText, mediaTco),
    lang: L.lang,
    media,
    metrics: {
      likes: L.favorite_count,
      reposts: L.retweet_count,
      replies: L.reply_count,
      quotes: L.quote_count,
      bookmarks: L.bookmark_count,
      views: Number.isFinite(views) ? views : undefined,
    },
    context,
    quoted_post_id: L.quoted_status_id_str,
    reply_to: L.in_reply_to_status_id_str ?? undefined,
    sensitive: L.possibly_sensitive || undefined,
  };
}

function unwrapUser(u: Json): Json {
  return u?.__typename === "UserUnavailable" ? null : u;
}

/**
 * Walk any GraphQL payload and return every post found, in document order.
 * - Promoted (ad) entries are skipped.
 * - Retweet wrappers are replaced by the original post (context "retweeted").
 * - Quoted posts are emitted after their parent (context "quoted").
 */
export function extractPosts(payload: Json): Post[] {
  const out: Post[] = [];
  let pinned = false;
  const visit = (node: Json, context: Post["context"], retweetedBy?: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, context, retweetedBy);
      return;
    }
    if (node.type === "TimelinePinEntry") {
      pinned = true;
      for (const k of Object.keys(node)) visit(node[k], context, retweetedBy);
      pinned = false;
      return;
    }
    // Skip ads.
    if (node.promotedMetadata || node.itemContent?.promotedMetadata) return;
    if (typeof node.entryId === "string" && node.entryId.startsWith("promoted-")) return;

    const t = unwrapTweet(node);
    if (t && isTweet(t)) {
      const rt = t.legacy?.retweeted_status_result?.result;
      if (rt) {
        const user = unwrapUser(t.core?.user_results?.result);
        const by = user?.core?.screen_name ?? user?.legacy?.screen_name;
        visit(rt, "retweeted", by);
        return;
      }
      const post = parseTweet(t, context);
      if (post) {
        if (retweetedBy) post.retweeted_by = retweetedBy;
        if (pinned && context === "timeline") post.pinned = true;
        out.push(post);
      }
      const quoted = t.quoted_status_result?.result;
      if (quoted) visit(quoted, "quoted");
      return;
    }
    for (const k of Object.keys(node)) visit(node[k], context, retweetedBy);
  };
  visit(payload, "timeline");
  return out;
}
