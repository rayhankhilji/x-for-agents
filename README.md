# x-for-agents

An MCP server that lets **Claude Code** browse X with **your own logged-in account**: it scrolls feeds, profiles, searches, bookmarks and lists, and pulls out the **images and videos** (full-resolution JPG/PNG, highest-bitrate MP4) plus post metadata.

```
Claude Code ──MCP(stdio)──▶ x-for-agents ──Playwright──▶ Chromium (your X session)
                                  │                          │ scrolls the page
                                  │◀── X's own GraphQL JSON ─┘ (HomeTimeline, UserMedia, SearchTimeline…)
                                  ├─▶ parse posts + media URLs
                                  └─▶ download to ~/x-for-agents-data/media/<handle>/<postId>_<n>.<ext>
```

It does **not** scrape the rendered HTML. While the real web app scrolls, it captures the JSON that x.com loads for itself. That JSON carries the original-size image URLs and every video bitrate variant, so the server always picks the best file. No X API key or paid tier is needed.

## Setup

Requires Node 20+.

```bash
git clone https://github.com/rayhankhilji/x-for-agents && cd x-for-agents
npm install          # also downloads Playwright's Chromium
npm run build
npx x-for-agents login
```

`login` opens a normal browser window. Sign in to X there (2FA works), and the window closes once you're in. Your session is saved in `~/.x-for-agents/profile` and reused headlessly after that.

**Add it to Claude Code:**

```bash
claude mcp add x -- node /absolute/path/to/x-for-agents/dist/index.js
```

Or copy `.mcp.json.example` to `.mcp.json` in any project.

### Alternative login: cookies (for servers or remote machines with no screen)

Export your x.com cookies with a browser extension like Cookie-Editor (JSON) or as `cookies.txt`, then run:

```bash
npx x-for-agents import-cookies ~/Downloads/x-cookies.json
```

Or pass just the two cookies that matter as env vars: `X_AUTH_TOKEN=… X_CT0=…`.

## Tools Claude gets

| Tool | What it does |
|---|---|
| `x_status` | Which account is signed in |
| `x_collect` | Scroll a feed and collect media posts, downloading by default |
| `x_get_post` | One post by URL or id, with its media (and the post it quotes) |
| `x_download` | Download media for post ids/URLs, e.g. after `x_collect` with `download: false` |

`x_collect` sources:

| source | target | notes |
|---|---|---|
| `home` | – | For You |
| `following` | – | Following tab, chronological |
| `user` | handle | Profile posts |
| `user_media` | handle | Profile's **Media** tab: best for "grab everything @x posted" |
| `search` | query | Supports X operators: `from:nasa filter:videos since:2026-01-01`. `search_mode`: latest / top / media |
| `bookmarks` | – | Your bookmarks |
| `likes` | your handle | Your likes (X only shows your own) |
| `list` | list id / URL | |
| `url` | any x.com URL | Anything else |

Useful options: `max_posts` (default 40), `max_scrolls` (60), `media_only` (true), `media_types` (`["video"]`), `since` (ISO date), `output_dir`, `include_retweets`, `include_quoted`, `text_chars`.

### Example prompts

- "Grab every video @spacex posted this month."
- "Scroll my bookmarks and download all the images."
- "Search X for `#midjourney filter:images` and save the top 100 pictures to ./refs."
- "Download the media from https://x.com/someone/status/123…"

Downloaded images are ordinary files, so Claude Code can open them with its Read tool if you want it to look at them.

## Output

```
~/x-for-agents-data/
  media/<handle>/<postId>_<n>.jpg|png|mp4   # re-runs skip files that already exist
  collections/<timestamp>_<source>.json     # full result of each run
  posts.jsonl                               # index of every post seen (used by x_download)
```

## Config (env vars)

| var | default | |
|---|---|---|
| `X_DATA_DIR` | `~/x-for-agents-data` | Downloads and indexes |
| `X_HOME` | `~/.x-for-agents` | Browser profile (your login) |
| `X_HEADLESS` | `true` | `false` to watch it scroll |
| `X_BROWSER_CHANNEL` | – | `chrome` to use your installed Chrome |
| `X_BROWSER_PATH` | – | Explicit browser binary |
| `X_SCROLL_DELAY_MS` | `1200` | Base delay between scrolls (random jitter is added) |
| `X_DOWNLOAD_CONCURRENCY` | `4` | |
| `X_IDLE_CLOSE_MS` | `300000` | Close the browser after this long with no tool calls |

You can also run collections from the terminal without Claude, for example:

```bash
npx x-for-agents collect user_media nasa --max 50 --types video
```

## Notes and limits

- **Videos:** most X videos have direct MP4s. HLS-only videos need `ffmpeg` on your PATH.
- **One process per profile:** Chromium locks the profile, so don't run `login`/`status` while Claude Code has the server running (or point them at a different `X_HOME`).
- **Rate limits:** X limits how much an account can read. If you hit a 429, `x_collect` stops and reports `rate_limited`. Wait about 15 minutes. Keep `max_scrolls` reasonable and don't loop it.
- **Terms of service:** automating a logged-in account is against X's ToS and can get the account restricted. This tool scrolls at human-ish speed and only reads, but use a secondary account if that matters to you, and respect creators' rights to their media.
- If X changes its internal API, the parser (`src/parse.ts`) is schema-agnostic and usually keeps working. If it breaks, that's the file to fix (tests: `npm test`).
