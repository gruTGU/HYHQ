"use strict";
const {
  ApiError,
  response,
  requireUser,
  uuid,
  sha256,
  paginate,
} = require("./vendor/lib/core");
const catalog = require("./vendor/lib/catalog");
const KINDS = {
  posts: "blog_posts",
  comments: "blog_comments",
  reports: "blog_reports",
};
const STATES = {
  posts: ["pending", "published", "rejected", "withdrawn"],
  comments: ["pending", "approved", "rejected", "hidden"],
  reports: ["pending", "resolved", "dismissed"],
};
const CATEGORIES = ["plants", "water", "green", "travel"];
const PLANTS = ["", "daisy", "dandelion", "roses", "sunflowers", "tulips"];
const fail = (code, text, status = 400) => {
  throw new ApiError(code, text, status);
};
function registered(ctx) {
  const user = requireUser(ctx);
  if (user.auth_kind === "guest")
    fail("REGISTRATION_REQUIRED", "请注册或登录后参与投稿与评论", 403);
  return user;
}
async function actor(ctx, tx, admin = false) {
  const user = registered(ctx),
    fresh = await tx.get("users", user.id);
  registered({ user: fresh });
  if (fresh.deleting) fail("NOT_AUTHENTICATED", "账号正在注销", 401);
  if (fresh.quota_key !== user.quota_key)
    fail("NOT_AUTHENTICATED", "登录状态已变化，请重新登录", 401);
  if (admin && fresh.role !== "admin") fail("FORBIDDEN", "仅管理员可审核", 403);
  return fresh;
}
function text(value, name, max, optional = false) {
  if (optional && (value === undefined || value === null)) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
    (!optional && !value.trim())
  )
    fail(
      "VALIDATION_ERROR",
      `${name}须为${optional ? "0" : "1"}至${max}个字符`,
    );
  return value.trim();
}
function fields(body, allowed) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !allowed.includes(k))
  )
    fail("VALIDATION_ERROR", "请求包含不支持的字段");
}
function version(body, row) {
  if (!Number.isSafeInteger(body.version) || body.version < 1)
    fail("VERSION_REQUIRED", "请提供当前记录版本");
  if (body.version !== row.version)
    fail("VERSION_CONFLICT", "记录已被更新，请刷新并核对后再操作", 409);
}
async function all(store, kind, where = {}) {
  const rows = [];
  for (let offset = 0; offset < 20000; offset += 100) {
    const page = await store.list(kind, {
      where,
      limit: 100,
      offset,
      orderBy: [{ field: "id", direction: "asc" }],
    });
    rows.push(...page);
    if (page.length < 100) return rows;
  }
  fail("BLOG_CAPACITY", "记录量较大，请联系管理员整理", 503);
}
const ordered = (rows) =>
  rows.sort(
    (a, b) =>
      String(b.published_at || b.updated_at || b.created_at).localeCompare(
        String(a.published_at || a.updated_at || a.created_at),
      ) || a.id.localeCompare(b.id),
  );
