"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { SQLiteStore } = require("../backend/store.cjs");
const { handle } = require("../backend/reminders.cjs");

const factory = () => import("../frontend/src/lib/notification-unread.js");
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("unread badge filters before paging, excludes other users, and tracks read/deletion", async () => {
  const store = new SQLiteStore(":memory:");
  const user = { id: "owner-a", is_active: true };
  const ctx = (query = "", extra = {}) => ({
    store,
    user,
    method: "GET",
    path: "web/notifications/",
    query: new URLSearchParams(query),
    now: "2026-10-08T00:00:00Z",
    ...extra,
  });
  try {
    const unreadId = randomUUID(),
      otherId = randomUUID();
    await store.set("web_notifications", unreadId, {
      owner_id: user.id,
      read: false,
      created_at: "2025-01-01",
    });
    await store.set("web_notifications", otherId, {
      owner_id: "owner-b",
      read: false,
      created_at: "2026-10-08",
    });
    for (let n = 0; n < 101; n++)
      await store.set("web_notifications", randomUUID(), {
        owner_id: user.id,
        read: true,
        created_at: "2026-10-07",
      });
    const unread = await handle(ctx("read=false&page_size=1"));
    assert.deepEqual(
      unread.data.data.map((row) => row.id),
      [unreadId],
    );
    assert.equal(unread.data.data[0].owner_id, undefined);
    const read = await handle(ctx("read=true&page_size=1"));
    assert.equal(read.data.data[0].read, true);
    await assert.rejects(handle(ctx("read=no")), { code: "VALIDATION_ERROR" });
    await assert.rejects(handle(ctx("read=false", { user: null })), {
      status: 401,
    });
    await assert.rejects(
      handle(
        ctx("", { method: "POST", path: `web/notifications/${otherId}/read/` }),
      ),
      { status: 404 },
    );
    await handle(
      ctx("", { method: "POST", path: `web/notifications/${unreadId}/read/` }),
    );
    assert.equal(
      (await handle(ctx("read=false&page_size=1"))).data.data.length,
      0,
    );
    await store.update("web_notifications", unreadId, { read: false });
    await handle(
      ctx("", { method: "DELETE", path: `web/notifications/${unreadId}/` }),
    );
    assert.equal(
      (await handle(ctx("read=false&page_size=1"))).data.data.length,
      0,
    );
    assert.ok(await store.get("web_notifications", otherId));
  } finally {
    await store.close();
  }
});

test("shared unread cache deduplicates refreshes and throttles ordinary navigation", async () => {
  const { createUnreadStore } = await factory();
  const response = deferred();
  let calls = 0,
    now = 100;
  const state = createUnreadStore(
    () => {
      calls++;
      return response.promise;
    },
    { now: () => now },
  );
  state.setOwner("user-a");
  const first = state.refresh();
  const second = state.refresh();
  assert.strictEqual(first, second);
  response.resolve(true);
  await first;
  assert.equal(calls, 1);
  assert.equal(state.getSnapshot().unread, true);
  now += 59999;
  await state.refresh();
  assert.equal(calls, 1);
  now++;
  await state.refresh();
  assert.equal(calls, 2);
});

test("logout and account changes discard late unread replies from the previous account", async () => {
  const { createUnreadStore } = await factory();
  const old = deferred(),
    fresh = deferred();
  let calls = 0;
  const state = createUnreadStore(() =>
    ++calls === 1 ? old.promise : fresh.promise,
  );
  state.setOwner("user-a");
  const pending = state.refresh();
  await Promise.resolve();
  state.setOwner("");
  assert.deepEqual(state.getSnapshot(), { owner: "", unread: false });
  state.setOwner("user-b");
  const next = state.refresh();
  old.resolve(true);
  await pending;
  assert.deepEqual(state.getSnapshot(), { owner: "user-b", unread: false });
  fresh.resolve(false);
  await next;
  assert.equal(state.getSnapshot().unread, false);
});

test("reading a notification forces fresh state and older in-flight replies cannot restore the dot", async () => {
  const { createUnreadStore } = await factory();
  const old = deferred(),
    fresh = deferred();
  let calls = 0;
  const state = createUnreadStore(() =>
    ++calls === 1 ? old.promise : fresh.promise,
  );
  state.setOwner("user-a");
  const pending = state.refresh();
  await Promise.resolve();
  const next = state.refresh({ force: true });
  fresh.resolve(false);
  await next;
  old.resolve(true);
  await pending;
  assert.equal(state.getSnapshot().unread, false);
});

test("failed unread refresh preserves the last result and does not cause repeated requests", async () => {
  const { createUnreadStore } = await factory();
  let calls = 0;
  const state = createUnreadStore(() => {
    if (++calls === 1) return true;
    throw Error("offline");
  });
  state.setOwner("user-a");
  await state.refresh();
  await state.refresh({ force: true });
  assert.equal(state.getSnapshot().unread, true);
  await state.refresh();
  assert.equal(calls, 2);
});
