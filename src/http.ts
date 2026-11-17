/**
 * Streamable HTTP transport, so the same server can be added as a custom connector in
 * claude.ai / Claude Desktop (remote MCP) or reached by cloud agents. Stateless: one MCP
 * server object per request, sharing the single browser pool.
 *
 * Auth: set X_MCP_TOKEN. Clients then use https://host/mcp/<token> or `Authorization: Bearer <token>`.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, pool } from "./server.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    return new URL(v.includes("://") ? v : `http://${v}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * With a token: the token must match (path segment or Bearer header).
 * Without one: only requests that really come from this machine. Host and Origin must be
 * loopback, which defeats DNS rebinding (a rebound page sends its own domain as Host).
 */
function authorized(req: http.IncomingMessage, pathToken: string | undefined, token?: string): boolean {
  if (token) {
    const given = pathToken || (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const host = hostnameOf(req.headers.host);
  const origin = req.headers.origin;
  return !!host && LOOPBACK.has(host) && (!origin || LOOPBACK.has(hostnameOf(origin) ?? ""));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

export async function serveHttp(port: number, host: string) {
  const token = process.env.X_MCP_TOKEN || undefined;
  if (!token && host !== "127.0.0.1" && host !== "localhost") {
    console.error("[x-for-agents] No X_MCP_TOKEN set: only requests from this machine are accepted. Set a token to allow remote clients.");
  }
  const srv = http.createServer(async (req, res) => {
    try {
      // Parse against a fixed base: never trust the Host header for URL parsing.
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (parts[0] !== "mcp" || parts.length > 2) return void res.writeHead(404).end();
      if (!authorized(req, parts[1], token)) return void res.writeHead(401).end("unauthorized");
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const body = await readJson(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      try {
        if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (e as Error).message }, id: null }));
      } catch {
        /* connection already gone */
      }
    }
  });
  srv.on("clientError", (_e, socket) => socket.destroy());
  await new Promise<void>((r) => srv.listen(port, host, r));
  console.error(`[x-for-agents] HTTP MCP on http://${host}:${port}/mcp${token ? "/<token>" : ""}`);
  const shutdown = async () => {
    srv.close();
    await pool.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
