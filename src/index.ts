#!/usr/bin/env node
import fs from "node:fs";
import { envCookies, findBrowser, hasAuthCookie, importCookies, launchContext, parseCookies, whoAmI } from "./browser.js";
import { collect, SOURCES, type Source } from "./collect.js";
import { config, displayPath, resolveOutDir } from "./config.js";
import { downloadLine } from "./format.js";
import { downloadPosts, resolveFfmpeg } from "./download.js";
import { PostStore } from "./store.js";

const HELP = `x-for-agents — let Claude browse X with your account and pull images/videos fast.

  x-for-agents                        MCP server on stdio (what Claude Code runs)
  x-for-agents serve --http [--port 8787] [--host 127.0.0.1]
                                      MCP over HTTP (claude.ai / Desktop custom connector). Set X_MCP_TOKEN.
  x-for-agents login                  Open a browser window, sign in to X once
  x-for-agents import-cookies <file|"auth_token=..; ct0=..">
  x-for-agents status | doctor | logout | setup-ffmpeg
  x-for-agents collect <source> [target] [--max N] [--types photo,video] [--out DIR] [--no-download]

Sources: ${SOURCES.join(", ")}
Env: X_TABS (10) X_OUTPUT_DIR X_DATA_DIR X_HOME X_HEADLESS X_BROWSER_PATH X_AUTH_TOKEN X_CT0 X_COOKIES_FILE
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login() {
  console.log("Opening a browser window. Sign in to X there; it closes automatically once you're in.");
  const ctx = await launchContext({ headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://x.com/login");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && ctx.pages().length) {
    if (await hasAuthCookie(ctx)) {
      await sleep(3000);
      console.log("Signed in. Session saved to", config.profileDir);
      await ctx.close();
      return;
    }
    await sleep(1000);
  }
  await ctx.close().catch(() => undefined);
  console.error("Login not detected (timed out or window closed).");
  process.exitCode = 1;
}

async function withCtx<T>(fn: (ctx: Awaited<ReturnType<typeof launchContext>>) => Promise<T>): Promise<T> {
  const ctx = await launchContext();
  try {
    const env = envCookies();
    if (env.length) await importCookies(ctx, env);
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

async function status(): Promise<boolean> {
  return withCtx(async (ctx) => {
    const who = await whoAmI(ctx.pages()[0] ?? (await ctx.newPage()));
    console.log(who.loggedIn ? `Signed in as @${who.handle}` : `Not signed in (landed on ${who.url})`);
    return who.loggedIn;
  });
}

async function doctor() {
  const ok = (b: boolean) => (b ? "✓" : "✗");
  console.log(`node ${process.version}`);
  console.log(`profile ${config.profileDir}`);
  console.log(`output  ${displayPath(resolveOutDir())}`);
  console.log(`tabs    ${config.tabs}`);
  console.log(`browser ${config.browserPath ?? findBrowser() ?? "playwright default"}`);
  console.log(`cookies from env: ${envCookies().map((c) => c.name).join(", ") || "none"}`);
  for (const u of ["https://x.com/", "https://pbs.twimg.com/", "https://video.twimg.com/"]) {
    const { fetch, EnvHttpProxyAgent } = await import("undici");
    const r = await fetch(u, { method: "HEAD", dispatcher: process.env.HTTPS_PROXY ? new EnvHttpProxyAgent() : undefined }).then(
      (r) => r.status,
      (e) => String(e.cause?.code ?? e.message),
    );
    console.log(`net ${u} → ${r}`);
  }
  const ff = await resolveFfmpeg({ install: false });
  console.log(`${ok(!!ff)} ffmpeg ${ff ?? "(auto-installs on first HLS-only video, or run setup-ffmpeg)"}`);
  const loggedIn = await status().catch((e) => (console.log("✗ browser:", e.message), false));
  console.log(`${ok(loggedIn)} X session`);
  if (!loggedIn) process.exitCode = 1;
}

async function importCookiesCmd(arg?: string) {
  if (!arg) throw new Error("usage: x-for-agents import-cookies <file | 'auth_token=...; ct0=...'>");
  const raw = fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg;
  const cookies = parseCookies(raw);
  if (!cookies.some((c) => c.name === "auth_token")) throw new Error("No auth_token cookie found in input.");
  await withCtx((ctx) => importCookies(ctx, cookies));
  console.log(`Imported ${cookies.length} cookies into ${config.profileDir}`);
  if (!(await status())) process.exitCode = 1;
}

async function collectCmd(args: string[]) {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--") && ["--max", "--scrolls", "--types", "--since", "--out", "--match"].includes(a)) {
        flags.set(a, next);
        i++;
      } else flags.set(a, true);
    } else pos.push(a);
  }
  const source = pos[0] as Source;
  if (!SOURCES.includes(source)) throw new Error(`source must be one of: ${SOURCES.join(", ")}`);
  const types = typeof flags.get("--types") === "string" ? ((flags.get("--types") as string).split(",") as any) : undefined;
  await withCtx(async (ctx) => {
    const r = await collect(ctx.pages()[0] ?? (await ctx.newPage()), {
      source,
      target: pos[1],
      searchMode: "latest",
      maxPosts: Number(flags.get("--max") ?? 40),
      maxScrolls: Number(flags.get("--scrolls") ?? 60),
      mediaOnly: !flags.has("--all"),
      mediaTypes: types,
      includeQuoted: false,
      includeRetweets: true,
      since: flags.get("--since") as string | undefined,
      match: flags.get("--match") as string | undefined,
    });
    const store = new PostStore();
    const id = store.newRunId();
    store.add(r.posts);
    console.log(`run ${id} · ${r.posts.length} posts · ${r.stopReason} · ${r.scrolls} scrolls · ${(r.elapsedMs / 1000).toFixed(1)}s`);
    let files: { post: string; key: string; path?: string }[] | undefined;
    if (!flags.has("--no-download")) {
      const dir = resolveOutDir(flags.get("--out") as string | undefined);
      const d = await downloadPosts(r.posts, { types, dir });
      files = d.filter((x) => x.path).map((x) => ({ post: x.post_id, key: x.media_key, path: x.path }));
      console.log(downloadLine(d, dir));
    }
    store.saveRun({ id, label: [source, pos[1]].filter(Boolean).join(" "), created_at: new Date().toISOString(), url: r.url, stop: r.stopReason, posts: r.posts, files });
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || cmd === "serve") {
    // A long-running server must never die from one stray rejected promise.
    process.on("unhandledRejection", (e) => console.error("[x-for-agents] unhandled:", (e as Error)?.message ?? e));
  }
  const flag = (name: string, d: string) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : d;
  };
  switch (cmd) {
    case undefined:
    case "serve":
      if (rest.includes("--http")) {
        const { serveHttp } = await import("./http.js");
        return serveHttp(Number(flag("--port", process.env.PORT ?? "8787")), flag("--host", process.env.HOST ?? "127.0.0.1"));
      }
      return (await import("./server.js")).serveStdio();
    case "login":
      return login();
    case "status":
      if (!(await status())) process.exitCode = 1;
      return;
    case "doctor":
      return doctor();
    case "setup-ffmpeg": {
      const p = await resolveFfmpeg();
      console.log(p ? `ffmpeg: ${p}` : "Could not install ffmpeg (no network to npm/GitHub?). HLS-only videos will be skipped.");
      return;
    }
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
