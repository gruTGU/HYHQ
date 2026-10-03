// Domain-free WeChat container / native function transport. No fallback to HTTP or public file URLs.
const CHUNK_BYTES = 196608;
const MAX_UPLOAD = 5 * 1024 * 1024;
const MAX_DOWNLOAD = 8 * 1024 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Only fixed route words and controlled error names may reach diagnostics.
// IDs, arbitrary path segments, queries, bodies and raw SDK messages never do.
const DIAGNOSTIC_ROUTES = new Set('api v1 health regions places water-bodies stations contents routes search me auth wechat logout cloud-files uploads chunks complete download recognition-jobs assessment-jobs llm sessions turns status weather-data overview forecast favorites history checkins comments reports narrations audio content management maintenance settings privacy subscriptions capabilities'.split(' '));
const DIAGNOSTIC_ERRORS = new Set('TIMEOUT NETWORK_ERROR INVALID_RESPONSE HTTP_ERROR AUTH_REQUIRED SESSION_CHANGED CANCELLED CLOUD_CONFIG_REQUIRED CLOUD_UNAVAILABLE CLOUD_INIT_FAILED INVALID_REQUEST DAILY_LIMIT LLM_DISABLED SOURCE_UNAVAILABLE NOT_FOUND METHOD_NOT_ALLOWED VALIDATION_ERROR INTERNAL_ERROR TOO_MANY_REQUESTS RATE_LIMITED RECOGNITION_LIMIT FUNCTION_NOT_FOUND FUNCTIONS_EXECUTE_FAIL'.split(' '));
function uuid() {
  // Only an upload idempotency / local filename identifier, never an authentication token.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : ((n & 3) | 8)).toString(16);
  });
}

