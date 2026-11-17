# x-for-agents

Let Claude browse **X with your own account**, scroll **up to 10 feeds at once**, and pull **images, videos and posts**. It's fast, uses few tokens, and works in local Claude Code, cloud/web Claude Code, and Claude chat.

```
Claude ──MCP──▶ x-for-agents ──▶ 1 headless Chromium, 1 X login, up to 10 tabs
                    │                 each tab scrolls a feed; images/video/fonts are NOT loaded
                    │◀── X's own GraphQL JSON (UserMedia, SearchTimeline, HomeTimeline…)
                    ├─▶ filter server-side (keywords/regex, likes, views, size, duration, date)
                    ├─▶ download while still scrolling → ./x-media/<handle>/<postId>_<n>.jpg|mp4
                    └─▶ back to Claude: one header line + numbered rows (+ optional contact sheet)
```

**Not computer use.** Claude never looks at screenshots of X. The server reads the same JSON the X web app loads, which includes original-size image URLs and every video bitrate. So it's fast and exact, and Claude only spends tokens on what it actually needs to see.

## Why it's fast and cheap

| | |
|---|---|
| **Parallel** | `x_batch` runs up to 50 jobs over 10 tabs (`X_TABS`) on one login. Separate `x_collect` calls also run concurrently. |
| **Fast scrolling** | No human-pace delays. Each scroll waits only until X returns the next page, and images, video and fonts are never rendered. |
| **Overlapped downloads** | Media starts downloading the moment a post appears (8 in parallel); originals for images, highest-bitrate MP4s for video. |
| **Token-lean output** | Default output is a header plus pipe-separated rows. A 10-feed / 600-post / 720-file batch returns about 250 tokens. Use `detail: "summary"` for even less, or `"full"` for JSON. |
| **Cheap vision** | `x_preview` (or `preview: true`) returns one contact-sheet JPEG with up to 60 numbered thumbnails, about 700–1,500 tokens instead of 60 images. Claude can judge content, then `x_download` the rows it wants. |
| **Rate-limit aware** | Reads X's `x-rate-limit-*` headers. It stops cleanly (or waits, with `rate_limit_wait_s`) and reports what's left. |

## Install: local Claude Code

```bash
git clone https://github.com/rayhankhilji/x-for-agents && cd x-for-agents
npm install && npm run build
npx x-for-agents login          # a browser window opens; sign in to X once
claude mcp add x -- node "$PWD/dist/index.js"
```

Media goes to `./x-media` inside whatever project Claude Code is working in when `X_OUTPUT_DIR=x-media` is set. Otherwise it goes to `~/x-for-agents-data/media`. Any `output_dir` argument that's a relative path also lands inside the current repo.

Once published to npm, any project can just use `.mcp.json.example`:

```json
{ "mcpServers": { "x": { "command": "npx", "args": ["-y", "x-for-agents@latest"], "env": { "X_OUTPUT_DIR": "x-media" } } } }
```

## Cloud / web Claude Code (claude.ai/code)

There's no screen to log in on, so give it your X cookies through the environment instead.

1. In a browser where you're logged in to X, open DevTools, then Application, then Cookies, then `https://x.com`. Copy `auth_token` and `ct0`.
2. Open the cloud environment's settings (the environment menu in the session's title bar, then **Edit**). Add the environment variables `X_AUTH_TOKEN` and `X_CT0`. Don't paste them into chat.
3. Network access: if the environment uses a limited allowlist, add `x.com`, `twimg.com`, `pbs.twimg.com`, `video.twimg.com` and `abs.twimg.com`.
4. Commit a `.mcp.json` to the repo:
   - **This repo** already has one. It runs `scripts/launch.mjs`, which installs dependencies and builds on first start.
   - **Other repos** use the `npx` config above.

Chromium is found automatically: Playwright's own, `/opt/pw-browsers` on cloud images, or system Chrome. If none is found, it's installed on first use. Check everything with `npx x-for-agents doctor`.

## Claude chat (claude.ai / Claude Desktop): native gallery

Run it as a remote MCP server and add it as a **custom connector**. A token is required for anything that isn't on the same machine:

```bash
X_MCP_TOKEN=$(openssl rand -hex 16) npx x-for-agents serve --http --port 8787
# expose it, e.g.: cloudflared tunnel --url http://localhost:8787
# connector URL: https://<your-tunnel>/mcp/<X_MCP_TOKEN>
```

