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

function tokenOk(req: http.IncomingMessage, url: URL, token?: string): boolean {
  if (!token) return true;
  const given = url.pathname.split("/")[2] || (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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
    console.error("[x-for-agents] WARNING: listening publicly without X_MCP_TOKEN — anyone with the URL can use your X session.");
  }
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, tabs: pool.stats }));
      return;
    }
    if (!url.pathname.startsWith("/mcp")) return void res.writeHead(404).end();
    if (!tokenOk(req, url, token)) return void res.writeHead(401).end("unauthorized");
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    try {
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
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (e as Error).message }, id: null }));
    }
  });
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
