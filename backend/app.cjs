"use strict";
const path = require("node:path"),
  fs = require("node:fs/promises");
const { ApiError, response, requireUser, uuid } = require("./vendor/lib/core");
const auth = require("./auth.cjs"),
  reminders = require("./reminders.cjs");
const guest = require("./guest.cjs"), captcha = require("./captcha.cjs"), blog = require("./blog.cjs");
const accounts = require("./vendor/lib/accounts"),
  files = require("./vendor/lib/files");
const { root, getConfig } = require("./config.cjs");
const { SQLiteStore } = require("./store.cjs");
const { localCloud } = require("./local-storage.cjs");
const SOURCED_COMMIT = "1080ad3";
const { cleanupSecurity } = captcha;
function createBackend(options = {}) {
  const store =
    options.store ||
    new SQLiteStore(path.join(root, ".private", "hyhq.sqlite3"));
  const config = options.config || getConfig(),
    cloud = options.cloud || localCloud(path.join(root, ".private", "uploads")),
    providers = options.providers || {};
  const baseContext = () => ({
    store,
    config,
    providers,
    now: new Date().toISOString(),
    user: null,
    checkCommunityText: null,
  });
  async function context(req, url, body, res) {
    const ctx = {
      ...baseContext(),
      method: req.method,
      path: url.pathname.slice("/api/v1/".length),
      query: url.searchParams,
      body,
    };
    if (!ctx.path.startsWith("auth/")) {
      try {
        await auth.authenticate(ctx, req.headers.cookie);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        res.setHeader("Set-Cookie", auth.cookie("", true));
      }
    } else if (ctx.path === "auth/logout/")
      try {
        await auth.authenticate(ctx, req.headers.cookie);
      } catch (_) {}
    await guest.attach(ctx, req, res);
    const admins = await store.list("users", {
      where: { role: "admin", is_active: true },
      limit: 100,
    });
    ctx.config = {
      ...config,
      management: { enabled: true, adminUserIds: admins.map((x) => x.id) },
    };
    ctx.storage = files.storageFor(ctx, cloud);
    return ctx;
  }
  async function dispatch(req, res, url, body) {
    const ctx = await context(req, url, body, res);
    let result = await captcha.handle(ctx, req, res);
    if (result !== undefined) return result;
    result = await auth.handle(ctx, req, res);
    if (result !== undefined) return result;
    result = await guest.handle(ctx, req, res);
    if (result !== undefined) return result;
    result = await blog.handle(ctx);
    if (result !== undefined) return result;
    if (ctx.path === "health/" && ctx.method === "GET") {
      const capabilities = await require("./vendor/lib/recognition").status(
        ctx,
      );
      return response({
        status: "ok",
        runtime: "local-web",
        version: "web-blog-guest-20261008",
        api_version: 1,
        mode: "mixed",
        dev_auth_enabled: false,
        ...capabilities,
        features: {
          recognition: capabilities.recognition.enabled,
          assessment: capabilities.assessment.enabled,
          llm: require("./vendor/lib/llm").configFor(ctx).enabled,
        },
        optional_services: {
          weather: require("./vendor/lib/weather").configured(config),
          llm: require("./vendor/lib/llm").configFor(ctx).enabled,
          inference:
            capabilities.recognition.enabled && capabilities.assessment.enabled,
        },
      });
    }
    if (ctx.path === "web/config/" && ctx.method === "GET")
      return response({
        runtime: "local-web",
        source_commit: SOURCED_COMMIT,
        agreement_version: auth.VERSION,
        auth: { kind: "local", registration: true, captcha: "altcha", password_min_length: 1 },
        community: {
          mode: "moderated-blog",
          comments_enabled: true,
          drafts_enabled: true,
          private_feedback_enabled: true,
        },
        reminders: { channel: "local_in_app", enabled: true },
        weather: {
          enabled: require("./vendor/lib/weather").configured(config),
          monthly_limit: config.qweatherMonthlyLimit,
        },
        llm: { enabled: require("./vendor/lib/llm").configFor(ctx).enabled },
        map: {
          provider: "openstreetmap",
          source_coordinates: "GCJ02",
          points: require("./vendor/data/all-map-reference-points").locations
            .length,
        },
      });
    if (ctx.path === "web/map-config/" && ctx.method === "GET") {
      const key = String(process.env.TENCENT_MAP_JS_KEY || "").trim();
      return response({ provider: key ? "tencent" : "openstreetmap", js_key: key });
    }
    if (ctx.path === "web/site-info/" && ctx.method === "GET") {
      return response({ operator: process.env.HYHQ_OPERATOR_NAME || "", contact_email: process.env.HYHQ_CONTACT_EMAIL || "", icp: process.env.HYHQ_ICP_NUMBER || "", updated_at: "2026-10-08" });
    }
    if (ctx.path === "web/map-points/" && ctx.method === "GET") {
      const data = require("./vendor/data/all-map-reference-points");
      const points = data.locations || [];
      const region = ctx.query.get("region") || ctx.query.get("region_slug");
      const selected = region
        ? points.filter((x) => x.region_slug === region)
        : points;
      return response({ ...data, locations: selected, points: selected });
    }
    if (ctx.path.startsWith("web/legal/") && ctx.method === "GET") {
      const privacy = ctx.path.includes("privacy");
      const title = privacy ? "隐私说明" : "用户协议";
      const document = require("./data/site-legal.json");
      const sections = document[privacy ? "privacy" : "terms"].map(([heading, paragraphs]) => ({heading, body: paragraphs.join("\n\n")}));
      return response({
        title,
        version: auth.VERSION,
        sections,
        body: sections.map((s) => s.heading + "\n" + s.body).join("\n\n"),
      });
    }
    if (ctx.path === "web/uploads/" && ctx.method === "POST") {
      requireUser(ctx);
      const encoded = ctx.body.data,
        contentType = ctx.body.content_type;
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
        typeof encoded !== "string" ||
        encoded.length > Math.ceil(files.MAX / 3) * 4 ||
        !encoded ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded,
        )
      )
        throw new ApiError(
          "INVALID_UPLOAD",
          "请选择不超过 5MB 的 JPEG、PNG 或 WebP 静态图片",
        );
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > files.MAX)
        throw new ApiError("INVALID_UPLOAD", "图片超过 5MB 限制");
      const uploadCtx = {
        ...ctx,
        path: "cloud-files/uploads/",
        body: {
          purpose: ctx.body.purpose,
          size: bytes.length,
          request_id: ctx.body.request_id || uuid(),
        },
      };
      let storage = files.storageFor(uploadCtx, cloud);
      const started = await storage.handle(),
        id = started.data.data.id;
      try {
        for (
          let index = 0;
          index < Math.ceil(bytes.length / files.CHUNK);
          index++
        ) {
          uploadCtx.path = `cloud-files/uploads/${id}/chunks/${index}/`;
          uploadCtx.method = "PUT";
          uploadCtx.body = {
            data_base64: bytes
              .subarray(index * files.CHUNK, (index + 1) * files.CHUNK)
              .toString("base64"),
          };
          await storage.handle();
        }
        uploadCtx.path = `cloud-files/uploads/${id}/complete/`;
        uploadCtx.method = "POST";
        uploadCtx.body = {};
        return await storage.handle();
      } catch (e) {
        await storage.cancelUpload(ctx.user, id).catch(() => {});
        throw e;
      }
    }
    const asset = /^uploads\/([a-f0-9-]{36})\/content\/$/.exec(ctx.path);
    if (asset && ctx.method === "GET") {
      const value = await ctx.storage.readAsset(requireUser(ctx), asset[1], {
        variant: ctx.query.get("variant") || "thumbnail",
      });
      return {
        statusCode: 200,
        binary: value.bytes,
        contentType: value.mime_type,
      };
    }
    if (ctx.path === "me/") {
      if (ctx.method === "GET")
        return response(auth.publicUser(requireUser(ctx)));
      if (ctx.method === "DELETE") {
        const user = requireUser(ctx);
        await blog.purgeOwned(ctx, user);
        await accounts.purgeAccount(ctx, user);
        for (const kind of [
          "web_reminders",
          "web_reminder_days",
          "web_notifications",
        ]) {
          for (let round = 0; round < 100; round++) {
            const rows = await store.list(kind, {
              where: { owner_id: user.id },
              limit: 100,
            });
            if (!rows.length) break;
            for (const row of rows) await store.remove(kind, row.id);
          }
        }
        await store.remove("local_accounts", user.quota_key);
        res.setHeader("Set-Cookie", auth.cookie("", true));
        return response(null, 204);
      }
      result = await accounts.handle(ctx);
      if (result?.data?.data) {
        const fresh = await store.get("users", ctx.user.id);
        result.data.data = auth.publicUser(fresh);
      }
      return result;
    }
    const feedback = /^feedback\/([a-f0-9-]{36})\/$/.exec(ctx.path);
    if (feedback && ctx.method === "PATCH") {
      const user = requireUser(ctx),
        value = ctx.body.body;
      if (
        Object.keys(ctx.body).length !== 1 ||
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 1000
      )
        throw new ApiError("VALIDATION_ERROR", "反馈须为 1 至 1000 个字符");
      const row = await store.transaction(async (tx) => {
        requireUser({ user: await tx.get("users", user.id) });
        const row = await tx.get("feedback", feedback[1]);
        if (!row || row.owner_id !== user.id)
          throw new ApiError("NOT_FOUND", "反馈不存在", 404);
        if (row.status !== "pending")
          throw new ApiError("FEEDBACK_RESOLVED", "已回复反馈不能编辑", 409);
        return tx.update("feedback", row.id, {
          body: value.trim(),
          updated_at: ctx.now,
        });
      });
      return response({
        id: row.id,
        body: row.body,
        status: row.status,
        created_at: row.created_at,
        reply: "",
        resolved_at: null,
      });
    }
    for (const handler of [
      reminders.handle,
      () => ctx.storage.handle(),
      require("./vendor/lib/community").handle,
      require("./vendor/lib/management").handle,
      require("./vendor/lib/maintenance").handle,
      require("./vendor/lib/weather-booking-ai").handle,
      require("./vendor/lib/weather").handle,
      require("./vendor/lib/recognition").handle,
      require("./vendor/lib/llm").handle,
      require("./vendor/lib/activity").handle,
      require("./vendor/lib/catalog").handle,
    ]) {
      result = await handler(ctx);
      if (result !== undefined) {
        const removedJob =
          /^(recognition|assessment)-jobs\/([a-f0-9-]{36})\/$/.exec(ctx.path);
        if (
          ctx.method === "DELETE" &&
          result.statusCode === 204 &&
          removedJob
        ) {
          // Deleting the source also deletes its private conversation text.
          // The original LLM deletion path settles in-flight reservations and
          // keeps accounting records plus a tombstone against delayed workers.
          for (;;) {
            const linked = await store.list("llm_sessions", {
              where: {
                owner_id: ctx.user.id,
                source_type: removedJob[1] + "_job",
                source_id: removedJob[2],
                deleted: false,
              },
              limit: 100,
            });
            if (!linked.length) break;
            for (const session of linked) {
              try {
                await require("./vendor/lib/llm").deleteSession(
                  ctx,
                  session.id,
                );
              } catch (error) {
                if (!(error instanceof ApiError) || error.code !== "NOT_FOUND")
                  throw error;
              }
            }
          }
        }
        return result;
      }
    }
    throw new ApiError("NOT_FOUND", "接口不存在", 404);
  }
  let maintenanceRunning = false;
  async function maintenance() {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await reminders.runDue(store);
      const ctx = baseContext();
      ctx.storage = files.storageFor(ctx, cloud);
      await guest.cleanup(ctx, 10);
      await cleanupSecurity(ctx, { limit: 50 });
      const summary = await require("./vendor/lib/maintenance").runMaintenance(
        ctx,
        { limit: 20 },
      );
      if (!summary.failed)
        await store.update("maintenance_state", "global", {
          timer_verified_at: ctx.now,
          scheduler_kind: "local_interval",
        });
    } finally {
      maintenanceRunning = false;
    }
  }
  async function refreshWeather() {
    return require("./weather-refresh.cjs").runBatch(baseContext());
  }
  return { dispatch, store, config, maintenance, refreshWeather };
}
module.exports = { createBackend };
