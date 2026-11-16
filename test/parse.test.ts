import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractPosts } from "../src/parse.ts";
import { parseCookies } from "../src/browser.ts";
import { applyFilters, postIdFrom, sourceUrl } from "../src/collect.ts";
import { kfmt, rows } from "../src/format.ts";
import { mediaPath } from "../src/download.ts";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/home_timeline.json", import.meta.url), "utf8"));
const posts = extractPosts(fixture);
const byId = Object.fromEntries(posts.map((p) => [p.id, p]));

test("finds posts, skips ads, tombstones and retweet wrappers", () => {
  assert.deepEqual(posts.map((p) => p.id), ["1001", "1002", "900", "1004", "800"]);
});

test("photos get original-size URLs, alt text, and clean text", () => {
  const p = byId["1001"];
  assert.equal(p.author.handle, "photog");
  assert.equal(p.text, "Sunset & sea");
  assert.equal(p.url, "https://x.com/photog/status/1001");
  assert.equal(p.metrics?.views, 12345);
  assert.equal(p.media.length, 2);
  assert.equal(p.media[0].url, "https://pbs.twimg.com/media/AAA111?format=jpg&name=orig");
  assert.equal(p.media[0].alt_text, "a sunset");
  assert.equal(p.media[1].url, "https://pbs.twimg.com/media/BBB222?format=png&name=orig");
  assert.equal(p.created_at, "2026-11-10T14:00:00.000Z");
});

test("videos pick the highest-bitrate mp4 and keep HLS as fallback", () => {
  const v = byId["1002"].media[0];
  assert.equal(byId["1002"].author.handle, "vidguy"); // legacy user schema
  assert.equal(v.type, "video");
  assert.equal(v.url, "https://video.twimg.com/ext_tw_video/9/pu/vid/1280x720/high.mp4");
  assert.equal(v.hls_url, "https://video.twimg.com/ext_tw_video/9/pu/pl/x.m3u8");
  assert.equal(v.duration_ms, 30500);
});

test("retweets resolve to the original post, GIFs typed as gif", () => {
  const p = byId["900"];
  assert.equal(p.context, "retweeted");
  assert.equal(p.retweeted_by, "retweeter");
  assert.equal(p.media[0].type, "gif");
  assert.equal(p.media[0].url, "https://video.twimg.com/tweet_video/G.mp4");
});

test("long-form note text and quoted posts", () => {
  assert.match(byId["1004"].text, /exceeds 280/);
  assert.equal(byId["1004"].quoted_post_id, "800");
  assert.equal(byId["800"].context, "quoted");
});

test("cookie parsing: header string, JSON export, cookies.txt", () => {
  const h = parseCookies("auth_token=abc; ct0=def");
  assert.deepEqual(h.map((c) => [c.name, c.value, c.domain]), [["auth_token", "abc", ".x.com"], ["ct0", "def", ".x.com"]]);
  const j = parseCookies(JSON.stringify([
    { name: "auth_token", value: "a", domain: ".x.com", httpOnly: true, sameSite: "no_restriction", expirationDate: 1900000000.5 },
    { name: "other", value: "z", domain: ".google.com" },
  ]));
  assert.equal(j.length, 1);
  assert.equal(j[0].expires, 1900000000);
  const t = parseCookies("# Netscape\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1900000000\tauth_token\tq\n.twitter.com\tTRUE\t/\tTRUE\t0\tct0\tw\n");
  assert.deepEqual(t.map((c) => [c.name, c.httpOnly]), [["auth_token", true], ["ct0", false]]);
});

test("source URLs and post ids", () => {
  assert.equal(sourceUrl({ source: "user_media", target: "@NASA" }), "https://x.com/NASA/media");
  assert.equal(sourceUrl({ source: "user", target: "https://x.com/nasa/status/1" }), "https://x.com/nasa");
  assert.equal(sourceUrl({ source: "search", target: "cats filter:videos", searchMode: "media" }), "https://x.com/search?q=cats%20filter%3Avideos&src=typed_query&f=media");
  assert.equal(sourceUrl({ source: "list", target: "https://x.com/i/lists/42" }), "https://x.com/i/lists/42");
  assert.equal(postIdFrom("https://twitter.com/a/status/1234567890?s=20"), "1234567890");
  assert.throws(() => sourceUrl({ source: "user" }));
});

test("media paths are deterministic per post/index", () => {
  assert.match(mediaPath(byId["1001"], byId["1001"].media[1], "/d"), /\/d\/photog\/1001_2\.png$/);
  assert.match(mediaPath(byId["1002"], byId["1002"].media[0], "/d"), /\/d\/vidguy\/1002_1\.mp4$/);
});

test("filters keep stable media indexes", () => {
  const f = { mediaOnly: true, includeQuoted: false, includeRetweets: true };
  const only2nd = applyFilters(byId["1001"], { ...f, minSize: 1000 })!;
  assert.equal(only2nd.media.length, 1);
  assert.equal(only2nd.media[0].index, 0);
  assert.equal(applyFilters(byId["1001"], { ...f, mediaTypes: ["video"] }), null);
  assert.equal(applyFilters(byId["800"], f), null, "quoted excluded by default");
  assert.ok(applyFilters(byId["1001"], { ...f, match: "sunset,moon" }));
  assert.equal(applyFilters(byId["1001"], { ...f, match: "/^moon/" }), null);
  assert.ok(applyFilters(byId["1001"], { ...f, match: "/A SUNSET/" }), "regex is case-insensitive and checks alt text");
  assert.equal(applyFilters(byId["1002"], { ...f, maxDurationS: 10 }), null);
});

test("compact rows are terse", () => {
  const out = rows(posts, { textChars: 20, limit: 3 });
  const lines = out.split("\n");
  assert.equal(lines[1], "1|1001|photog|26-11-10|10|12.3k|2p|Sunset & sea");
  assert.match(lines.at(-1)!, /\+2 more/);
  assert.equal(kfmt(1_250_000), "1.3M");
});