function publicPost(row) {
  return Object.fromEntries(
    [
      "id",
      "title",
      "summary",
      "body",
      "category",
      "region",
      "place",
      "plant_label",
      "source",
      "author_name",
      "published_at",
      "updated_at",
      "is_demo",
      "origin",
    ].map((k) => [
      k,
      row[k] ?? (k === "is_demo" ? false : k === "origin" ? "blog" : ""),
    ]),
  );
}
function ownView(row) {
  const out = { ...row };
  delete out.owner_id;
  delete out.created_day;
  return out;
}
async function active(store, owner) {
  const u = await store.get("users", owner);
  return u && u.is_active === true && !u.deleting && u.auth_kind !== "guest";
}
async function publishedPosts(ctx) {
  if (ctx.store.locked && !ctx._blogReadLocked)
    return ctx.store.locked(() =>
      publishedPosts({ ...ctx, _blogReadLocked: true }),
    );
  const rows = await all(ctx.store, KINDS.posts, { status: "published" }),
    owners = new Map();
  for (const row of rows)
    if (!owners.has(row.owner_id))
      owners.set(row.owner_id, await active(ctx.store, row.owner_id));
  return ordered(
    rows.filter((row) => owners.get(row.owner_id)).map(publicPost),
  );
}
async function target(ctx, kind, id, tx = ctx.store, publicOnly = true) {
  if (typeof id !== "string" || !catalog.UUID.test(id))
    fail("VALIDATION_ERROR", "目标编号无效");
  if (kind === "content") {
    const data = await catalog.loadCatalog({
      ...ctx,
      store: tx,
      _publicCatalogPromise: null,
    });
    const row = data.contents.find((r) => r.id === id);
    if (!row) fail("NOT_FOUND", "公开资料已不可用", 404);
    return { ...catalog.pick("contents", row), target_kind: "content" };
  }
  if (!["post", "comment"].includes(kind))
    fail("VALIDATION_ERROR", "目标类型无效");
  const row = await tx.get(kind === "post" ? KINDS.posts : KINDS.comments, id);
  if (
    !row ||
    row.status === "deleted" ||
    !(await active(tx, row.owner_id)) ||
    (publicOnly && row.status !== (kind === "post" ? "published" : "approved"))
  )
    fail("NOT_FOUND", "内容已不可用", 404);
  if (kind === "comment" && publicOnly)
    await target(ctx, row.target_kind, row.target_id, tx);
  return row;
}
async function audit(ctx, tx, user, kind, before, after, action, note = "") {
  const id = uuid();
  await tx.create("blog_audits", id, {
    id,
    actor_id: user.id,
    target_kind: kind,
    target_id: after.id,
    action,
    note,
    from_status: before?.status || null,
    to_status: after.status,
    from_version: before?.version || null,
    to_version: after.version,
    before_hash: before ? sha256(JSON.stringify(before)) : null,
    after_hash: sha256(JSON.stringify(after)),
    created_at: ctx.now,
  });
}
async function rate(ctx, tx, user, kind, max) {
  const n = await tx.count(kind, {
    owner_id: user.id,
    created_day: ctx.now.slice(0, 10),
  });
  if (n >= max) fail("RATE_LIMITED", "今日提交较多，请明天再试", 429);
}
async function postFields(ctx, tx, body) {
  const value = {
    title: text(body.title, "标题", 120),
    summary: text(body.summary, "摘要", 400, true),
    body: text(body.body, "正文", 40000),
    category: body.category,
    region: text(body.region, "区域", 100, true),
    place: text(body.place, "地点", 100, true),
    plant_label: body.plant_label || "",
    source: text(body.source, "资料出处", 500, true),
  };
  if (
    !CATEGORIES.includes(value.category) ||
    !PLANTS.includes(value.plant_label)
  )
    fail("VALIDATION_ERROR", "分类或植物标签无效");
  const data = await catalog.loadCatalog({
    ...ctx,
    store: tx,
    _publicCatalogPromise: null,
  });
  if (value.region) {
    const region = data.regions.find(
      (r) => r.id === value.region || r.slug === value.region,
    );
    if (!region) fail("VALIDATION_ERROR", "请选择有效区域");
    value.region = region.id;
  }
  if (value.place) {
    const place = data.places.find((p) => p.id === value.place);
    if (!place || (value.region && place.region !== value.region))
      fail("VALIDATION_ERROR", "地点与区域不匹配");
    value.region = place.region;
  }
  if (!value.summary)
    value.summary = value.body.replace(/[#*_>`~\[\]]/g, "").slice(0, 200);
  return value;
}
async function owned(ctx, tx, kind, id, user) {
  const row = await tx.get(KINDS[kind], id);
  if (!row || row.owner_id !== user.id || row.status === "deleted")
    fail("NOT_FOUND", "本人记录不存在", 404);
  return row;
}
async function change(ctx, kind, id, action) {
  return ctx.store.transaction(async (tx) => {
    const user = await actor(ctx, tx),
      before = await owned(ctx, tx, kind, id, user);
    version(ctx.body, before);
    let patch;
    if (action === "delete") {
      fields(ctx.body, ["version"]);
      patch = {
        status: "deleted",
        body: "",
        title: "",
        summary: "",
        source: "",
        review_note: "",
      };
    } else if (action === "edit") {
      fields(ctx.body, [
        "version",
        "title",
        "summary",
        "body",
        "category",
        "region",
        "place",
        "plant_label",
        "source",
      ]);
      if (!["draft", "rejected", "withdrawn"].includes(before.status))
        fail("STATE_CONFLICT", "请先撤回文章，再编辑并重新送审", 409);
      patch = {
        ...(await postFields(ctx, tx, ctx.body)),
        status: "draft",
        review_note: "",
        published_at: null,
      };
    } else if (action === "submit") {
      fields(ctx.body, ["version"]);
      if (!["draft", "rejected", "withdrawn"].includes(before.status))
        fail("STATE_CONFLICT", "当前状态不能送审", 409);
      // Validate associations again: an old draft may reference a removed place.
      await postFields(ctx, tx, before);
      patch = {
        status: "pending",
        submitted_at: ctx.now,
        review_note: "",
        author_name: user.nickname || "自然记录者",
      };
    } else {
      fields(ctx.body, ["version"]);
      if (!["pending", "published"].includes(before.status))
        fail("STATE_CONFLICT", "当前状态无需撤回", 409);
      patch = { status: "draft", published_at: null, review_note: "" };
    }
    const after = await tx.update(KINDS[kind], id, {
      ...patch,
      updated_at: ctx.now,
      version: before.version + 1,
    });
    await audit(ctx, tx, user, kind, before, after, action);
    return response(ownView(after), action === "delete" ? 204 : 200);
  });
}
async function moderation(ctx, kind, id) {
  return ctx.store.transaction(async (tx) => {
    const user = await actor(ctx, tx, true),
      before = await tx.get(KINDS[kind], id);
    if (
      !before ||
      before.status === "deleted" ||
      (kind === "posts" && before.status === "draft")
    )
      fail("NOT_FOUND", "审核记录不存在", 404);
    if (ctx.method === "GET") {
      const audits = ordered(
        await all(tx, "blog_audits", { target_kind: kind, target_id: id }),
      );
      let related = null;
      if (kind === "reports") {
        try {
          related = await target(
            ctx,
            before.target_kind,
            before.target_id,
            tx,
            false,
          );
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      return response({
        ...before,
        audits,
        ...(kind === "reports" ? { target: related } : {}),
      });
    }
    if (ctx.method !== "POST") fail("METHOD_NOT_ALLOWED", "不支持此操作", 405);
    fields(ctx.body, ["version", "action", "note", "target_version"]);
    version(ctx.body, before);
    const action = ctx.body.action,
      note = text(
        ctx.body.note,
        "审核说明",
        1000,
        ![
          "reject",
          "unpublish",
          "hide",
          "resolve",
          "dismiss",
          "remove",
        ].includes(action),
      );
    let status;
    if (kind === "posts") {
      if (action === "publish" && before.status === "pending") {
        if (!(await active(tx, before.owner_id)))
          fail("STATE_CONFLICT", "作者账号已不可用", 409);
        await postFields(ctx, tx, before);
        status = "published";
      } else if (action === "reject" && before.status === "pending")
        status = "rejected";
      else if (action === "unpublish" && before.status === "published")
        status = "withdrawn";
    } else if (kind === "comments") {
      if (action === "approve" && before.status === "pending") {
        await target(ctx, before.target_kind, before.target_id, tx);
        if (!(await active(tx, before.owner_id)))
          fail("STATE_CONFLICT", "作者账号已不可用", 409);
        status = "approved";
      } else if (action === "reject" && before.status === "pending")
        status = "rejected";
      else if (action === "hide" && before.status === "approved")
        status = "hidden";
    } else if (
      before.status === "pending" &&
      ["resolve", "dismiss", "remove"].includes(action)
    ) {
      status = action === "dismiss" ? "dismissed" : "resolved";
      if (action === "remove") {
        if (before.target_kind === "content")
          fail("VALIDATION_ERROR", "原有资料请在资料管理中处理后填写举报结论");
        const related = await target(
          ctx,
          before.target_kind,
          before.target_id,
          tx,
          false,
        );
        version({ version: ctx.body.target_version }, related);
        const rk = before.target_kind === "post" ? "posts" : "comments";
        const removed = await tx.update(KINDS[rk], related.id, {
          status: rk === "posts" ? "withdrawn" : "hidden",
          review_note: note,
          version: related.version + 1,
          updated_at: ctx.now,
        });
        await audit(ctx, tx, user, rk, related, removed, "report_remove", note);
      }
    }
    if (!status) fail("STATE_CONFLICT", "此状态不支持所选审核操作", 409);
    const after = await tx.update(KINDS[kind], id, {
      status,
      review_note: note,
      reviewed_at: ctx.now,
      updated_at: ctx.now,
      version: before.version + 1,
      ...(kind === "posts"
        ? { published_at: status === "published" ? ctx.now : null }
        : {}),
    });
    await audit(ctx, tx, user, kind, before, after, action, note);
    return response(ownView(after));
  });
}
async function purgeOwned(ctx, user) {
  await ctx.store.transaction(async (tx) => {
    for (const kind of Object.values(KINDS))
      for (const row of await all(tx, kind, { owner_id: user.id }))
        await tx.remove(kind, row.id);
  });
}
async function handle(ctx) {
  if (!ctx.path.startsWith("web/blog/")) return;
  if (ctx.method === "GET" && ctx.store.locked && !ctx._blogReadLocked)
    return ctx.store.locked(() => handle({ ...ctx, _blogReadLocked: true }));
  ctx.query ||= new URLSearchParams();
  ctx.body ||= {};
  for (const k of ctx.query.keys())
    if (ctx.query.getAll(k).length > 1)
      fail("VALIDATION_ERROR", "参数不能重复");
  const path = ctx.path.slice("web/blog/".length),
    method = ctx.method;
  if (path === "posts/" && method === "GET") {
    const data = await catalog.loadCatalog(ctx),
      params = ctx.query;
    const region = params.get("region"),
      found =
        region &&
        data.regions.find((r) => r.id === region || r.slug === region);
    if (region && !found) fail("VALIDATION_ERROR", "区域不存在");
    const search = text(
      params.get("search") || "",
      "搜索",
      100,
      true,
    ).toLowerCase();
    const rows = [
      ...data.contents.map((row) => ({
        ...catalog.pick("contents", row),
        origin: "catalog",
        region:
          row.place_summary?.region ||
          data.places.find((p) => p.id === row.place)?.region ||
          "",
      })),
      ...(await publishedPosts(ctx)),
    ];
    const selected = rows.filter(
      (row) =>
        (!found || !row.region || row.region === found.id) &&
        (!params.get("category") || row.category === params.get("category")) &&
        (!params.get("plant_label") ||
          row.plant_label === params.get("plant_label")) &&
        (!params.get("place") || row.place === params.get("place")) &&
        (!search ||
          [row.title, row.summary, row.author_name]
            .join(" ")
            .toLowerCase()
            .includes(search)),
    );
    return paginate(
      ctx,
      ordered(selected).map(({ body, ...row }) => row),
    );
  }
  if (path === "posts/" && method === "POST") {
    fields(ctx.body, [
      "title",
      "summary",
      "body",
      "category",
      "region",
      "place",
      "plant_label",
      "source",
    ]);
    return ctx.store.transaction(async (tx) => {
      const user = await actor(ctx, tx);
      await rate(ctx, tx, user, KINDS.posts, 20);
      const value = await postFields(ctx, tx, ctx.body),
        id = uuid();
      const row = await tx.create(KINDS.posts, id, {
        ...value,
        id,
        owner_id: user.id,
        author_name: user.nickname || "自然记录者",
        origin: "blog",
        is_demo: false,
        status: "draft",
        version: 1,
        created_at: ctx.now,
        updated_at: ctx.now,
        created_day: ctx.now.slice(0, 10),
        published_at: null,
        review_note: "",
      });
      await audit(ctx, tx, user, "posts", null, row, "create");
      return response(ownView(row), 201);
    });
  }
  const post = /^posts\/([a-f0-9-]{36})\/(?:(submit|withdraw)\/)?$/.exec(path);
  if (post) {
    if (!post[2] && method === "GET")
      return response(publicPost(await target(ctx, "post", post[1])));
    if (post[2] && method === "POST")
      return change(ctx, "posts", post[1], post[2]);
    if (!post[2] && ["PATCH", "DELETE"].includes(method))
      return change(
        ctx,
        "posts",
        post[1],
        method === "PATCH" ? "edit" : "delete",
      );
  }
  const draft = /^drafts\/([a-f0-9-]{36})\/$/.exec(path);
  if (draft && method === "GET")
    return ctx.store.transaction(async (tx) =>
      response(
        ownView(await owned(ctx, tx, "posts", draft[1], await actor(ctx, tx))),
      ),
    );
  if (path === "mine/" && method === "GET") {
    const kind = ctx.query.get("kind") || "posts";
    if (!KINDS[kind]) fail("VALIDATION_ERROR", "记录类型无效");
    return ctx.store.transaction(async (tx) => {
      const user = await actor(ctx, tx);
      return paginate(
        ctx,
        ordered(
          (await all(tx, KINDS[kind], { owner_id: user.id })).filter(
            (r) => r.status !== "deleted",
          ),
        ).map(ownView),
      );
    });
  }
  if (path === "comments/" && method === "GET") {
    const kind = ctx.query.get("target_kind"),
      id = ctx.query.get("target_id");
    if (!["content", "post"].includes(kind))
      fail("VALIDATION_ERROR", "评论目标无效");
    await target(ctx, kind, id);
    const rows = await all(ctx.store, KINDS.comments, {
        target_kind: kind,
        target_id: id,
        status: "approved",
      }),
      visible = [];
    for (const row of rows)
      if (await active(ctx.store, row.owner_id))
        visible.push({
          id: row.id,
          body: row.body,
          author_name: row.author_name,
          created_at: row.created_at,
          owned: !!ctx.user && ctx.user.id === row.owner_id,
          version: ctx.user?.id === row.owner_id ? row.version : undefined,
        });
    return paginate(ctx, ordered(visible));
  }
  if (path === "comments/" && method === "POST") {
    fields(ctx.body, ["target_kind", "target_id", "body"]);
    const { target_kind: kind, target_id: id } = ctx.body;
    if (!["content", "post"].includes(kind))
      fail("VALIDATION_ERROR", "评论目标无效");
    const body = text(ctx.body.body, "评论", 2000);
    return ctx.store.transaction(async (tx) => {
      const user = await actor(ctx, tx);
      await target(ctx, kind, id, tx);
      await rate(ctx, tx, user, KINDS.comments, 50);
      const rid = uuid();
      const row = await tx.create(KINDS.comments, rid, {
        id: rid,
        owner_id: user.id,
        author_name: user.nickname || "自然记录者",
        target_kind: kind,
        target_id: id,
        body,
        status: "pending",
        version: 1,
        review_note: "",
        created_at: ctx.now,
        updated_at: ctx.now,
        created_day: ctx.now.slice(0, 10),
      });
      await audit(ctx, tx, user, "comments", null, row, "submit");
      return response(ownView(row), 201);
    });
  }
  const comment = /^comments\/([a-f0-9-]{36})\/$/.exec(path);
  if (comment && method === "DELETE")
    return change(ctx, "comments", comment[1], "delete");
  if (path === "reports/" && method === "POST") {
    fields(ctx.body, ["target_kind", "target_id", "reason", "details"]);
    const { target_kind: kind, target_id: id } = ctx.body,
      reason = text(ctx.body.reason, "举报原因", 100),
      details = text(ctx.body.details, "补充说明", 2000, true);
    return ctx.store.transaction(async (tx) => {
      const user = await actor(ctx, tx);
      await target(ctx, kind, id, tx);
      await rate(ctx, tx, user, KINDS.reports, 20);
      if (
        await tx.count(KINDS.reports, {
          owner_id: user.id,
          target_kind: kind,
          target_id: id,
          status: "pending",
        })
      )
        fail("DUPLICATE_REPORT", "你已举报此内容，请等待处理", 409);
      const rid = uuid(),
        row = await tx.create(KINDS.reports, rid, {
          id: rid,
          owner_id: user.id,
          target_kind: kind,
          target_id: id,
          reason,
          details,
          status: "pending",
          version: 1,
          review_note: "",
          created_at: ctx.now,
          updated_at: ctx.now,
          created_day: ctx.now.slice(0, 10),
        });
      await audit(ctx, tx, user, "reports", null, row, "submit");
      return response(ownView(row), 201);
    });
  }
  if (path === "moderation/" && method === "GET") {
    const kind = ctx.query.get("kind") || "posts",
      state = ctx.query.get("state") || "pending";
    if (!KINDS[kind] || (state !== "all" && !STATES[kind].includes(state)))
      fail("VALIDATION_ERROR", "审核筛选无效");
    return ctx.store.transaction(async (tx) => {
      await actor(ctx, tx, true);
      return paginate(
        ctx,
        ordered(
          (
            await all(tx, KINDS[kind], state === "all" ? {} : { status: state })
          ).filter(
            (r) =>
              r.status !== "deleted" &&
              (kind !== "posts" || r.status !== "draft"),
          ),
        ),
      );
    });
  }
  const review =
    /^moderation\/(posts|comments|reports)\/([a-f0-9-]{36})\/$/.exec(path);
  if (review) return moderation(ctx, review[1], review[2]);
  fail("NOT_FOUND", "博客接口不存在", 404);
}
module.exports = { handle, publishedPosts, purgeOwned };
