"use strict";
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
class SQLiteStore {
  constructor(filename) {
    if (filename !== ":memory:")
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
    if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
    this.context = new AsyncLocalStorage();
    this.pending = Promise.resolve();
  }
  key(kind, id) {
    if (
      !/^[a-z][a-z0-9_]{0,40}$/.test(kind) ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9:_-]{1,160}$/.test(id)
    )
      throw new Error("Invalid internal document key");
  }
  async locked(fn) {
    if (this.context.getStore() === this) return fn();
    const prior = this.pending;
    let done;
    this.pending = new Promise((resolve) => {
      done = resolve;
    });
    await prior;
    try {
      return await this.context.run(this, fn);
    } finally {
      done();
    }
  }
  async get(kind, id) {
    this.key(kind, id);
    return this.locked(() => {
      const row = this.db
        .prepare("SELECT value FROM documents WHERE kind=? AND id=?")
        .get(kind, id);
      return row ? JSON.parse(row.value) : null;
    });
  }
  clean(id, value) {
    const row = { ...value, id };
    for (const k of ["_id", "_openid", "_kind", "_logical_id"]) delete row[k];
    return row;
  }
  async set(kind, id, value) {
    this.key(kind, id);
    return this.locked(() => {
      const row = this.clean(id, value);
      this.db
        .prepare(
          "INSERT INTO documents(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
        )
        .run(kind, id, JSON.stringify(row));
      return row;
    });
  }
  async create(kind, id, value) {
    this.key(kind, id);
    return this.locked(() => {
      const row = this.clean(id, value);
      this.db
        .prepare("INSERT INTO documents(kind,id,value) VALUES(?,?,?)")
        .run(kind, id, JSON.stringify(row));
      return row;
    });
  }
  async update(kind, id, value) {
    this.key(kind, id);
    return this.locked(async () => {
      const prev = await this.get(kind, id);
      if (!prev)
        throw Object.assign(new Error("DOCUMENT_NOT_FOUND"), {
          code: "DOCUMENT_NOT_FOUND",
        });
      return this.set(kind, id, { ...prev, ...value });
    });
  }
  async remove(kind, id) {
    this.key(kind, id);
    return this.locked(() => {
      this.db
        .prepare("DELETE FROM documents WHERE kind=? AND id=?")
        .run(kind, id);
    });
  }
  where(kind, where = {}) {
    this.key(kind, "validation");
    if (!where || typeof where !== "object" || Array.isArray(where))
      throw new Error("Invalid internal equality query");
    const args = [kind];
    let sql = "kind=?";
    for (const [key, value] of Object.entries(where)) {
      if (
        !/^[a-z][a-z0-9_]*$/.test(key) ||
        (value !== null &&
          !["string", "number", "boolean"].includes(typeof value)) ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new Error("Invalid internal equality query");
      sql += ` AND json_extract(value,'$.${key}') IS ?`;
      args.push(typeof value === "boolean" ? +value : value);
    }
    return { sql, args };
  }
  async list(kind, options = {}) {
    const { sql, args } = this.where(kind, options.where),
      limit = options.limit === undefined ? 100 : options.limit,
      offset = options.offset || 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid internal page");
    const orders = (options.orderBy || []).map((x) => {
      if (
        !/^[a-z][a-z0-9_]*$/.test(x.field) ||
        !["asc", "desc"].includes(x.direction)
      )
        throw new Error("Invalid internal sort");
      return `json_extract(value,'$.${x.field}') ${x.direction}`;
    });
    return this.locked(() =>
      this.db
        .prepare(
          `SELECT value FROM documents WHERE ${sql}${orders.length ? " ORDER BY " + orders.join(",") : ""} LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset)
        .map((x) => JSON.parse(x.value)),
    );
  }
  async count(kind, where = {}) {
    const { sql, args } = this.where(kind, where);
    return this.locked(
      () =>
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM documents WHERE ${sql}`)
          .get(...args).n,
    );
  }
  async transaction(fn) {
    if (this.context.getStore() === this && this.db.inTransaction)
      throw new Error("Nested transactions are not supported");
    return this.locked(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this);
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    });
  }
  async close() {
    await this.locked(() => this.db.close());
  }
}
module.exports = { SQLiteStore };
