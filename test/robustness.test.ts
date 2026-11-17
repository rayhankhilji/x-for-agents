/** Tries to crash the built server the ways the review found it could be crashed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** A non-loopback IPv4 address of this machine, if it has one. */
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "dist/index.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xfa-rob-"));
const env = { ...process.env, X_HOME: path.join(tmp, "home"), X_DATA_DIR: path.join(tmp, "data") };

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.end(text));
    let out = "";
    sock.on("data", (d) => (out += d));
    sock.on("close", () => resolve(out));
    sock.on("error", () => resolve(out));
  });
}

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const post = (port: number, p: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: init }).then((r) => r.status);

test("HTTP server survives malformed requests and blocks DNS rebinding", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "serve", "--http", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((r) => child.stderr.on("data", (d) => String(d).includes("HTTP MCP") && r()));
  try {
    await raw(port, "POST // HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n");
    await raw(port, "POST /mcp HTTP/1.1\r\nHost: a b\r\nContent-Length: 0\r\n\r\n");
    await raw(port, "garbage\r\n\r\n");
    await raw(port, `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n{bad}`);
    assert.equal(child.exitCode, null, "still running");
    assert.equal(await post(port, "/mcp"), 200, "local client works");
    // fetch() won't let us forge Host/Origin, so speak raw HTTP like a rebound browser page would.
    const forged = (h: string) =>
      raw(port, `POST /mcp HTTP/1.1\r\n${h}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(init)}\r\nConnection: close\r\n\r\n${init}`);
    assert.match(await forged("Host: localhost"), /^HTTP\/1\.1 200/, "control: same request with a local Host works");
    assert.match(await forged("Host: evil.example"), /^HTTP\/1\.1 401/, "rebound Host rejected");
    assert.match(await forged("Host: localhost\r\nOrigin: https://evil.example"), /^HTTP\/1\.1 401/, "foreign Origin rejected");
    assert.equal(await post(port, "/mcpanything"), 404);
  } finally {
    child.kill();
  }
});

test("without a token, a forged Host header from another address is rejected", { skip: !lanIp && "no LAN address" }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "serve", "--http", "--host", "0.0.0.0", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((r) => child.stderr.on("data", (d) => String(d).includes("HTTP MCP") && r()));
  try {
    const viaLan = await new Promise<string>((resolve) => {
      const sock = net.connect(port, lanIp!, () =>
        sock.end(`POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(init)}\r\nConnection: close\r\n\r\n${init}`),
      );
      let out = "";
      sock.on("data", (d) => (out += d));
      sock.on("close", () => resolve(out));
      sock.on("error", () => resolve(out));
    });
    assert.match(viaLan, /^HTTP\/1\.1 401/, `connection from ${lanIp} must be rejected even with Host: localhost`);
    assert.equal(await post(port, "/mcp"), 200, "loopback still works");
  } finally {
    child.kill();
  }
});

test("HTTP token is required when set", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "serve", "--http", "--port", String(port)], { env: { ...env, X_MCP_TOKEN: "t0ken" }, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((r) => child.stderr.on("data", (d) => String(d).includes("HTTP MCP") && r()));
  try {
    assert.equal(await post(port, "/mcp"), 401);
    assert.equal(await post(port, "/mcp/wrong"), 401);
    assert.equal(await post(port, "/mcp/t0ken"), 200);
    assert.equal(await post(port, "/mcp", { authorization: "Bearer t0ken" }), 200);
  } finally {
    child.kill();
  }
});

test("stdio server exits when the client goes away", async () => {
  const child = spawn(process.execPath, [bin], { env, stdio: ["pipe", "pipe", "pipe"] });
  await new Promise<void>((r) => child.stderr.on("data", (d) => String(d).includes("MCP ready") && r()));
  child.stdin.end();
  const code = await Promise.race([new Promise((r) => child.on("exit", r)), new Promise((r) => setTimeout(() => r("still running"), 8000))]);
  if (code === "still running") child.kill();
  assert.notEqual(code, "still running");
});

test("a download into an impossible folder reports an error instead of crashing", async () => {
  const { downloadPosts } = await import("../src/download.ts");
  const file = path.join(tmp, "a-file");
  fs.writeFileSync(file, "x");
  const post = { id: "1", url: "", author: { handle: "h" }, text: "", context: "timeline" as const, media: [{ key: "k", index: 0, type: "photo" as const, url: "https://example.invalid/x.jpg" }] };
  const [r] = await downloadPosts([post], { dir: path.join(file, "sub") });
  assert.equal(r.status, "error");
});
