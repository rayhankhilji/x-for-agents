#!/usr/bin/env node
import fs from "node:fs";
import { hasAuthCookie, importCookies, launchContext, parseCookies, whoAmI } from "./browser.js";
import { collect, SOURCES, type Source } from "./collect.js";
import { config } from "./config.js";
import { downloadPosts } from "./download.js";
import { serveStdio } from "./server.js";
import { PostStore } from "./store.js";

const HELP = `x-for-agents — let Claude Code browse X with your account and pull images/videos.

Usage:
  x-for-agents                       Start the MCP server on stdio (what Claude Code runs)
  x-for-agents login                 Open a browser window, sign in to X, close it when done
  x-for-agents import-cookies <file> Import cookies (Cookie-Editor JSON, cookies.txt, or "auth_token=..; ct0=..")
  x-for-agents status                Show which account the saved session is signed in as
  x-for-agents logout                Delete the saved browser profile
  x-for-agents collect <source> [target] [--max N] [--no-download]
                                     Same as the x_collect tool, from the terminal

Sources: ${SOURCES.join(", ")}

Env: X_HOME (profile, default ~/.x-for-agents)  X_DATA_DIR (downloads, default ~/x-for-agents-data)
     X_HEADLESS=false (watch the browser)  X_BROWSER_CHANNEL=chrome (use installed Chrome)
     X_AUTH_TOKEN / X_CT0 / X_COOKIES_FILE (cookie login without a UI)
`;

async function login() {
  console.log("Opening a browser window. Sign in to X there; this closes automatically once you're in.");
  const ctx = await launchContext({ headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://x.com/login");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (ctx.pages().length === 0) break;
    if (await hasAuthCookie(ctx)) {
      await new Promise((r) => setTimeout(r, 3000)); // let X finish setting cookies
      console.log("Signed in. Session saved to", config.profileDir);
      await ctx.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await ctx.close().catch(() => undefined);
  console.error("Login not detected (timed out or window closed).");
  process.exitCode = 1;
}

async function status() {
  const ctx = await launchContext();
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const who = await whoAmI(page);
    console.log(who.loggedIn ? `Signed in as @${who.handle}` : `Not signed in (landed on ${who.url})`);
    if (!who.loggedIn) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

async function importCookiesCmd(arg?: string) {
  if (!arg) throw new Error("usage: x-for-agents import-cookies <file | 'auth_token=...; ct0=...'>");
  const raw = fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg;
  const cookies = parseCookies(raw);
  if (!cookies.some((c) => c.name === "auth_token")) throw new Error("No auth_token cookie found in input.");
  const ctx = await launchContext();
  try {
    await importCookies(ctx, cookies);
    console.log(`Imported ${cookies.length} cookies into ${config.profileDir}`);
  } finally {
    await ctx.close();
  }
  await status();
}

async function collectCmd(args: string[]) {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--") && ["--max", "--scrolls", "--types", "--since", "--out"].includes(a)) {
        flags.set(a, next);
        i++;
      } else flags.set(a, true);
    } else pos.push(a);
  }
  const source = pos[0] as Source;
  if (!SOURCES.includes(source)) throw new Error(`source must be one of: ${SOURCES.join(", ")}`);
  const ctx = await launchContext();
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const types = typeof flags.get("--types") === "string" ? (flags.get("--types") as string).split(",") : undefined;
    const r = await collect(page, {
      source,
      target: pos[1],
      searchMode: "latest",
      maxPosts: Number(flags.get("--max") ?? 40),
      maxScrolls: Number(flags.get("--scrolls") ?? 60),
      mediaOnly: !flags.has("--all"),
      mediaTypes: types as any,
      includeQuoted: false,
      includeRetweets: true,
      since: flags.get("--since") as string | undefined,
    });
    const store = new PostStore();
    store.add(r.posts);
    console.log(`${r.posts.length} posts (${r.stopReason}, ${r.scrolls} scrolls) from ${r.url}`);
    if (!flags.has("--no-download")) {
      const d = await downloadPosts(r.posts, { types: types as any, dir: flags.get("--out") as string | undefined });
      for (const x of d) console.log(`${x.status.padEnd(10)} ${x.type.padEnd(5)} ${x.path ?? x.url}${x.error ? "  " + x.error : ""}`);
    }
    console.log("Saved:", store.saveCollection(`${source}_${pos[1] ?? ""}`, r));
  } finally {
    await ctx.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "serve":
      return serveStdio();
    case "login":
      return login();
    case "status":
      return status();
    case "import-cookies":
      return importCookiesCmd(rest[0]);
    case "logout":
      fs.rmSync(config.profileDir, { recursive: true, force: true });
      console.log("Removed", config.profileDir);
      return;
    case "collect":
      return collectCmd(rest);
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