function createCloudClient(platform, config, session, apiError) {
  const cloud = config.cloud || {};
  const functionMode = config.transport === 'cloud-function';
  const cache = new Map();
  let initialized;
  let fs;
  let diagnosticCounter = 0;
  const originalOrigin = String(config.baseURL || '').match(/^https?:\/\/[^/?#]+/i);
  const revision = () => typeof session.revision === 'function' ? session.revision() : 0;
  const problem = (code, message) => apiError(code, message);
  const expired = () => problem('SESSION_CHANGED', '登录状态已变化，请重新操作');
  function diagnostic(method, target) {
    if (config.cloudDiagnostics !== true) return () => {};
    const started = Date.now(), request = ++diagnosticCounter;
    const safePath = target.split('?')[0].split('/').map(part => !part || DIAGNOSTIC_ROUTES.has(part) ? part : ':id').join('/');
    let recorded = false;
    return (error, phase, sdkError) => {
      if (recorded) return;
      recorded = true;
      let code = error ? (DIAGNOSTIC_ERRORS.has(error.code) ? error.code : 'UNKNOWN_ERROR') : null;
      const sdkCode = sdkError && sdkError.errCode;
      if (typeof sdkCode === 'number' && Number.isSafeInteger(sdkCode) && Math.abs(sdkCode) <= 100000000) code = 'SDK_' + sdkCode;
      const event = { local_request: request, method, path: safePath, duration_ms: Math.max(0, Date.now() - started), outcome: error ? 'error' : 'success', error_code: code, phase };
      try { if (typeof console !== 'undefined' && typeof console.info === 'function') console.info('[HYHQ cloud]', event); } catch (ignore) { /* Diagnostics must never alter request behavior. */ }
    };
  }
  function pathOf(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\s#]/.test(value) || value.startsWith('//')) throw problem('UNSAFE_FILE_URL', '接口或文件地址无效，已停止访问');
    let path = value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      if (!originalOrigin || !value.startsWith(originalOrigin[0] + '/')) throw problem('UNSAFE_FILE_URL', '文件地址与业务服务不一致，已停止下载');
      path = value.slice(originalOrigin[0].length);
    }
    if (!path.startsWith('/')) path = '/api/v1/' + path;
    const pathname = path.split('?')[0];
    if (!pathname.startsWith('/api/v1/') || /\/\/|(?:^|\/)\.{1,2}(?:\/|$)|%|[\x00-\x1f\x7f]/.test(pathname)) throw problem('UNSAFE_FILE_URL', '只允许访问本应用业务接口');
    return path;
  }
  function ready() {
    const targetConfigured = functionMode ? /^[a-z][a-z0-9_-]{0,59}$/i.test(cloud.function || '') : /^[a-z][a-z0-9-]{0,62}$/i.test(cloud.service || '');
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(cloud.env || '') || !targetConfigured) return Promise.reject(problem('CLOUD_CONFIG_REQUIRED', functionMode ? '云服务尚未配置，请填写云环境 ID 和函数名称' : '云服务尚未配置，请填写云环境 ID 和服务名称'));
    const cloudMethod = functionMode ? 'callFunction' : 'callContainer';
    if (!platform.cloud || typeof platform.cloud.init !== 'function' || typeof platform.cloud[cloudMethod] !== 'function') return Promise.reject(problem('CLOUD_UNAVAILABLE', '当前微信版本不支持云调用，请更新微信后重试'));
    if (!initialized) {
      initialized = new Promise((resolve, reject) => {
        const timeout = Math.min(Math.max(Number(config.timeout) || 15000, 1), 60000);
        const timer = setTimeout(() => reject(problem('TIMEOUT', '云服务初始化超时，请重试')), timeout);
        try {
          Promise.resolve(platform.cloud.init({ env: cloud.env, traceUser: false })).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        } catch (error) { clearTimeout(timer); reject(error); }
      }).catch((error) => { initialized = null; throw error && error.code === 'TIMEOUT' ? error : problem('CLOUD_INIT_FAILED', '云服务初始化失败，请检查小程序与云环境关联'); });
    }
    return initialized;
  }
  function fileSystem() {
    if (!fs) {
      if (!platform.getFileSystemManager || !platform.env || !platform.env.USER_DATA_PATH || typeof platform.arrayBufferToBase64 !== 'function' || typeof platform.base64ToArrayBuffer !== 'function') throw problem('FILE_UNAVAILABLE', '当前微信版本不支持私有文件缓存');
      fs = platform.getFileSystemManager();
      // Remove leftovers from the preceding launch; filenames contain no user data.
      if (fs.readdirSync && fs.unlinkSync) {
        try { fs.readdirSync(platform.env.USER_DATA_PATH).filter((name) => /^hyhq-cloud-[a-f0-9-]+\.[a-z0-9]+$/.test(name)).forEach((name) => { try { fs.unlinkSync(platform.env.USER_DATA_PATH + '/' + name); } catch (error) { /* Already gone. */ } }); } catch (error) { /* Empty or unavailable directory. */ }
      }
    }
    return fs;
  }
  function unlink(path) {
    if (!path || !fs) return;
    try { fs.unlink({ filePath: path, success() {}, fail() {} }); } catch (error) { /* Cleanup is best effort. */ }
    cache.delete(path);
  }
  function clearFiles() { Array.from(cache.keys()).forEach(unlink); }
  if (typeof session.subscribe === 'function') session.subscribe(clearFiles);
  function operation(run) {
    const context = { token: session.token(), revision: revision(), cancelled: null, pending: new Set(), invalidating: false };
    let finish;
    let unsubscribe;
    function cancel(error) {
      if (context.cancelled) return;
      context.cancelled = error;
      context.pending.forEach((abort) => abort(error));
      finish(error);
    }
    context.check = () => {
      if (context.cancelled) throw context.cancelled;
      if (session.token() !== context.token || revision() !== context.revision) throw expired();
    };
    const result = new Promise((resolve, reject) => {
      let done = false;
      finish = (error, value) => {
        if (done) return;
        done = true;
        if (unsubscribe) unsubscribe();
        error ? reject(error) : resolve(value);
      };
      if (typeof session.subscribe === 'function') unsubscribe = session.subscribe(() => { if (!context.invalidating) cancel(expired()); });
      Promise.resolve().then(() => { context.check(); return run(context); }).then((value) => {
        context.check(); finish(null, value);
      }).catch((error) => finish(error));
    });
    result.abort = () => cancel(problem('CANCELLED', '操作已取消'));
    return result;
  }
  function networkError(error) {
    if (error && error.code && error.message) return error;
    const timeout = /timeout/i.test(error && error.errMsg || '');
    return problem(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', timeout ? '请求超时，请稍后重试' : '云服务连接失败，请稍后重试');
  }
  function unwrap(response, context, cleanup) {
    if (!response || !Number.isInteger(response.statusCode)) throw problem('INVALID_RESPONSE', '云服务返回格式不正确');
    let body = response.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (error) { body = null; } }
    if (response.statusCode === 401 && !cleanup && context.token && session.token() === context.token && revision() === context.revision) {
      context.invalidating = true;
      try { session.clear(); } finally { context.invalidating = false; }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = body && body.error || {};
      throw apiError(detail.code || 'HTTP_ERROR', detail.message || '服务暂时不可用，请稍后重试', response.statusCode, body && body.request_id, detail.details);
    }
    if (response.statusCode === 204) return { data: null };
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'data')) throw problem('INVALID_RESPONSE', '接口返回格式不正确，请检查服务配置');
    return body;
  }
  async function send(path, options, context, cleanup) {
    const opts = options || {};
    const method = String(opts.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw problem('INVALID_REQUEST', '不支持此请求方法');
    let target = pathOf(path);
    let body = opts.data;
    // Explicitly encode GET data: SDKs differ in their treatment of GET bodies.
    // Weather selection, search filters and LLM scope must reach Django as query parameters.
    if (['GET', 'HEAD'].includes(method) && body !== undefined && body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) throw problem('INVALID_REQUEST', '查询参数格式不正确');
      const query = [];
      for (const key of Object.keys(body)) {
        const value = body[key];
        if (value === undefined || value === null) continue;
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw problem('INVALID_REQUEST', '查询参数必须为文字或数字');
        try { query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value))); }
        catch (error) { throw problem('INVALID_REQUEST', '查询参数编码不正确'); }
      }
      if (query.length) target = pathOf(target + (target.includes('?') ? '&' : '?') + query.join('&'));
      body = undefined;
    }
    const diagnose = diagnostic(method, target);
    try {
      if (!cleanup) context.check();
      await ready();
      if (!cleanup) context.check();
    } catch (error) {
      diagnose(error, error && error.code === 'TIMEOUT' ? 'clientDeadline' : error && error.code === 'SESSION_CHANGED' ? 'sessionChanged' : 'cloudInit');
      throw error;
    }
    // Native functions execute the claimed job inside this GET. Container mode
    // only polls a separate worker and retains its normal short request timeout.
    const executesTask = functionMode && method === 'GET' && /^\/api\/v1\/(?:llm\/turns|recognition-jobs|assessment-jobs)\/[a-f0-9-]{36}\/$/i.test(target.split('?')[0]);
    const fetchesWeather = functionMode && method === 'GET' && /^\/api\/v1\/weather-data\//.test(target);
    const defaultTimeout = executesTask ? 60000 : fetchesWeather ? 30000 : config.timeout;
    const timeout = Math.min(Math.max(Number(opts.timeout || defaultTimeout) || 15000, 1), 60000);
    return new Promise((resolve, reject) => {
      let done = false;
      let task;
      let timer;
      function settle(error, value, phase, sdkError) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        context.pending.delete(abort);
        diagnose(error, phase || 'response', sdkError);
        error ? reject(error) : resolve(value);
      }
      function abort(error, phase) {
        settle(error, undefined, phase || (error && error.code === 'SESSION_CHANGED' ? 'sessionChanged' : 'cancelled'));
        if (task && typeof task.abort === 'function') { try { task.abort(); } catch (ignore) { /* Logical cancellation already applied. */ } }
      }
      if (!cleanup) context.pending.add(abort);
      timer = setTimeout(() => abort(problem('TIMEOUT', '请求超时，请稍后重试'), 'clientDeadline'), timeout);
      function success(response) {
        if (done) return; // Late callbacks must not clear a new session or resolve a cancelled call.
        try {
          if (!cleanup) context.check();
          let result = functionMode ? response && response.result : response;
          if (functionMode && typeof result === 'string') { try { result = JSON.parse(result); } catch (error) { result = null; } }
          settle(null, unwrap(result, context, cleanup));
        } catch (error) { settle(error, undefined, error && error.code === 'SESSION_CHANGED' ? 'sessionChanged' : 'response'); }
      }
      function sdkFailure(error) { settle(networkError(error), undefined, 'SDKfailure', error); }
      const parameters = {
        config: { env: cloud.env }, path: target,
        method, data: body,
        header: Object.assign({ 'content-type': 'application/json', 'X-WX-SERVICE': cloud.service }, context.token ? { Authorization: 'Bearer ' + context.token } : {}),
        timeout, followRedirect: false, dataType: 'json', responseType: 'text',
        success, fail: sdkFailure,
      };
      try {
        if (functionMode) {
          // Cloud SDK supplies the trusted caller identity. Never send client-provided
          // openid/appid or URL redirects; only the existing business token crosses this bridge.
          task = platform.cloud.callFunction({
            name: cloud.function, config: { env: cloud.env },
            data: { method, path: target, body: body === undefined ? null : body, headers: context.token ? { Authorization: 'Bearer ' + context.token } : {} },
            success, fail: parameters.fail,
          });
        } else task = platform.cloud.callContainer(parameters);
        if (task && typeof task.then === 'function') task.then(success, sdkFailure);
      } catch (error) { sdkFailure(error); }
    });
  }
  function fileCall(method, options) {
    return new Promise((resolve, reject) => {
      try { fileSystem()[method](Object.assign({}, options, { success: resolve, fail: () => reject(problem('FILE_UNAVAILABLE', '文件读取或保存失败，请重新选择文件')) })); }
      catch (error) { reject(problem('FILE_UNAVAILABLE', '文件读取或保存失败，请重新选择文件')); }
    });
  }
  return {
    request(path, options) { return operation((context) => send(path, options, context)); },
    upload(filePath, purpose) {
      return operation(async (context) => {
        if (!context.token) throw problem('AUTH_REQUIRED', '请先登录后上传图片');
        if (purpose && !['avatar', 'recognition'].includes(purpose)) throw problem('INVALID_UPLOAD', '不支持此图片用途');
        await ready();
        const metadata = await fileCall('stat', { path: filePath });
        context.check();
        const size = metadata.stats && metadata.stats.size;
        const limit = Math.min(Number(config.maxUploadBytes) || MAX_UPLOAD, MAX_UPLOAD);
        if (!Number.isInteger(size) || size < 1 || size > limit) throw problem('FILE_TOO_LARGE', '请选择不超过 5MB 的图片');
        let uploadId;
        let fd;
        let completed = false;
        try {
          const prepared = (await send('cloud-files/uploads/', { method: 'POST', timeout: config.uploadTimeout, data: { purpose: purpose || 'recognition', size, request_id: uuid() } }, context)).data;
          if (prepared && UUID.test(prepared.id || '')) uploadId = prepared.id;
          if (!uploadId || prepared.chunk_size !== CHUNK_BYTES || prepared.total_size !== size) throw problem('INVALID_RESPONSE', '图片上传初始化结果不正确');
          context.check();
          fd = (await fileCall('open', { filePath, flag: 'r' })).fd;
          for (let offset = 0, index = 0; offset < size; offset += CHUNK_BYTES, index += 1) {
            context.check();
            const length = Math.min(CHUNK_BYTES, size - offset);
            const read = await fileCall('read', { fd, arrayBuffer: new ArrayBuffer(length), position: offset, offset: 0, length });
            context.check();
            if (read.bytesRead !== length || !read.arrayBuffer || read.arrayBuffer.byteLength !== length) throw problem('FILE_CHANGED', '图片读取不完整，请重新选择');
            const data_base64 = platform.arrayBufferToBase64(read.arrayBuffer);
            await send('cloud-files/uploads/' + uploadId + '/chunks/' + index + '/', { method: 'PUT', data: { data_base64 }, timeout: config.uploadTimeout }, context);
          }
          const asset = (await send('cloud-files/uploads/' + uploadId + '/complete/', { method: 'POST', timeout: config.uploadTimeout }, context)).data;
          context.check();
          if (!asset || !UUID.test(asset.id || '')) throw problem('INVALID_RESPONSE', '图片保存结果不正确');
          completed = true;
          return asset;
        } finally {
          if (fd !== undefined) { try { await fileCall('close', { fd }); } catch (error) { /* Best effort. */ } }
          // Never borrow a new user's token for cleanup, and never automatically retry uploads.
          if (uploadId && !completed) send('cloud-files/uploads/' + uploadId + '/', { method: 'DELETE', timeout: 5000 }, context, true).catch(() => {});
        }
      });
    },
    download(path) {
      return operation(async (context) => {
        const target = pathOf(path);
        const imagePath = /^\/api\/v1\/uploads\/([a-f0-9-]{36})\/content\/(?:\?variant=(?:thumbnail|original))?$/.exec(target);
        const audioPath = /^\/api\/v1\/narrations\/([a-f0-9-]{36})\/audio\/$/.exec(target);
        if (!(imagePath && UUID.test(imagePath[1])) && !(audioPath && UUID.test(audioPath[1]))) throw problem('UNSAFE_FILE_URL', '文件地址不是受支持的图片或讲解音频');
        if (imagePath && !context.token) throw problem('AUTH_REQUIRED', '请先登录后查看图片');
        await ready();
        fileSystem();
        let filePath;
        let total;
        let type;
        let extension;
        let offset = 0;
        try {
          while (true) {
            context.check();
            const block = (await send('cloud-files/download/?path=' + encodeURIComponent(target) + '&offset=' + offset, { timeout: config.uploadTimeout }, context)).data;
            context.check();
            if (!block || !Number.isInteger(block.total_size) || block.total_size < 1 || block.total_size > (imagePath ? MAX_UPLOAD : MAX_DOWNLOAD) || block.offset !== offset || !Number.isInteger(block.next_offset) || block.next_offset <= offset || block.next_offset > block.total_size || block.next_offset - offset > CHUNK_BYTES || block.complete !== (block.next_offset === block.total_size) || (!block.complete && block.next_offset - offset !== CHUNK_BYTES)) throw problem('INVALID_RESPONSE', '文件分片信息不完整，请重试');
            const types = imagePath ? { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } : { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' };
            if (!Object.prototype.hasOwnProperty.call(types, block.extension) || types[block.extension] !== block.content_type) throw problem('INVALID_RESPONSE', '文件格式不受支持');
            if (total !== undefined && (total !== block.total_size || type !== block.content_type || extension !== block.extension)) throw problem('INVALID_RESPONSE', '文件在下载过程中发生变化，请重试');
            total = block.total_size; type = block.content_type; extension = block.extension;
            if (typeof block.data_base64 !== 'string' || block.data_base64.length > CHUNK_BYTES * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data_base64)) throw problem('INVALID_RESPONSE', '文件分片内容无效');
            const data = platform.base64ToArrayBuffer(block.data_base64);
            if (!data || data.byteLength !== block.next_offset - offset) throw problem('INVALID_RESPONSE', '文件分片大小不正确');
            if (!filePath) filePath = platform.env.USER_DATA_PATH + '/hyhq-cloud-' + uuid() + '.' + extension;
            await fileCall(offset === 0 ? 'writeFile' : 'appendFile', { filePath, data });
            context.check();
            offset = block.next_offset;
            if (block.complete) break;
          }
          cache.set(filePath, total);
          let cached = Array.from(cache.values()).reduce((sum, bytes) => sum + bytes, 0);
          for (const [oldPath, bytes] of cache) { if (cached <= CACHE_BYTES) break; unlink(oldPath); cached -= bytes; }
          return filePath;
        } catch (error) { unlink(filePath); throw error; }
      });
    },
    clearPrivateFiles: clearFiles,
    releaseFile(path) { if (cache.has(path)) unlink(path); },
  };
}
module.exports = { createCloudClient, CHUNK_BYTES };
