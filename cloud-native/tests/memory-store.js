'use strict';
const clone = value => value === undefined ? undefined : structuredClone(value);
class MemoryStore {
  constructor(data = new Map()) { this.data = data; this.tail = Promise.resolve(); }
  key(kind, id) { return kind + ':' + id; }
  async get(kind, id) { return clone(this.data.get(this.key(kind, id)) || null); }
  async set(kind, id, value) { this.data.set(this.key(kind, id), clone(value)); return clone(value); }
  async create(kind, id, value) { if (this.data.has(this.key(kind, id))) throw new Error('DOCUMENT_EXISTS'); return this.set(kind, id, value); }
  async update(kind, id, value) { const old = await this.get(kind, id); if (!old) throw new Error('DOCUMENT_NOT_FOUND'); return this.set(kind, id, { ...old, ...value }); }
  async remove(kind, id) { this.data.delete(this.key(kind, id)); }
  async list(kind, options = {}) {
    const prefix = kind + ':';
    let rows = [...this.data].filter(([key]) => key.startsWith(prefix)).map(([, value]) => clone(value));
    for (const [field, value] of Object.entries(options.where || {})) rows = rows.filter(row => row[field] === value);
    for (const { field, direction } of [...(options.orderBy || [])].reverse()) rows.sort((a, b) => (a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1) * (direction === 'desc' ? -1 : 1));
    return rows.slice(options.offset || 0, (options.offset || 0) + (options.limit === undefined ? 100 : options.limit));
  }
  async count(kind, where = {}) { return (await this.list(kind, { where, limit: 100000 })).length; }
  async transaction(fn) {
    const pending = this.tail.then(async () => {
      const next = new MemoryStore(new Map([...this.data].map(([key, value]) => [key, clone(value)])));
      const result = await fn(next); this.data = next.data; return result;
    });
    this.tail = pending.catch(() => {}); return pending;
  }
}
module.exports = { MemoryStore };
