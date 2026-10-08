"use strict";
const http = require("node:http"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const { createBackend } = require("./app.cjs"),
  { root, loadEnv } = require("./config.cjs"),
  { ApiError, uuid } = require("./vendor/lib/core");
const { clientIp } = require("./request-security.cjs");
loadEnv();
async function readBody(req, limit) {
  if (["GET", "HEAD"].includes(req.method)) return {};
  if (
    !(
      String(req.headers["content-type"] || "")
        .toLowerCase()
        .split(";")[0]
        .trim() === "application/json"
    )
  )
    throw new ApiError("INVALID_CONTENT_TYPE", "请使用 JSON 请求", 415);
  const length = Number(req.headers["content-length"] || 0);
  if (length > limit) throw new ApiError("BODY_TOO_LARGE", "请求内容过大", 413);
  let n = 0;
  const parts = [];
  for await (const chunk of req) {
    n += chunk.length;
    if (n > limit) throw new ApiError("BODY_TOO_LARGE", "请求内容过大", 413);
    parts.push(chunk);
  }
  if (!n) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (_) {
    throw new ApiError("INVALID_JSON", "请求格式无效");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError("INVALID_JSON", "请求格式无效");
  return body;
}
function createServer(options = {}) {
  const backend = options.backend || createBackend(options),
    dist = path.join(root, "frontend", "dist");
  const rate = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(), geolocation=(self)",
    );
    try {
      const host = String(req.headers.host || "");
      const parsedHost = new URL("http://" + host),
        localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]),
        configuredHosts = new Set(
          String(process.env.HYHQ_ALLOWED_HOSTS || "")
            .split(",")
            .map((name) => name.trim().toLowerCase())
            .filter(Boolean),
        ),
        isLocalHost = localHosts.has(parsedHost.hostname),
        isConfiguredHost = configuredHosts.has(parsedHost.hostname);
      if (
        parsedHost.username ||
        parsedHost.password ||
        (!isLocalHost && !isConfiguredHost) ||
        (isConfiguredHost && parsedHost.port && parsedHost.port !== "443")
      )
        throw new ApiError("HOST_FORBIDDEN", "仅允许本机访问", 403);
      if (req.headers.origin) {
        const o = new URL(req.headers.origin);
        if (
          !["http:", "https:"].includes(o.protocol) ||
          (isConfiguredHost
            ? o.host.toLowerCase() !== parsedHost.host.toLowerCase()
            : !localHosts.has(o.hostname) ||
              ![
                parsedHost.port,
                "5173",
                "5178",
                "8787",
              ].includes(o.port))
        )
          throw new ApiError("ORIGIN_FORBIDDEN", "请求来源无效", 403);
      }
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new ApiError("ORIGIN_FORBIDDEN", "请求来源无效", 403);
      const raw = String(req.url || "");
      if (
        raw.length > 4096 ||
        /[\\\s#\x00-\x1f]/.test(raw) ||
        /\/\/|(?:^|\/)\.{1,2}(?:\/|$)|%/.test(raw.split("?")[0])
      )
        throw new ApiError("INVALID_REQUEST", "请求路径无效");
      const url = new URL(raw, "http://" + host);
      if (url.pathname.startsWith("/api/v1/")) {
        if (
          !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(
            req.method,
          )
        )
          throw new ApiError("METHOD_NOT_ALLOWED", "不支持此操作", 405);
        if (url.pathname.startsWith("/api/v1/auth/")) {
          const key = clientIp(req),
            now = Date.now(),
            recent = (rate.get(key) || []).filter((t) => t > now - 60000);
          if (recent.length >= 60)
            throw new ApiError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
          recent.push(now);
          rate.set(key, recent);
        }
        const body = await readBody(
            req,
            url.pathname === "/api/v1/web/uploads/"
              ? Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4096
              : 400000,
          ),
          result = await backend.dispatch(req, res, url, body);
        res.statusCode = result.statusCode || 200;
        if (result.binary) {
          res.setHeader("Content-Type", result.contentType);
          res.setHeader("Content-Length", result.binary.length);
          return res.end(result.binary);
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.end(
          result.statusCode === 204 ? "" : JSON.stringify(result.data),
        );
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new ApiError("NOT_FOUND", "页面不存在", 404);
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      let filename = path.resolve(dist, "." + url.pathname);
      if (!filename.startsWith(dist + path.sep) && filename !== dist)
        throw new ApiError("NOT_FOUND", "页面不存在", 404);
      if (url.pathname.split("/").some((x) => x.startsWith(".")))
        throw new ApiError("NOT_FOUND", "页面不存在", 404);
      let bytes;
      try {
        bytes = await fs.readFile(filename);
      } catch (_) {
        if (path.extname(filename))
          throw new ApiError("NOT_FOUND", "文件不存在", 404);
        filename = path.join(dist, "index.html");
        try {
          bytes = await fs.readFile(filename);
        } catch (_) {
          throw new ApiError(
            "FRONTEND_NOT_BUILT",
            "前端尚未构建，请先运行构建脚本",
            503,
          );
        }
      }
      const mime =
        {
          ".html": "text/html; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        }[path.extname(filename)] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      res.end(req.method === "HEAD" ? "" : bytes);
    } catch (error) {
      const known = error instanceof ApiError;
      if (!known)
        console.error(
          JSON.stringify({ event: "request_failed", code: "INTERNAL_ERROR" }),
        );
      if (!res.headersSent) {
        res.statusCode = known ? error.status : 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: {
              code: known ? error.code : "INTERNAL_ERROR",
              message: known ? error.message : "服务暂时不可用，请稍后重试",
              ...(known && error.details ? { details: error.details } : {}),
            },
            request_id: uuid(),
          }),
        );
      } else res.destroy();
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  let tick;
  if (options.timers !== false) {
    const run = () => {
      backend.maintenance().catch(() => console.error(JSON.stringify({ event: "maintenance_failed" })));
      // Weather refresh runs independently; slow upstream calls never block HTTP reads or other maintenance.
      backend.refreshWeather?.().catch(() => console.error(JSON.stringify({ event: "weather_refresh_failed" })));
    };
    tick = setInterval(run, 30000);
    tick.unref();
    server.once("listening", run);
  }
  server.on("close", () => clearInterval(tick));
  server.backend = backend;
  return server;
}
if (require.main === module) {
  const port = Number(process.env.HYHQ_PORT || process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid local port");
  const server = createServer();
  server.listen(port, "127.0.0.1", () =>
    console.log(`海晏河清本地网页版已启动：http://127.0.0.1:${port}`),
  );
  server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? "端口已被占用，请先停止已运行服务。"
        : "本地服务启动失败。",
    );
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(async () => {
        await server.backend.store.close();
        process.exit(0);
      }),
    );
}
module.exports = { createServer, readBody };
