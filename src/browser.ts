import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";

const log = (...a: unknown[]) => console.error("[x-for-agents]", ...a);

export interface CookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

// ---------------------------------------------------------------- browser discovery

function platformUA(version: string): string {
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split(".")[0]}.0.0.0 Safari/537.36`;
}

/** Find a Chromium/Chrome binary that isn't Playwright's own (cloud images, system installs). */
export function findBrowser(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/pw-browsers",
    path.join(os.homedir(), ".cache/ms-playwright"),
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"),
  ].filter((x): x is string => !!x && fs.existsSync(x));
  const inner = [
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ];
  for (const root of roots) {
    const dirs = fs
      .readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) for (const i of inner) {
      const p = path.join(root, d, i);
      if (fs.existsSync(p)) return p;
    }
  }
  const system = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return system.find((p) => fs.existsSync(p));
}

/** Last resort: `playwright install chromium` (needs network to Playwright's CDN). */
export async function installBrowser(): Promise<boolean> {
  const require = createRequire(import.meta.url);
  let cli: string;
  try {
    cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  } catch {
    return false;
  }
  log("No browser found; installing Chromium (one-time)…");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, "install", "chromium"], { stdio: ["ignore", "ignore", "inherit"] });
    const t = setTimeout(() => p.kill(), 5 * 60_000);
    p.on("error", () => resolve(false));
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

let resolvedExecutable: string | undefined;
let cachedUA: string | undefined;

function proxyFromEnv() {
  const server = process.env.X_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { server } : undefined;
}

export async function launchContext(opts: { headless?: boolean; profileDir?: string } = {}): Promise<BrowserContext> {
  const profileDir = opts.profileDir ?? config.profileDir;
  fs.mkdirSync(profileDir, { recursive: true });
  const headless = opts.headless ?? config.headless;
  const launch = (executablePath?: string, userAgent?: string) =>
    chromium.launchPersistentContext(profileDir, {
      headless,
      channel: executablePath ? undefined : config.browserChannel,
      executablePath,
      viewport: { width: 1280, height: 1400 },
      userAgent,
      proxy: proxyFromEnv(),
      args: ["--disable-blink-features=AutomationControlled", "--mute-audio"],
    });

  let exe = config.browserPath ?? resolvedExecutable;
  let ctx: BrowserContext;
  try {
    ctx = await launch(exe, headless ? cachedUA : undefined);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/Executable doesn't exist|browserType\.launch|ENOENT|Failed to launch/i.test(msg) || config.browserPath) throw e;
    exe = findBrowser();
    if (!exe && (await installBrowser())) exe = undefined;
    else if (!exe) throw new Error("No Chromium/Chrome found and auto-install failed. Install Chrome or run `npx playwright install chromium`.");
    resolvedExecutable = exe;
    ctx = await launch(exe, headless ? cachedUA : undefined);
  }

  if (headless && !cachedUA) {
    // Headless Chromium says "HeadlessChrome" in its UA. Learn the version once, relaunch with a normal desktop UA.
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const ua: string = await page.evaluate(() => navigator.userAgent);
    cachedUA = platformUA(ua.match(/Chrome\/([\d.]+)/)?.[1] ?? "140.0.0.0");
    if (/Headless/i.test(ua)) {
      await ctx.close();
      ctx = await launch(exe, cachedUA);
    }
  }
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return ctx;
}

// ---------------------------------------------------------------- cookies / auth

/** Parse cookies from a Cookie-Editor/EditThisCookie JSON export, Netscape cookies.txt, or a "a=b; c=d" header string. */
export function parseCookies(input: string): CookieInput[] {
  const text = input.trim();
  const out: CookieInput[] = [];
  if (text.startsWith("[") || text.startsWith("{")) {
    const data = JSON.parse(text);
    const arr: any[] = Array.isArray(data) ? data : (data.cookies ?? []);
    for (const c of arr) {
      if (!c?.name || c.value == null) continue;
      const sameSite = String(c.sameSite ?? "").toLowerCase();
      out.push({
        name: c.name,
        value: String(c.value),
        domain: c.domain ?? ".x.com",
        path: c.path ?? "/",
        expires: c.expirationDate ?? c.expires ?? undefined,
        httpOnly: !!c.httpOnly,
        secure: c.secure ?? true,
        sameSite: sameSite === "strict" ? "Strict" : sameSite === "lax" ? "Lax" : "None",
      });
    }
  } else if (/\t/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const [domainRaw, , p, secure, expires, name, value] = parts;
      out.push({
        name,
        value,
        domain: domainRaw.replace(/^#HttpOnly_/, ""),
        path: p,
        secure: secure === "TRUE",
        httpOnly: domainRaw.startsWith("#HttpOnly_"),
        expires: Number(expires) || undefined,
        sameSite: "None",
      });
    }
  } else {
    for (const pair of text.replace(/^cookie:\s*/i, "").split(";")) {
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      out.push({ name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() });
    }
  }
  return out
    .filter((c) => !c.domain || /(^|\.)(x|twitter)\.com$/.test(c.domain.replace(/^\./, "")))
    .map((c) => ({
      ...c,
      domain: ".x.com",
      path: c.path ?? "/",
      secure: c.secure ?? true,
      sameSite: c.sameSite ?? "None",
      expires: c.expires && c.expires > 0 ? Math.floor(c.expires) : undefined,
    }));
}

export async function importCookies(ctx: BrowserContext, cookies: CookieInput[]) {
  await ctx.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? ".x.com",
      path: c.path ?? "/",
      expires: c.expires ?? Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      httpOnly: c.httpOnly ?? c.name === "auth_token",
      secure: c.secure ?? true,
      sameSite: c.sameSite ?? "None",
    })),
  );
}

export function envCookies(): CookieInput[] {
  const cookies: CookieInput[] = [];
  const file = process.env.X_COOKIES_FILE;
  if (file && fs.existsSync(file)) cookies.push(...parseCookies(fs.readFileSync(file, "utf8")));
  if (process.env.X_COOKIES) cookies.push(...parseCookies(process.env.X_COOKIES));
  if (process.env.X_AUTH_TOKEN) cookies.push({ name: "auth_token", value: process.env.X_AUTH_TOKEN, domain: ".x.com", httpOnly: true });
  if (process.env.X_CT0) cookies.push({ name: "ct0", value: process.env.X_CT0, domain: ".x.com" });
  return cookies;
}

export async function hasAuthCookie(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies("https://x.com");
  return cookies.some((c) => c.name === "auth_token" && c.value);
}

export const LOGIN_URL_RE = /x\.com\/(login|i\/flow\/(login|signup)|i\/jf\/onboarding)/;

export async function whoAmI(page: Page): Promise<{ loggedIn: boolean; handle?: string; url: string }> {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45_000 });
  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
  const loginForm = page.locator('input[autocomplete="username"], a[href="/login"], [data-testid="loginButton"]');
  await Promise.race([
    profileLink.first().waitFor({ timeout: 25_000 }),
    loginForm.first().waitFor({ timeout: 25_000 }),
    page.waitForURL(LOGIN_URL_RE, { timeout: 25_000 }),
  ]).catch(() => undefined);
  const url = page.url();
  if (await profileLink.count()) {
    const href = await profileLink.first().getAttribute("href");
    return { loggedIn: true, handle: href?.replace(/^\//, ""), url };
  }
  return { loggedIn: false, url };
}

// ---------------------------------------------------------------- tab pool

/**
 * One persistent browser (one X account) with up to `config.tabs` tabs.
 * Each tool call borrows a tab, so up to N collections run truly in parallel.
 */
export class BrowserPool {
  private ctx: BrowserContext | null = null;
  private starting: Promise<BrowserContext> | null = null;
  private closing: Promise<void> | null = null;
  private free: Page[] = [];
  private total = 0;
  private busy = 0;
  private waiters: Array<{ resolve: (p: Page) => void; reject: (e: unknown) => void }> = [];
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(readonly maxTabs = config.tabs) {}

  get stats() {
    return { open: this.total, busy: this.busy - this.waiters.length, queued: this.waiters.length, max: this.maxTabs };
  }

  async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    if (!this.starting) {
      this.starting = (async () => {
        // Never launch on the profile while the previous browser is still shutting down (profile lock).
        if (this.closing) await this.closing;
        const ctx = await launchContext();
        const cookies = envCookies();
        if (cookies.length) await importCookies(ctx, cookies);
        ctx.on("close", () => {
          if (this.ctx !== ctx) return; // a late event from a browser we already replaced
          this.ctx = null;
          this.free = [];
          this.total = 0;
        });
        // Close the default blank page; tabs are created on demand.
        for (const p of ctx.pages()) await p.close().catch(() => undefined);
        this.ctx = ctx;
        return ctx;
      })().finally(() => (this.starting = null));
    }
    return this.starting;
  }

  private async newTab(): Promise<Page> {
    const ctx = await this.context();
    const page = await ctx.newPage();
    if (config.blockMedia) {
      await page.route("**/*", (route) => {
        const t = route.request().resourceType();
        return t === "image" || t === "media" || t === "font" ? route.abort() : route.fallback();
      });
    }
    page.on("close", () => {
      if (this.ctx !== ctx) return;
      this.total = Math.max(0, this.total - 1);
      this.free = this.free.filter((p) => p !== page);
    });
    // A crashed renderer never reports isClosed(); close it so it is never handed out again.
    page.on("crash", () => void page.close().catch(() => undefined));
    return page;
  }

  private scheduleIdle() {
    if (this.busy !== 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), config.idleCloseMs);
    this.idleTimer.unref();
  }

  async acquire(): Promise<Page> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.busy++;
    while (this.free.length) {
      const p = this.free.pop()!;
      if (!p.isClosed()) return p;
    }
    if (this.total < this.maxTabs) {
      this.total++;
      try {
        return await this.newTab();
      } catch (e) {
        this.total--;
        this.busy--;
        this.scheduleIdle();
        throw e;
      }
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  release(page: Page) {
    // `busy` counts every caller from acquire() until release(), including queued waiters.
    this.busy--;
    const w = this.waiters.shift();
    if (w) {
      if (!page.isClosed()) return w.resolve(page);
      // The tab died; open a fresh one for whoever was waiting.
      this.total++;
      this.newTab().then(w.resolve, (e) => {
        this.total--;
        this.busy--;
        this.scheduleIdle();
        w.reject(e);
      });
      return;
    }
    if (!page.isClosed()) this.free.push(page);
    this.scheduleIdle();
  }

  async withPage<T>(fn: (page: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
    const page = await this.acquire();
    try {
      return await fn(page, page.context());
    } finally {
      this.release(page);
    }
  }

  /** A throwaway tab with normal resource loading (for rendering previews). Counts as busy. */
  async withScratchPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.busy++;
    try {
      const ctx = await this.context();
      const page = await ctx.newPage();
      try {
        return await fn(page);
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      this.busy--;
      this.scheduleIdle();
    }
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.free = [];
    this.total = 0;
    if (ctx) {
      this.closing = ctx.close().catch(() => undefined);
      await this.closing;
      this.closing = null;
    }
  }
}
