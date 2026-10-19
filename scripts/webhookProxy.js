// A deliberately narrow origin for a temporary Cloudflare Quick Tunnel.
// It never parses or rewrites POST bytes: Express verifies Meta's HMAC.
const http = require("node:http");

const MAX_BODY_BYTES = 256 * 1024;

function port(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} debe ser un puerto válido.`);
  return parsed;
}

function createWebhookProxy({ backendPort }) {
  const targetPort = port(backendPort, "WEBHOOK_BACKEND_PORT");
  const server = http.createServer((req, res) => {
    const path = req.url || "";
    const method = req.method || "";
    const reply = (status, message) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(message);
    };

    // Match the literal origin-form path. Encoded, prefixed, suffixed and
    // normalized alternatives never reach Express, even if Express accepts them.
    if (!(path === "/webhook" || (method === "GET" && path.startsWith("/webhook?")))) {
      reply(404, "Ruta no disponible.");
      req.resume();
      return;
    }
    if (method !== "GET" && method !== "POST") {
      reply(405, "Método no permitido.");
      req.resume();
      return;
    }
    if (method === "POST" && !/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers["content-type"] || ""))) {
      reply(415, "Se requiere JSON.");
      req.resume();
      return;
    }
    if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
      reply(413, "Carga demasiado grande.");
      req.resume();
      return;
    }

    let size = 0;
    let rejected = false;
    const chunks = [];
    req.on("data", chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reply(413, "Carga demasiado grande.");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      const body = Buffer.concat(chunks, size);
      const headers = { "content-length": String(body.length) };
      if (method === "POST") {
        headers["content-type"] = "application/json";
        if (typeof req.headers["x-hub-signature-256"] === "string") {
          headers["x-hub-signature-256"] = req.headers["x-hub-signature-256"];
        }
      }
      const upstream = http.request({ hostname: "127.0.0.1", port: targetPort, path, method, headers, timeout: 5000 }, upstreamResponse => {
        res.writeHead(upstreamResponse.statusCode || 502, {
          "content-type": upstreamResponse.headers["content-type"] || "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        upstreamResponse.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) reply(502, "Backend no disponible.");
        else res.destroy();
      });
      upstream.end(body);
    });
    req.on("error", () => {
      rejected = true;
      res.destroy();
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 12000;
  server.keepAliveTimeout = 2000;
  return server;
}

if (require.main === module) {
  const listenPort = port(process.env.WEBHOOK_PROXY_PORT || 3101, "WEBHOOK_PROXY_PORT");
  const backendPort = port(process.env.WEBHOOK_BACKEND_PORT || 3000, "WEBHOOK_BACKEND_PORT");
  if (listenPort === backendPort) throw new Error("El proxy y Express deben usar puertos distintos.");
  createWebhookProxy({ backendPort }).listen(listenPort, "127.0.0.1", () => {
    console.log(`Proxy de /webhook listo en http://127.0.0.1:${listenPort}`);
  });
}

module.exports = { createWebhookProxy };
