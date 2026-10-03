'use strict';
// One physical collection, configured administrator-only before deployment.
// Logical namespaces are always injected server-side and cannot be supplied by clients.
class CloudStore {
  constructor(database, collectionName = 'hyhq_data', transactional = false) { this.db = database; this.collectionName = collectionName; this.transactional = transactional; }
  key(kind, id) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(kind) || typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(id)) throw new Error('Invalid internal document key');
    return kind + ':' + id;
  }
  data(kind, id, value) { const data = { ...value, id, _kind: kind, _logical_id: id }; delete data._id; delete data._openid; return data; }
  unpack(value) {
    if (!value) return null;
    const data = { id: value._logical_id, ...value }; delete data._id; delete data._openid; delete data._kind; delete data._logical_id; return data;
  }
  async get(kind, id) {
    const key = this.key(kind, id);
    try {
      const result = await this.db.collection(this.collectionName).doc(key).get();
      return this.unpack(Array.isArray(result.data) ? result.data[0] : result.data);
    } catch (error) {
      // wx-server-sdk 4.0.2 wraps its local not-found sentinel as this exact
      // document.get error. Never reinterpret missing collections, permission
      // errors or a transport failure as a new/empty budget or identity.
      if (error && (error.message === `document.get:fail document with _id ${key} does not exist` || error.code === 'DOCUMENT_NOT_FOUND')) return null;
      throw error;
    }
  }
  async set(kind, id, value) { await this.db.collection(this.collectionName).doc(this.key(kind, id)).set({ data: this.data(kind, id, value) }); return value; }
  async create(kind, id, value) { await this.db.collection(this.collectionName).add({ data: { ...this.data(kind, id, value), _id: this.key(kind, id) } }); return value; }
  async update(kind, id, value) {
    if (!this.transactional) return this.transaction(tx => tx.update(kind, id, value));
    const previous = await this.get(kind, id); if (!previous) { const error = new Error('DOCUMENT_NOT_FOUND'); error.code = 'DOCUMENT_NOT_FOUND'; throw error; }
    // Native SDK update recursively flattens/merges nested objects. The store
    // contract is a shallow patch: an active:{} map must really become empty.
    // Read + complete set in the same transaction preserves that contract and
    // detects concurrent updates instead of silently retaining stale entries.
    const next = { ...previous, ...value, id }; await this.set(kind, id, next); return this.unpack(this.data(kind, id, next));
  }
  async remove(kind, id) { await this.db.collection(this.collectionName).doc(this.key(kind, id)).remove(); }
  query(kind, where = {}) {
    this.key(kind, 'validation');
    if (this.transactional) throw new Error('Queries are not supported by the transaction store contract');
    if (!where || typeof where !== 'object' || Array.isArray(where) || Object.entries(where).some(([key, value]) => !/^[a-z][a-z0-9_]*$/.test(key) || (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) || (typeof value === 'number' && !Number.isFinite(value)))) throw new Error('Invalid internal equality query');
    return this.db.collection(this.collectionName).where({ ...where, _kind: kind });
  }
  async list(kind, options = {}) {
    let query = this.query(kind, options.where);
    for (const order of options.orderBy || []) { if (!/^[a-z][a-z0-9_]*$/.test(order.field) || !['asc', 'desc'].includes(order.direction)) throw new Error('Invalid internal sort'); query = query.orderBy(order.field, order.direction); }
    const limit = options.limit === undefined ? 100 : options.limit, offset = options.offset || 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid internal page');
    const result = await query.skip(offset).limit(limit).get(); return (result.data || []).map(value => this.unpack(value));
  }
  async count(kind, where = {}) { const result = await this.query(kind, where).count(); return result.total; }
  async transaction(fn) { if (this.transactional) throw new Error('Nested transactions are not supported'); return this.db.runTransaction(tx => fn(new CloudStore(tx, this.collectionName, true))); }
}
module.exports = { CloudStore };