`x_collect`, `x_batch` and `x_preview` ship an **MCP App** (`ui://x-for-agents/gallery.html`). In hosts that support MCP Apps, results render as an interactive gallery: filter by photos, videos or GIFs, play videos inline, open posts, download single items, and select items and send them back to Claude. Gallery data is only sent to clients that support the UI, so Claude Code doesn't pay tokens for it.

## Tools

| Tool | Purpose |
|---|---|
| `x_collect` | One feed: scroll, filter, download. Returns `run <id>` and numbered rows. |
| `x_batch` | Many feeds in parallel (up to 50 jobs, `X_TABS` tabs). One line per job, plus a combined `batch run` you can preview or download from. |
| `x_preview` | Contact sheet of a run's media (labels = row numbers, `3b` = 2nd media of row 3). |
| `x_download` | Download rows of a run (`"2,5b,9-12"`, where a letter means one media item of that post) or post IDs/URLs, optionally into the repo. |
| `x_status` | Login, account, tabs, rate limits, ffmpeg, output dir. |

Sources: `home`, `following`, `user`, `user_media` (best for everything someone posted), `search` (X operators work: `from:nasa filter:videos since:2026-01-01`; `search_mode` latest/top/media), `bookmarks`, `likes`, `list`, `post`, `url`.

Filters: `media_types`, `match` (`"cat,dog"` or `"/regex/"` on text and alt text), `min_likes`, `min_views`, `min_size`, `min_duration_s`, `max_duration_s`, `lang`, `since`, `include_retweets`, `include_quoted`, `media_only`.

### Example prompts

- "Pull every video from @nasa, @spacex, @esa, @jaxa_en and @isro this month into ./assets/space."
- "Search `#midjourney filter:images` (top), preview the first 60, keep only the photorealistic ones."
- "Download all my bookmarks' media into the repo."

## ffmpeg

Only needed for the rare video that has no MP4 version (HLS stream only). When that happens, the server looks for `ffmpeg` on your PATH, then in `~/.x-for-agents/tools`, and otherwise installs a static build there automatically (`npx x-for-agents setup-ffmpeg` does it up front). If that isn't possible (offline, no network), those videos are reported as failed and everything else carries on.

## Output

```
<output_dir>/<handle>/<postId>_<n>.jpg|png|mp4   # deterministic names; re-runs skip existing files
~/x-for-agents-data/runs/<runId>_<label>.json   # every run (posts, media URLs, local files)
~/x-for-agents-data/posts.jsonl                  # index of all posts seen
```

## Config

| env | default | |
|---|---|---|
| `X_TABS` | `10` | Parallel tabs (max 20) |
| `X_OUTPUT_DIR` | `~/x-for-agents-data/media` | Relative = inside the project |
| `X_AUTH_TOKEN`, `X_CT0`, `X_COOKIES`, `X_COOKIES_FILE` | | Cookie login (cloud, CI) |
| `X_HEADLESS` | `true` | `false` to watch the tabs |
| `X_BLOCK_MEDIA` | `true` | Don't render media while scrolling |
| `X_SCROLL_DELAY_MS` / `X_RESPONSE_WAIT_MS` | `150` / `2500` | Scroll pacing |
| `X_DOWNLOAD_CONCURRENCY` | `8` | |
| `X_DOWNLOAD_TIMEOUT_MS` | `600000` | Hard cap per file, so a stalled stream can't hang a run |
| `X_BROWSER_PATH`, `X_BROWSER_CHANNEL` | auto | Use a specific Chrome |
| `X_MCP_TOKEN` | | Token for `serve --http`. Without it, only requests from the same machine are accepted. |
| `X_UI` | auto | `always` / `never` send gallery data |

## Limits and terms

- **X's read limits are the real ceiling, not tabs.** All tabs share one account's rate limits (per endpoint, per 15 minutes). Ten tabs reach that limit sooner. The server reports the remaining budget and stops cleanly.
- **Terms of service.** Automated access to a logged-in account is against X's ToS and can get the account restricted. Use an account you can afford to lose for heavy runs, and respect creators' rights to their media.
- **One process per profile.** Don't run `login` while Claude Code has the server open; use another `X_HOME` if needed.

## Development

```bash
npm test     # unit tests, e2e against a mock x.com (10 parallel tabs, queueing, downloads, previews),
             # and robustness tests that try to crash the real server (malformed HTTP, DNS rebinding, bad paths)
```
