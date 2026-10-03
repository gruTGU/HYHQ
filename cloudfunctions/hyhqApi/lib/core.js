'use strict';
const crypto = require('node:crypto');
class ApiError extends Error {
  constructor(code, message, status = 400, details) { super(message); Object.assign(this, { code, status, details }); }
}
function response(data, statusCode = 200, meta) { return { statusCode, data: { data, ...(meta ? { meta } : {}) } }; }
function requireUser(ctx) {
  if (!ctx.user || ctx.user.is_active === false) throw new ApiError('NOT_AUTHENTICATED', '请先登录', 401);
  return ctx.user;
}
function uuid() { return crypto.randomUUID(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function paginate(ctx, rows) {
  const query = ctx.query || new URLSearchParams();
  const number = (key, fallback, max) => { const raw = query.get(key); if (raw === null) return fallback; if (!/^[1-9][0-9]*$/.test(raw) || +raw > max) throw new ApiError('VALIDATION_ERROR', '分页参数无效'); return +raw; };
  const page = number('page', 1, 100000), pageSize = number('page_size', 20, 100), count = rows.length;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  if (page > totalPages) throw new ApiError('NOT_FOUND', '该分页不存在', 404);
  const link = (p) => { const params = new URLSearchParams(query); params.set('page', String(p)); params.set('page_size', String(pageSize)); return '/api/v1/' + ctx.path + '?' + params.toString(); };
  return response(rows.slice((page - 1) * pageSize, page * pageSize), 200, { count, page, page_size: pageSize, total_pages: totalPages, next: page < totalPages ? link(page + 1) : null, previous: page > 1 ? link(page - 1) : null });
}
function dateCN(now) { return new Date(new Date(now).getTime() + 8 * 3600000).toISOString().slice(0, 10); }
function equal(a, b) { const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || '')); return left.length === right.length && crypto.timingSafeEqual(left, right); }
module.exports = { ApiError, response, requireUser, uuid, sha256, paginate, dateCN, equal };
