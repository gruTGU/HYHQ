'use strict';
const { ensureNative } = require('./native-runtime');
const { ApiError, response, requireUser, uuid, sha256, dateCN } = require('./core');
const CHUNK = 196608, MAX = 5 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const future = (now, seconds) => new Date(Date.parse(now) + seconds * 1000).toISOString();
function assetPublic(asset) { return { id: asset.id, purpose: asset.purpose, width: asset.width, height: asset.height, byte_size: asset.byte_size, thumbnail_url: '/api/v1/uploads/' + asset.id + '/content/?variant=thumbnail', created_at: asset.created_at, original_expires_at: asset.original_expires_at, expires_at: asset.expires_at }; }
function description(upload) { return { id: upload.id, chunk_size: CHUNK, total_size: upload.total_size, expires_at: upload.expires_at, status: upload.status }; }
function storageFor(ctx, cloud) {
  async function currentUser(user, tx = ctx.store, deleting = false) {
    const current = await tx.get('users', user.id);
    if (!current || (!deleting && !current.is_active)) throw new ApiError('AUTH_REQUIRED', '账号不可用，请重新登录', 401);
    return current;
  }
  async function deleteObjects(fileIDs) {
    if (!fileIDs.length) return;
    const cleanupId = sha256(JSON.stringify([...new Set(fileIDs)].sort()));
    // Persist the intent before storage I/O. Partial provider failures and
    // function termination retain a retryable record even after account purge.
    await ctx.store.set('storage_cleanup', cleanupId, { id: cleanupId, file_ids: [...new Set(fileIDs)], created_at: ctx.now });
    const result = await cloud.deleteFile({ fileList: fileIDs });
    if (!result || !Array.isArray(result.fileList) || fileIDs.some(id => !result.fileList.some(item => item.fileID === id && (item.status === 0 || /not.?exist|not.?found/i.test(item.errMsg || ''))))) throw new ApiError('FILE_CLEANUP_PENDING', '图片清理暂未完成，请稍后重试', 503);
    await ctx.store.remove('storage_cleanup', cleanupId);
  }
  async function release(id) {
    await ctx.store.transaction(async tx => { const gate = await tx.get('upload_gate', 'global'); if (gate && gate.active && gate.active[id]) { const active = { ...gate.active }; delete active[id]; await tx.set('upload_gate', 'global', { id: 'global', active }); } });
  }
  async function cancelUpload(user, id, options = {}) {
    const upload = await ctx.store.transaction(async tx => {
      const current = await tx.get('uploads', id); if (!current) return null;
      if (current.owner_id !== user.id) throw new ApiError('NOT_FOUND', '上传不存在', 404);
      await currentUser(user, tx, options.deleting);
      await tx.update('uploads', id, { status: 'cancelled' }); return current;
    });
    if (!upload) return;
    if (upload.pending_file_ids && upload.pending_file_ids.length) await deleteObjects(upload.pending_file_ids);
    for (let index = 0; index < Math.ceil(upload.total_size / CHUNK); index++) await ctx.store.remove('upload_chunks', id + '_' + index);
    await ctx.store.remove('uploads', id); await release(id);
  }
  async function deleteAsset(user, id, options = {}) {
    const asset = await ctx.store.transaction(async tx => {
      const asset = await tx.get('assets', id); if (!asset) return null;
      if (asset.owner_id !== user.id) throw new ApiError('NOT_FOUND', '图片不存在', 404);
      const owner = await currentUser(user, tx, options.deleting);
      // A concurrent profile change may have selected the old avatar again.
      // Marking deletion and pinning share this transaction conflict boundary.
      if (!options.deleting && asset.purpose === 'avatar' && owner.avatar_id === id) return null;
      await tx.update('assets', id, { deleting: true }); return asset;
    });
    if (!asset) return;
    await deleteObjects([asset.original_file_id, asset.thumbnail_file_id].filter(Boolean));
    await ctx.store.remove('assets', id);
  }
  async function readAsset(user, id, options = {}) {
    await currentUser(user);
    const asset = await ctx.store.get('assets', id), variant = options.variant || 'original';
    if (!['original', 'thumbnail'].includes(variant)) throw new ApiError('INVALID_VARIANT', '图片类型无效');
    if (!asset || asset.deleting || asset.owner_id !== user.id || (asset.expires_at && asset.expires_at <= ctx.now)) throw new ApiError('NOT_FOUND', '图片不存在或已过期', 404);
    if (variant === 'original' && (asset.original_deleting || !asset.original_file_id || (asset.original_expires_at && asset.original_expires_at <= ctx.now))) throw new ApiError('ASSET_EXPIRED', '原图已按保留策略清理，请重新上传', 410);
    const fileID = variant === 'thumbnail' ? asset.thumbnail_file_id : asset.original_file_id;
    if (!fileID) throw new ApiError('FILE_UNAVAILABLE', '图片文件暂不可用', 503);
    const started = Date.now();
    const result = await cloud.downloadFile({ fileID });
    const bytes = result.fileContent;
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX || !bytes.length) throw new ApiError('FILE_UNAVAILABLE', '图片文件暂不可用', 503);
    // Recheck after storage I/O, including deletion racing a download.
    await currentUser(user);
    const fresh = await ctx.store.get('assets', id);
    const finished = new Date(Date.parse(ctx.now) + Date.now() - started).toISOString();
    if (!fresh || fresh.deleting || fresh.owner_id !== user.id || (fresh.expires_at && fresh.expires_at <= finished)) throw new ApiError('NOT_FOUND', '图片已删除或已过期', 404);
    const freshId = variant === 'thumbnail' ? fresh.thumbnail_file_id : fresh.original_file_id;
    if (freshId !== fileID || (variant === 'original' && (fresh.original_deleting || (fresh.original_expires_at && fresh.original_expires_at <= finished)))) throw new ApiError('ASSET_EXPIRED', '图片已按保留策略清理', 410);
    return { bytes, mime_type: 'image/jpeg', width: asset.width, height: asset.height, expires_at: asset.expires_at, original_expires_at: asset.original_expires_at, asset: assetPublic(asset) };
  }
  async function begin(body) {
    const user = requireUser(ctx), { purpose, size, request_id: requestId } = body;
    if (!['avatar', 'recognition'].includes(purpose) || !Number.isInteger(size) || size < 1 || size > MAX || !validId(requestId)) throw new ApiError('INVALID_UPLOAD', '请选择不超过 5MB 的图片');
    const id = sha256(user.id + ':' + requestId).slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    const stale = [];
    const result = await ctx.store.transaction(async tx => {
      const current = await currentUser(user, tx), existing = await tx.get('uploads', id);
      if (existing) {
        if (existing.purpose !== purpose || existing.total_size !== size) throw new ApiError('IDEMPOTENCY_CONFLICT', '上传请求已被用于其他图片', 409);
        if (existing.expires_at <= ctx.now) throw new ApiError('UPLOAD_EXPIRED', '上传已过期，请重新选择图片', 410);
        return response(description(existing));
      }
      const gate = await tx.get('upload_gate', 'global') || { active: {} }, active = {};
      for (const [key, item] of Object.entries(gate.active || {})) { if (item.expires_at > ctx.now) active[key] = item; else stale.push({ id: key, ...item }); }
      if (Object.values(active).filter(item => item.owner_id === user.id).length >= 2 || Object.keys(active).length >= 64 || Object.values(active).reduce((sum, item) => sum + item.size, 0) + size > 64 * 1024 * 1024) throw new ApiError('UPLOAD_BUSY', '上传任务较多，请稍后重试', 429);
      const day = dateCN(ctx.now), budgetId = current.quota_key + '_' + day;
      const globalId = 'global_' + day;
      const personal = await tx.get('upload_budget', budgetId) || { bytes: 0 }, global = await tx.get('upload_budget', globalId) || { bytes: 0 };
      if (personal.bytes + size > 20 * 1024 * 1024 || global.bytes + size > 128 * 1024 * 1024) throw new ApiError('UPLOAD_BUDGET_EXCEEDED', '今日图片上传已达使用上限，请明天再试', 429);
      const upload = { id, owner_id: user.id, purpose, total_size: size, status: 'uploading', received: {}, created_at: ctx.now, expires_at: future(ctx.now, 3600), asset_id: null };
      active[id] = { owner_id: user.id, size, expires_at: upload.expires_at };
      await tx.set('upload_budget', budgetId, { id: budgetId, bytes: personal.bytes + size, day });
      await tx.set('upload_budget', globalId, { id: globalId, bytes: global.bytes + size, day });
      await tx.set('upload_gate', 'global', { id: 'global', active });
      await tx.set('uploads', id, upload);
      await tx.update('users', user.id, { record_revision: (current.record_revision || 0) + 1 });
      return response(description(upload), 201);
    });
    // Claim expired parents before deleting chunks or pending cloud objects.
    for (const old of stale) {
      const upload = await ctx.store.transaction(async tx => { const fresh = await tx.get('uploads', old.id); if (!fresh || fresh.expires_at > ctx.now) return null; await tx.update('uploads', old.id, { status: 'cancelled' }); return fresh; });
      if (upload) {
        if (upload.pending_file_ids && upload.pending_file_ids.length) await deleteObjects(upload.pending_file_ids);
        for (let i = 0; i < Math.ceil(upload.total_size / CHUNK); i++) await ctx.store.remove('upload_chunks', old.id + '_' + i);
        await ctx.store.remove('uploads', old.id);
      }
    }
    return result;
  }
  async function chunk(id, index, body) {
    const user = requireUser(ctx), encoded = body.data_base64;
    if (Object.keys(body).length !== 1 || typeof encoded !== 'string' || encoded.length > CHUNK * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new ApiError('INVALID_CHUNK', '图片分块无效');
    const bytes = Buffer.from(encoded, 'base64');
    return ctx.store.transaction(async tx => {
      const current = await currentUser(user, tx), upload = await tx.get('uploads', id);
      if (!upload || upload.owner_id !== user.id) throw new ApiError('NOT_FOUND', '上传不存在', 404);
      if (upload.expires_at <= ctx.now) throw new ApiError('UPLOAD_EXPIRED', '上传已过期', 410);
      if (upload.status !== 'uploading') throw new ApiError('UPLOAD_BUSY', '上传已在处理，请勿重复操作', 409);
      const expected = Math.min(CHUNK, upload.total_size - index * CHUNK);
      if (expected <= 0 || bytes.length !== expected) throw new ApiError('INVALID_CHUNK', '图片分块长度无效');
      const digest = sha256(bytes), old = upload.received[index];
      if (old && old !== digest) throw new ApiError('CHUNK_CONFLICT', '重复分块内容不一致', 409);
      if (!old) { await tx.set('upload_chunks', id + '_' + index, { id: id + '_' + index, owner_id: user.id, data_base64: encoded }); await tx.update('uploads', id, { received: { ...upload.received, [index]: digest } }); await tx.update('users', user.id, { record_revision: (current.record_revision || 0) + 1 }); }
      return response(description(upload));
    });
  }
  async function complete(id) {
    const user = requireUser(ctx), claim = uuid();
    const upload = await ctx.store.transaction(async tx => {
      const current = await currentUser(user, tx), value = await tx.get('uploads', id);
      if (!value || value.owner_id !== user.id) throw new ApiError('NOT_FOUND', '上传不存在', 404);
      if (value.status === 'completed') return value;
      if (value.expires_at <= ctx.now) throw new ApiError('UPLOAD_EXPIRED', '上传已过期', 410);
      if (value.status !== 'uploading') throw new ApiError('UPLOAD_BUSY', '图片正在处理或已中断，请重新选择', 409);
      if (Object.keys(value.received).length !== Math.ceil(value.total_size / CHUNK)) throw new ApiError('UPLOAD_INCOMPLETE', '图片尚未上传完整');
      await tx.update('users', user.id, { record_revision: (current.record_revision || 0) + 1 });
      return tx.update('uploads', id, { status: 'processing', claim });
    });
    if (upload.status === 'completed') { const asset = await ctx.store.get('assets', upload.asset_id); if (!asset || asset.deleting) throw new ApiError('NOT_FOUND', '图片已删除', 404); return response(assetPublic(asset)); }
    const fileIDs = []; let committed = false, publicationStarted = false, publishedAssetId = null;
    try {
      const parts = [];
      for (let index = 0; index < Math.ceil(upload.total_size / CHUNK); index++) { const part = await ctx.store.get('upload_chunks', id + '_' + index); if (!part) throw new ApiError('UPLOAD_INCOMPLETE', '图片分块已失效'); const bytes = Buffer.from(part.data_base64, 'base64'); if (sha256(bytes) !== upload.received[index]) throw new ApiError('UPLOAD_INCOMPLETE', '图片分块校验失败'); parts.push(bytes); }
      const bytes = Buffer.concat(parts);
      let original, thumbnail, info;
      await ensureNative();
      const sharp = require('sharp');
      try {
        const metadata = await sharp(bytes, { limitInputPixels: 16000000, animated: true }).metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('format');
        const normalized = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
        original = normalized.data; info = normalized.info;
        thumbnail = await sharp(original).resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      } catch (error) { throw new ApiError('INVALID_IMAGE', '请选择有效的 JPEG、PNG 或 WebP 静态图片'); }
      if (original.length > MAX) throw new ApiError('FILE_TOO_LARGE', '规范化后的图片过大，请压缩后重试');
      const assetId = uuid(), prefix = 'hyhq-private/' + user.id + '/' + assetId; publishedAssetId = assetId;
      for (const [suffix, content] of [['original.jpg', original], ['thumbnail.jpg', thumbnail]]) {
        const result = await cloud.uploadFile({ cloudPath: prefix + '/' + suffix, fileContent: content }); if (!result.fileID) throw new ApiError('FILE_UNAVAILABLE', '图片保存失败', 503); fileIDs.push(result.fileID);
        await ctx.store.transaction(async tx => { const fresh = await tx.get('uploads', id); if (!fresh || fresh.status !== 'processing' || fresh.claim !== claim) throw new ApiError('UPLOAD_CANCELLED', '上传已取消', 409); await tx.update('uploads', id, { pending_file_ids: [...fileIDs] }); });
      }
      const asset = { id: assetId, owner_id: user.id, purpose: upload.purpose, width: info.width, height: info.height, byte_size: original.length, original_file_id: fileIDs[0], thumbnail_file_id: fileIDs[1], created_at: ctx.now, original_expires_at: future(ctx.now, 86400), expires_at: future(ctx.now, upload.purpose === 'avatar' ? 86400 : 30 * 86400) };
      publicationStarted = true;
      await ctx.store.transaction(async tx => { const current = await currentUser(user, tx), fresh = await tx.get('uploads', id); if (!fresh || fresh.status !== 'processing' || fresh.claim !== claim) throw new ApiError('UPLOAD_CANCELLED', '上传已取消', 409); await tx.set('assets', assetId, asset); await tx.update('uploads', id, { status: 'completed', asset_id: assetId, pending_file_ids: [] }); await tx.update('users', user.id, { record_revision: (current.record_revision || 0) + 1 }); });
      committed = true;
      for (let i = 0; i < parts.length; i++) await ctx.store.remove('upload_chunks', id + '_' + i);
      await release(id); return response(assetPublic(asset), 201);
    } catch (error) {
      if (!committed && publicationStarted && !(error instanceof ApiError)) {
        // A lost commit response does not prove rollback. Deleting the objects
        // here could destroy a successfully published asset. Confirm durable
        // publication when possible; otherwise leave the pending manifest for
        // a later, bounded maintenance/cancellation pass after the DB recovers.
        let saved;
        try { saved = await ctx.store.get('assets', publishedAssetId); } catch (_) { throw new ApiError('UPLOAD_CONFIRMATION_PENDING', '图片保存状态暂未确认，请稍后重试', 503); }
        if (!saved || saved.owner_id !== user.id || saved.original_file_id !== fileIDs[0] || saved.thumbnail_file_id !== fileIDs[1]) throw new ApiError('UPLOAD_CONFIRMATION_PENDING', '图片保存状态暂未确认，请稍后重试', 503);
        committed = true; await currentUser(user);
        if (saved.deleting) throw new ApiError('NOT_FOUND', '图片已删除', 404);
        for (let i = 0; i < Math.ceil(upload.total_size / CHUNK); i++) await ctx.store.remove('upload_chunks', id + '_' + i);
        await release(id); return response(assetPublic(saved), 201);
      }
      if (!committed) await deleteObjects(fileIDs);
      await ctx.store.transaction(async tx => { const fresh = await tx.get('uploads', id); if (fresh && fresh.claim === claim && fresh.status === 'processing') await tx.update('uploads', id, { status: 'failed' }); });
      throw error;
    }
  }
  async function handle() {
    if (ctx.path === 'cloud-files/uploads/' && ctx.method === 'POST') return begin(ctx.body);
    let match = /^cloud-files\/uploads\/([a-f0-9-]{36})\/chunks\/(0|[1-9][0-9]{0,2})\/$/.exec(ctx.path);
    if (match && validId(match[1]) && ctx.method === 'PUT') return chunk(match[1], +match[2], ctx.body);
    match = /^cloud-files\/uploads\/([a-f0-9-]{36})\/complete\/$/.exec(ctx.path);
    if (match && validId(match[1]) && ctx.method === 'POST') return complete(match[1]);
    match = /^cloud-files\/uploads\/([a-f0-9-]{36})\/$/.exec(ctx.path);
    if (match && validId(match[1]) && ctx.method === 'DELETE') { await cancelUpload(requireUser(ctx), match[1]); return response(null, 204); }
    if (ctx.path === 'cloud-files/download/' && ctx.method === 'GET') {
      if ([...ctx.query.keys()].some(key => !['path', 'offset'].includes(key)) || ctx.query.getAll('path').length !== 1 || ctx.query.getAll('offset').length > 1) throw new ApiError('INVALID_DOWNLOAD_PATH', '下载参数无效');
      const path = ctx.query.get('path') || '', offsetValue = ctx.query.get('offset') || '0';
      match = /^\/api\/v1\/uploads\/([a-f0-9-]{36})\/content\/(?:\?variant=(thumbnail|original))?$/.exec(path);
      if (!match || !validId(match[1]) || !/^(0|[1-9][0-9]{0,8})$/.test(offsetValue)) throw new ApiError('INVALID_DOWNLOAD_PATH', '仅支持受控图片下载');
      const asset = await readAsset(requireUser(ctx), match[1], { variant: match[2] || 'thumbnail' }), offset = +offsetValue, total = asset.bytes.length;
      if (offset >= total || offset % CHUNK) throw new ApiError('INVALID_OFFSET', '下载分块位置无效', 416);
      const part = asset.bytes.subarray(offset, offset + CHUNK), next = offset + part.length;
      return response({ data_base64: part.toString('base64'), offset, next_offset: next, total_size: total, complete: next === total, content_type: 'image/jpeg', extension: 'jpg' });
    }
  }
  return { handle, readAsset, deleteAsset, cancelUpload, deleteObjects };
}
module.exports = { storageFor, assetPublic, CHUNK, MAX };
