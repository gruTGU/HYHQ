'use strict';
const crypto = require('node:crypto');
const { ApiError, response, requireUser, uuid, sha256 } = require('./core');
const TTL = 7 * 86400000;
function publicUser(user) {
  return { id: user.id, nickname: user.nickname, record_history: user.record_history, auth_kind: 'wechat', avatar_url: user.avatar_id ? '/api/v1/uploads/' + user.avatar_id + '/content/?variant=thumbnail' : null };
}
function identityOf(identity, config) {
  if (!config.appId || !identity || typeof identity !== 'object' || identity.APPID !== config.appId || typeof identity.OPENID !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(identity.OPENID)) throw new ApiError('CLOUD_IDENTITY_REQUIRED', '请从已关联的小程序访问', 403);
  return sha256(identity.APPID + ':' + identity.OPENID);
}
async function authenticate(ctx, headers) {
  const value = headers && (headers.Authorization || headers.authorization);
  if (!value) return;
  if (typeof value !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(value)) throw new ApiError('AUTH_REQUIRED', '登录已过期，请重新登录', 401);
  const tokenHash = sha256(value.slice(7));
  const session = await ctx.store.get('sessions', tokenHash);
  if (!session || session.identity_key !== ctx.identityKey || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.parse(ctx.now)) throw new ApiError('AUTH_REQUIRED', '登录已过期，请重新登录', 401);
  const user = await ctx.store.get('users', session.owner_id);
  if (!user || user.quota_key !== ctx.identityKey || (user.is_active !== true && !(ctx.method === 'DELETE' && ctx.path === 'me/' && user.deleting === true))) throw new ApiError('AUTH_REQUIRED', '账号不可用，请重新登录', 401);
  ctx.user = user; ctx.session = { ...session, token_hash: tokenHash };
}
async function purgeAccount(ctx, user) {
  // Deactivate before enumerating children: every private writer touches this user
  // in its transaction, so in-flight work cannot resurrect a deleted account.
  await ctx.store.transaction(async tx => {
    const current = await tx.get('users', user.id);
    if (current) await tx.update('users', user.id, { is_active: false, deleting: true, record_revision: (current.record_revision || 0) + 1 });
  });
  await require('./llm').anonymizeOwner({ ...ctx, user });
  for (const kind of ['assets', 'uploads']) {
    for (let round = 0; round < 100; round++) {
      const rows = await ctx.store.list(kind, { where: { owner_id: user.id }, limit: 100 });
      if (!rows.length) break;
      for (const row of rows) {
        if (kind === 'assets') await ctx.storage.deleteAsset(user, row.id, { deleting: true });
        else await ctx.storage.cancelUpload(user, row.id, { deleting: true });
      }
      if (round === 99) throw new ApiError('CLEANUP_PENDING', '账号已停用，资料清理中，请稍后重试', 503);
    }
  }
  for (const kind of ['favorites', 'histories', 'visits', 'feedback', 'recognition_jobs', 'assessment_jobs', 'asset_usage', 'llm_sessions', 'llm_turns', 'llm_owners', 'sessions']) {
    for (let round = 0; round < 100; round++) {
      const rows = await ctx.store.list(kind, { where: { owner_id: user.id }, limit: 100 });
      if (!rows.length) break;
      for (const row of rows) await ctx.store.remove(kind, row.id);
      if (round === 99) throw new ApiError('CLEANUP_PENDING', '账号已停用，资料清理中，请稍后重试', 503);
    }
  }
  await ctx.store.transaction(async tx => {
    const identity = await tx.get('identities', user.quota_key);
    if (identity && identity.owner_id === user.id) await tx.remove('identities', user.quota_key);
    await tx.remove('users', user.id);
  });
  // Anonymized daily budgets deliberately survive account deletion/recreation.
}
async function login(ctx) {
  if (typeof ctx.body.code !== 'string' || !ctx.body.code.length || ctx.body.code.length > 256) throw new ApiError('VALIDATION_ERROR', '微信登录凭证无效');
  const existingIdentity = await ctx.store.get('identities', ctx.identityKey);
  const existingUser = existingIdentity && await ctx.store.get('users', existingIdentity.owner_id);
  if (existingUser && existingUser.deleting) await purgeAccount(ctx, existingUser);
  const token = crypto.randomBytes(32).toString('hex'), hash = sha256(token);
  const expires = new Date(Date.parse(ctx.now) + TTL).toISOString();
  const user = await ctx.store.transaction(async tx => {
    const gate = await tx.get('auth_gates', ctx.identityKey);
    const hour = ctx.now.slice(0, 13), count = gate && gate.hour === hour ? gate.count : 0;
    if (count >= 10) throw new ApiError('RATE_LIMITED', '登录过于频繁，请稍后再试', 429);
    const binding = await tx.get('identities', ctx.identityKey);
    let user = binding && await tx.get('users', binding.owner_id);
    if (user && (user.is_active !== true || user.quota_key !== ctx.identityKey)) throw new ApiError('ACCOUNT_UNAVAILABLE', '账号资料正在清理，请稍后重试', 403);
    if (!user) {
      user = { id: uuid(), quota_key: ctx.identityKey, nickname: '', avatar_id: null, record_history: true, record_revision: 0, is_active: true, auth_kind: 'wechat', created_at: ctx.now };
      await tx.set('users', user.id, user);
      await tx.set('identities', ctx.identityKey, { id: ctx.identityKey, owner_id: user.id });
    }
    await tx.set('auth_gates', ctx.identityKey, { id: ctx.identityKey, hour, count: count + 1 });
    await tx.set('sessions', hash, { id: hash, owner_id: user.id, identity_key: ctx.identityKey, expires_at: expires, created_at: ctx.now });
    return user;
  });
  return response({ token, expires_at: expires, user: publicUser(user) });
}
async function handle(ctx) {
  if (ctx.path === 'auth/wechat/' && ctx.method === 'POST') return login(ctx);
  if (ctx.path === 'auth/dev/') throw new ApiError('DEV_AUTH_DISABLED', '云开发版不提供模拟登录', 404);
  if (ctx.path === 'auth/logout/' && ctx.method === 'POST') { requireUser(ctx); await ctx.store.remove('sessions', ctx.session.token_hash); return response(null, 204); }
  if (ctx.path !== 'me/') return;
  if (ctx.method === 'DELETE') {
    if (!ctx.user) throw new ApiError('AUTH_REQUIRED', '请先登录', 401);
    await purgeAccount(ctx, ctx.user); return response(null, 204);
  }
  requireUser(ctx);
  if (ctx.method === 'GET') return response(publicUser(ctx.user));
  if (ctx.method === 'PATCH') {
    const fields = Object.keys(ctx.body);
    if (fields.some(key => !['nickname', 'record_history', 'avatar_asset_id'].includes(key)) || ('nickname' in ctx.body && (typeof ctx.body.nickname !== 'string' || ctx.body.nickname.trim().length > 32)) || ('record_history' in ctx.body && typeof ctx.body.record_history !== 'boolean')) throw new ApiError('VALIDATION_ERROR', '个人资料参数无效');
    let oldAvatar;
    const user = await ctx.store.transaction(async tx => {
      const current = await tx.get('users', ctx.user.id); requireUser({ user: current });
      const patch = { record_revision: (current.record_revision || 0) + 1 };
      if ('nickname' in ctx.body) patch.nickname = ctx.body.nickname.trim();
      if ('record_history' in ctx.body) patch.record_history = ctx.body.record_history;
      if ('avatar_asset_id' in ctx.body) {
        const id = ctx.body.avatar_asset_id;
        if (id !== null) {
          if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new ApiError('VALIDATION_ERROR', '头像文件无效');
          const asset = await tx.get('assets', id);
          if (!asset || asset.deleting || asset.original_deleting || asset.owner_id !== current.id || asset.purpose !== 'avatar' || (asset.expires_at && asset.expires_at <= ctx.now)) throw new ApiError('VALIDATION_ERROR', '头像文件不存在或已过期');
          await tx.update('assets', id, { expires_at: null, original_expires_at: null });
        }
        oldAvatar = current.avatar_id !== id ? current.avatar_id : null; patch.avatar_id = id;
      }
      return tx.update('users', current.id, patch);
    });
    if (oldAvatar) await ctx.storage.deleteAsset(user, oldAvatar);
    return response(publicUser(user));
  }
  throw new ApiError('METHOD_NOT_ALLOWED', '不支持此操作', 405);
}
module.exports = { handle, authenticate, identityOf, publicUser, purgeAccount };
