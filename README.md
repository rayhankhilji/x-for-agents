<p align="center">
  <a href="https://riffler.pages.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="site/assets/brand/logos/signature-reversed.svg">
      <img src="site/assets/brand/logos/signature-ink.svg" alt="Riffler" width="320">
    </picture>
  </a>
</p>

<h1 align="center">Connect your coding agent to X.</h1>

<p align="center"><strong>Full-size media. No screenshots.</strong></p>

Riffler is a free MCP server. Your agent scrolls X with your account, ten tabs at once, and saves the
full-size images and videos straight into your project.

Your agent never looks at a screenshot of X. It reads the data X's own web app loads and gets back one
line per run. When it needs to see, it gets one contact sheet of up to 60 numbered thumbnails.

```bash
npx -y riffler login
```

(Not on npm yet? Use `npx -y github:rayhankhilji/x-for-agents login`; every command below works the same way.)

That opens a browser window. Sign in to X once and it closes. Then add Riffler to your client
(below) and ask, for example: *"Pull every video @nasa posted this month into ./assets/space."*

- **Ten tabs, one login.** `x_batch` runs up to 50 feeds across 10 tabs (`X_TABS`, max 20).
- **Data, not pixels.** No screenshots of X are read; images, video and fonts are never even rendered.
- **Cheap to read.** A 10-feed, 600-post, 720-file batch comes back as about 250 tokens. One contact
  sheet of 60 thumbnails costs about 700 to 1,500.
- **Files in your repo.** `x-media/<handle>/<postId>_<n>.jpg|png|mp4`, original size, best bitrate.
- **Free.** MIT. No API key, no paid tier, no account with us.

## Before you start: the honest part

- **Use a spare account for big runs.** X can lock accounts that read this fast. All ten tabs share
  one account's limits.
- **Your cookies stay with you.** Locally, `login` keeps your session in `~/.riffler/profile`. In
  cloud sessions, put `X_AUTH_TOKEN` and `X_CT0` in the environment's settings. Never paste them
  into a chat or commit them.
- **X's rate limits are the ceiling, not the tab count.** Riffler reads X's limit headers, stops
  cleanly and tells you when the window resets.
- **Automating an account is against X's terms.** Riffler only reads, but the risk is yours.

## Add it to your client

Every snippet runs Riffler straight from GitHub. (Once it's on npm: `npx -y riffler`.)

**Claude Code**

```bash
claude mcp add --transport stdio riffler -- npx -y github:rayhankhilji/x-for-agents
```

Or commit a `.mcp.json` so the whole team (and cloud sessions) get it:

```json
{
  "mcpServers": {
    "riffler": {
      "command": "npx",
      "args": ["-y", "github:rayhankhilji/x-for-agents"],
      "env": { "X_OUTPUT_DIR": "x-media", "X_AUTH_TOKEN": "${X_AUTH_TOKEN}", "X_CT0": "${X_CT0}" }
    }
  }
}
```

**Claude Desktop**: Settings → Developer → Edit Config (`claude_desktop_config.json`), then quit
and reopen.

```json
{
  "mcpServers": {
    "riffler": { "command": "npx", "args": ["-y", "github:rayhankhilji/x-for-agents"] }
  }
}
```

**Codex** (CLI, IDE extension and desktop app share `~/.codex/config.toml`)

```bash
codex mcp add riffler -- npx -y github:rayhankhilji/x-for-agents
```

**Cursor**: `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "riffler": { "type": "stdio", "command": "npx", "args": ["-y", "github:rayhankhilji/x-for-agents"] }
  }
}
```

**VS Code** (Copilot): `.vscode/mcp.json`. Note the key is `servers`.

```json
{
  "servers": {
    "riffler": { "type": "stdio", "command": "npx", "args": ["-y", "github:rayhankhilji/x-for-agents"] }
  }
}
```

**Zed**: `zed: open settings file`, then `"context_servers": { "riffler": { "command": "npx", "args": ["-y", "github:rayhankhilji/x-for-agents"] } }`

**Cline**: MCP Servers → Configure → `cline_mcp_settings.json`, same `mcpServers` block as Cursor
(without `type`).

**Gemini CLI**: `~/.gemini/settings.json`, same `mcpServers` block. Gemini CLI hides inherited
variables whose names contain `TOKEN` or `AUTH`, so if you use cookie env vars, set them inside the
server's own `env`.

If you signed in with `login`, no cookie variables are needed. For cloud sessions, add
`"env": { "X_AUTH_TOKEN": "...", "X_CT0": "..." }` using your client's own secret mechanism.

**claude.ai (web)** only accepts remote servers: run `X_MCP_TOKEN=<random> npx -y
github:rayhankhilji/x-for-agents serve --http`, put it behind an HTTPS tunnel you control, and add
`https://<tunnel>/mcp/<token>` as a custom connector. Without a token, only requests from the same
machine are accepted.

## The tools

| Tool | What it does |
|---|---|
| `x_collect` | Scroll one feed, filter, download. Returns `run <id>` and numbered rows. |
| `x_batch` | Up to 50 feeds in parallel. One line per feed, plus a combined run. |
| `x_preview` | One contact sheet of a run's media. `3b` = the second item of row 3. |
| `x_download` | Download rows of a run (`"2,5b,9-12"`) or posts by URL, into any folder. |
| `x_status` | Login, account, tabs, rate limits, ffmpeg, output folder. |

Sources: `home`, `following`, `user`, `user_media` (everything someone posted), `search` (X
operators work: `from:nasa filter:videos since:2026-01-01`), `bookmarks`, `likes`, `list`, `post`,
`url`. Filters: `media_types`, `match` (`"cat,dog"` or `"/regex/"`), `min_likes`, `min_views`,
`min_size`, `min_duration_s`, `max_duration_s`, `lang`, `since`.

In clients that support MCP Apps, such as Claude Desktop and claude.ai, results can also render as a gallery you can filter, play and pick from.

## Cloud and web Claude Code

There is no screen to sign in on, so: in the cloud environment's settings add `X_AUTH_TOKEN` and
`X_CT0` (from your browser: DevTools → Application → Cookies → x.com), allow `x.com` and `twimg.com`
if the network is limited, and commit the `.mcp.json` above. Riffler finds the container's Chromium
on its own. `npx -y github:rayhankhilji/x-for-agents doctor` checks the setup.

## Settings

| Variable | Default | |
|---|---|---|
| `X_TABS` | `10` | Parallel tabs (max 20) |
| `X_OUTPUT_DIR` | `~/riffler-data/media` | Relative paths land in your project |
| `X_AUTH_TOKEN`, `X_CT0`, `X_COOKIES_FILE` | | Cookie sign-in for cloud and CI |
| `X_HEADLESS` | `true` | `false` to watch the tabs |
| `X_DOWNLOAD_TIMEOUT_MS` | `600000` | Per file, so a stalled stream can't hang a run |
| `X_MCP_TOKEN` | | Token for `serve --http` |

Videos that exist only as a stream need ffmpeg. Riffler finds yours or installs a small static copy
the first time one turns up.

## Credit where due

[gallery-dl](https://github.com/mikf/gallery-dl) and [yt-dlp](https://github.com/yt-dlp/yt-dlp)
are excellent and you should use them when you're driving. Riffler is for when Claude is.

## Development

```bash
npm install && npm run build && npm test
```

The tests run the real server against a mock of x.com (ten tabs, queueing, downloads, contact
sheets) and robustness tests that try to crash the server.

MIT licensed.
