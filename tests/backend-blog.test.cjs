"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { SQLiteStore } = require("../backend/store.cjs"),
  blog = require("../backend/blog.cjs");
const seed = require("../backend/vendor/data/catalog.json");
const now = "2026-10-09T10:00:00.000Z";
async function fixture() {
  const store = new SQLiteStore(":memory:");
  const users = {
    a: {
      id: "a",
      is_active: true,
      auth_kind: "local",
      role: "user",
      nickname: "作者",
      quota_key: "a",
    },
    b: {
      id: "b",
      is_active: true,
      auth_kind: "local",
      role: "user",
      quota_key: "b",
    },
    admin: {
      id: "admin",
      is_active: true,
      auth_kind: "local",
      role: "admin",
      quota_key: "admin",
    },
    guest: {
      id: "guest",
      is_active: true,
      auth_kind: "guest",
      quota_key: "guest",
    },
  };
  for (const user of Object.values(users))
    await store.set("users", user.id, user);
  const call = (path, method = "GET", body = {}, who = "a") =>
    blog.handle({
      path: "web/blog/" + path,
      method,
      body,
      user: users[who] || null,
      store,
      config: { community: { enabled: false } },
      query: new URLSearchParams(),
      now,
    });
  const query = (path, params = {}, who = null) =>
    blog.handle({
      path: "web/blog/" + path,
      method: "GET",
      body: {},
      user: users[who] || null,
      store,
      config: { community: { enabled: false } },
      query: new URLSearchParams(params),
      now,
    });
  return {
    store,
    users,
    call,
    query,
    async create() {
      return (
        await call("posts/", "POST", {
          title: "观察手记",
          body: "正文 **测试**",
          category: "plants",
        })
      ).data.data;
    },
    async publish(row) {
      row = (
        await call(`posts/${row.id}/submit/`, "POST", { version: row.version })
      ).data.data;
      return (
        await call(
          `moderation/posts/${row.id}/`,
          "POST",
          { version: row.version, action: "publish" },
          "admin",
        )
      ).data.data;
    },
  };
}
test("registered authors draft, submit and manual publish; only published safe fields enter lists and RAG", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  let p = await f.create();
  assert.equal(p.status, "draft");
  assert.equal(p.owner_id, undefined);
  await assert.rejects(
    f.call(`moderation/posts/${p.id}/`, "GET", {}, "admin"),
    (e) => e.status === 404,
  );
  assert.equal(
    (await f.query("moderation/", { kind: "posts", state: "all" }, "admin"))
      .data.data.length,
    0,
  );
  await assert.rejects(f.call(`posts/${p.id}/`), (e) => e.status === 404);
  assert.deepEqual(await blog.publishedPosts({ store: f.store }), []);
  p = await f.publish(p);
  const publicRow = (await f.call(`posts/${p.id}/`)).data.data;
  assert.equal(publicRow.body, "正文 **测试**");
  for (const k of ["owner_id", "review_note", "version", "created_day"])
    assert.equal(k in publicRow, false);
  assert.equal((await blog.publishedPosts({ store: f.store }))[0].id, p.id);
  assert.equal(await f.store.count("blog_audits", { target_id: p.id }), 3);
  const audit = (await f.call(`moderation/posts/${p.id}/`, "GET", {}, "admin"))
    .data.data.audits;
  assert.ok(
    audit.some(
      (a) => a.actor_id === "admin" && a.action === "publish" && a.after_hash,
    ),
  );
  await f.call(`posts/${p.id}/withdraw/`, "POST", { version: p.version });
  assert.deepEqual(await blog.publishedPosts({ store: f.store }), []);
});
test("guest, cross-account and non-admin cannot write or inspect private records; mass assignment rejected", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const p = await f.create();
  for (const who of ["guest", null])
    await assert.rejects(
      f.call(
        "posts/",
        "POST",
        { title: "x", body: "y", category: "water" },
        who,
      ),
      (e) => [401, 403].includes(e.status),
    );
  await assert.rejects(
    f.call(`drafts/${p.id}/`, "GET", {}, "b"),
    (e) => e.status === 404,
  );
  await assert.rejects(
    f.call(`posts/${p.id}/`, "DELETE", { version: p.version }, "b"),
    (e) => e.status === 404,
  );
  await assert.rejects(
    f.call(
      `moderation/posts/${p.id}/`,
      "POST",
      { version: 1, action: "publish" },
      "a",
    ),
    (e) => e.status === 403,
  );
  await assert.rejects(
    f.call("posts/", "POST", {
      title: "x",
      body: "y",
      category: "water",
      status: "published",
    }),
    (e) => e.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    f.call("posts/", "POST", {
      title: "x".repeat(121),
      body: "y",
      category: "water",
    }),
    (e) => e.code === "VALIDATION_ERROR",
  );
});
test("version collisions cannot overwrite new drafts and audited writes roll back atomically", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const p = await f.create();
  const results = await Promise.allSettled(
    [1, 2].map((n) =>
      f.call(`posts/${p.id}/`, "PATCH", {
        version: 1,
        title: "修改" + n,
        body: "正文",
        category: "plants",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "VERSION_CONFLICT",
  );
  const original = f.store.create.bind(f.store);
  f.store.create = async (kind, ...args) => {
    if (kind === "blog_audits") throw Error("audit unavailable");
    return original(kind, ...args);
  };
  await assert.rejects(
    f.call(`posts/${p.id}/submit/`, "POST", { version: 2 }),
    /audit unavailable/,
  );
  f.store.create = original;
  assert.equal((await f.store.get("blog_posts", p.id)).status, "draft");
  assert.equal((await f.store.get("blog_posts", p.id)).version, 2);
});
test("merged reading preserves catalog overrides and strict pagination without exposing drafts", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const original = seed.collections.contents[0];
  await f.store.set("catalog", "contents:" + original.id, {
    kind: "contents",
    value: { ...original, title: "管理员更新的标题" },
  });
  const p = await f.create();
  await f.publish(p);
  const list = await f.query("posts/", { page_size: "100" });
  assert.ok(
    list.data.data.some(
      (r) =>
        r.id === original.id &&
        r.title === "管理员更新的标题" &&
        r.origin === "catalog",
    ),
  );
  assert.ok(list.data.data.some((r) => r.id === p.id && r.origin === "blog"));
  const first = await f.query("posts/", { page_size: "1" });
  assert.match(first.data.meta.next, /page=2/);
  await assert.rejects(
    f.query("posts/", { page: "99999" }),
    (e) => e.status === 404,
  );
  await f.store.set("catalog", "contents:" + original.id, {
    kind: "contents",
    deleted: true,
    value: { id: original.id },
  });
  assert.equal(
    (await f.query("posts/", { search: "管理员更新" })).data.data.length,
    0,
  );
});
test("comments remain private until reviewed; users delete only their own; withdrawn parents hide comments", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const p = await f.publish(await f.create());
  let c = (
    await f.call(
      "comments/",
      "POST",
      {
        target_kind: "post",
        target_id: p.id,
        body: "<script>alert(1)</script> 纯文本评论",
      },
      "b",
    )
  ).data.data;
  const params = { target_kind: "post", target_id: p.id };
  assert.equal((await f.query("comments/", params)).data.data.length, 0);
  c = (
    await f.call(
      `moderation/comments/${c.id}/`,
      "POST",
      { version: c.version, action: "approve" },
      "admin",
    )
  ).data.data;
  const rows = (await f.query("comments/", params)).data.data;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, undefined);
  assert.equal(rows[0].review_note, undefined);
  await assert.rejects(
    f.call(`comments/${c.id}/`, "DELETE", { version: c.version }),
    (e) => e.status === 404,
  );
  await f.call(`posts/${p.id}/withdraw/`, "POST", { version: p.version });
  await assert.rejects(f.query("comments/", params), (e) => e.status === 404);
  await f.call(`comments/${c.id}/`, "DELETE", { version: c.version }, "b");
  assert.equal((await f.store.get("blog_comments", c.id)).body, "");
});
test("report resolution persists note and audit; removing target requires both fresh versions", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const p = await f.publish(await f.create());
  const payload = {
    target_kind: "post",
    target_id: p.id,
    reason: "资料错误",
    details: "请核对出处",
  };
  const r = (await f.call("reports/", "POST", payload, "b")).data.data;
  await assert.rejects(
    f.call("reports/", "POST", payload, "b"),
    (e) => e.code === "DUPLICATE_REPORT",
  );
  await assert.rejects(
    f.call(
      `moderation/reports/${r.id}/`,
      "POST",
      {
        version: r.version,
        action: "remove",
        note: "核对后撤下",
        target_version: 1,
      },
      "admin",
    ),
    (e) => e.code === "VERSION_CONFLICT",
  );
  await f.call(
    `moderation/reports/${r.id}/`,
    "POST",
    {
      version: r.version,
      action: "remove",
      note: "核对后撤下",
      target_version: p.version,
    },
    "admin",
  );
  assert.equal((await f.store.get("blog_posts", p.id)).status, "withdrawn");
  const mine = (await f.query("mine/", { kind: "reports" }, "b")).data.data;
  assert.equal(mine[0].review_note, "核对后撤下");
  assert.equal(mine[0].status, "resolved");
  assert.equal(
    await f.store.count("blog_audits", {
      target_id: p.id,
      action: "report_remove",
    }),
    1,
  );
});
test("deactivated authors and deleted accounts never stay in public lists; purge keeps audit hashes", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const p = await f.publish(await f.create());
  await f.store.update("users", "a", { is_active: false });
  assert.deepEqual(await blog.publishedPosts({ store: f.store }), []);
  await assert.rejects(f.call(`posts/${p.id}/`), (e) => e.status === 404);
  await blog.purgeOwned({ store: f.store }, f.users.a);
  assert.equal(await f.store.get("blog_posts", p.id), null);
  assert.equal(await f.store.count("blog_audits", { target_id: p.id }), 3);
});
test("HTTP routes complete draft, review, public read and moderated comment using isolated cookies", async (t) => {
  const f = await fixture(),
    { createServer } = require("../backend/server.cjs"),
    { sha256 } = require("../backend/vendor/lib/core");
  const server = createServer({
    store: f.store,
    cloud: {},
    timers: false,
    config: {
      appId: "test-blog",
      community: { enabled: false },
      management: { enabled: true, adminUserIds: [] },
      llmEnabled: false,
      llmGatewayEnabled: false,
      qweatherEnabled: false,
      inferenceEnabled: false,
      weatherReminders: { enabled: false },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await f.store.close();
  });
  const tokens = {
    a: "a".repeat(64),
    admin: "b".repeat(64),
    guest: "c".repeat(64),
  };
  for (const [owner, token] of Object.entries(tokens))
    await f.store.set("sessions", sha256(token), {
      owner_id: owner,
      identity_key: f.users[owner].quota_key,
      expires_at: "2099-01-01T00:00:00Z",
    });
  async function request(path, method = "GET", data, who) {
    const r = await fetch(
      "http://127.0.0.1:" + server.address().port + "/api/v1/web/blog/" + path,
      {
        method,
        headers: {
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(who ? { Cookie: "hyhq_session=" + tokens[who] } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      },
    );
    return { status: r.status, ...(r.status !== 204 ? await r.json() : {}) };
  }
  const created = await request(
    "posts/",
    "POST",
    { title: "HTTP 投稿", body: "本地审核测试", category: "green" },
    "a",
  );
  assert.equal(created.status, 201);
  let p = created.data;
  assert.equal((await request("posts/" + p.id + "/")).status, 404);
  assert.equal((await request("drafts/" + p.id + "/")).status, 401);
  p = (
    await request(
      "posts/" + p.id + "/submit/",
      "POST",
      { version: p.version },
      "a",
    )
  ).data;
  assert.equal(
    (
      await request(
        "moderation/posts/" + p.id + "/",
        "POST",
        { version: p.version, action: "publish" },
        "a",
      )
    ).status,
    403,
  );
  const approved = await request(
    "moderation/posts/" + p.id + "/",
    "POST",
    { version: p.version, action: "publish" },
    "admin",
  );
  assert.equal(approved.status, 200);
  assert.equal((await request("posts/" + p.id + "/")).data.title, "HTTP 投稿");
  const comment = { target_kind: "post", target_id: p.id, body: "讨论" };
  assert.equal(
    (await request("comments/", "POST", comment, "guest")).status,
    403,
  );
  let c = (await request("comments/", "POST", comment, "a")).data;
  assert.equal(
    (await request("comments/?target_kind=post&target_id=" + p.id)).data.length,
    0,
  );
  assert.equal(
    (
      await request(
        "moderation/comments/" + c.id + "/",
        "POST",
        { version: c.version, action: "approve" },
        "admin",
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("comments/?target_kind=post&target_id=" + p.id)).data.length,
    1,
  );
});
