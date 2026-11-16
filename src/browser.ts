import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";

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

function userAgentFor(version: string): string {
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  const major = version.split(".")[0];
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function proxyFromEnv() {
  const server = process.env.X_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { server } : undefined;
}

let cachedUserAgent: string | undefined;

export async function launchContext(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  fs.mkdirSync(config.profileDir, { recursive: true });
  const headless = opts.headless ?? config.headless;
  const launch = (userAgent?: string) =>
    chromium.launchPersistentContext(config.profileDir, {
      headless,
      channel: config.browserChannel,
      executablePath: config.browserPath,
      viewport: { width: 1280, height: 1000 },
      userAgent,
      proxy: proxyFromEnv(),
      args: ["--disable-blink-features=AutomationControlled"],
    });

  let ctx = await launch(headless ? cachedUserAgent : undefined);
  if (headless && !cachedUserAgent) {
    // Headless Chromium advertises "HeadlessChrome" in its UA, which X may
    // treat differently. Learn the real version once, then relaunch with a
    // normal desktop UA.
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const ua: string = await page.evaluate(() => navigator.userAgent);
    const version = ua.match(/Chrome\/([\d.]+)/)?.[1] ?? "140.0.0.0";
    cachedUserAgent = userAgentFor(version);
    if (/Headless/i.test(ua)) {
      await ctx.close();
      ctx = await launch(cachedUserAgent);
    }
  }
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return ctx;
}

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
  // Only keep X/Twitter cookies, normalised onto .x.com.
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

export async function hasAuthCookie(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies("https://x.com");
  return cookies.some((c) => c.name === "auth_token" && c.value);
}

/** Navigate to home and figure out which account (if any) is signed in. */
export async function whoAmI(page: Page): Promise<{ loggedIn: boolean; handle?: string; url: string }> {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45_000 });
  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
  const loginForm = page.locator('input[autocomplete="username"], a[href="/login"], [data-testid="loginButton"]');
  try {
    await Promise.race([
      profileLink.first().waitFor({ timeout: 25_000 }),
      loginForm.first().waitFor({ timeout: 25_000 }),
    ]);
  } catch {
    /* fall through */
  }
  const url = page.url();
  if (await profileLink.count()) {
    const href = await profileLink.first().getAttribute("href");
    return { loggedIn: true, handle: href?.replace(/^\//, ""), url };
  }
  return { loggedIn: false, url };
}

/**
 * One browser per server process, launched lazily and closed after an idle
 * period. All tool calls are serialised through `withPage` so concurrent
 * requests never fight over the same tab.
 */
export class BrowserSession {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private envCookiesApplied = false;

  private async ensure(): Promise<Page> {
    if (this.ctx && this.page && !this.page.isClosed()) return this.page;
    this.ctx = await launchContext();
    this.ctx.on("close", () => {
      this.ctx = null;
      this.page = null;
    });
    if (!this.envCookiesApplied) {
      await this.applyEnvCookies(this.ctx);
      this.envCookiesApplied = true;
    }
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    return this.page;
  }

  private async applyEnvCookies(ctx: BrowserContext) {
    const cookies: CookieInput[] = [];
    if (process.env.X_COOKIES_FILE && fs.existsSync(process.env.X_COOKIES_FILE)) {
      cookies.push(...parseCookies(fs.readFileSync(process.env.X_COOKIES_FILE, "utf8")));
    }
    if (process.env.X_AUTH_TOKEN) cookies.push({ name: "auth_token", value: process.env.X_AUTH_TOKEN, domain: ".x.com", httpOnly: true });
    if (process.env.X_CT0) cookies.push({ name: "ct0", value: process.env.X_CT0, domain: ".x.com" });
    if (cookies.length) await importCookies(ctx, cookies);
  }

  withPage<T>(fn: (page: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
    const run = async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      try {
        const page = await this.ensure();
        return await fn(page, this.ctx!);
      } finally {
        this.idleTimer = setTimeout(() => void this.close(), config.idleCloseMs);
        this.idleTimer.unref();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }
}
