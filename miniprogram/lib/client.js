/** @typedef {{code:string,message:string,status?:number,requestId?:string}} ApiError */
function apiError(code, message, status, requestId, details) {
  const error = new Error(message);
  Object.assign(error, { code, status: status || 0, requestId: requestId || '', details });
  return error;
}

/** Dependency-injected wx transport; shared by requests, uploads and private downloads. */
function createClient(platform, config, session) {
  if (config.transport === 'cloud' || config.transport === 'cloud-function') return require('./cloud-client').createCloudClient(platform, config, session, apiError);
  if (config.transport && config.transport !== 'http') throw apiError('TRANSPORT_UNSUPPORTED', '服务连接方式配置无效');
  const baseURL = config.baseURL.replace(/\/+$/, '');
  const origin = baseURL.match(/^https?:\/\/[^/]+/i);
  function endpoint(path) {
    if (typeof path !== 'string' || /[\\\s#]/.test(path) || /^\/\//.test(path) || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^https?:\/\//i.test(path))) {
      throw apiError('UNSAFE_FILE_URL', '接口或文件地址无效，已停止访问');
    }
    if (/^https?:\/\//i.test(path)) {
      if (!origin || path.indexOf(origin[0] + '/') !== 0) {
        throw apiError('UNSAFE_FILE_URL', '文件地址与业务服务不一致，已停止下载');
      }
      return path;
    }
    if (path.startsWith('/api/')) return (origin ? origin[0] : '') + path;
    return baseURL + '/' + path.replace(/^\/+/, '');
  }
  function headers() {
    return session.token() ? { Authorization: 'Bearer ' + session.token() } : {};
  }
  function invalidate(sentToken) { if (sentToken && session.token() === sentToken) session.clear(); }
  function unwrap(response, sentToken) {
    let body = response.data;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (error) { body = null; }
    }
    if (response.statusCode === 401) invalidate(sentToken);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const problem = body && body.error || {};
      throw apiError(problem.code || 'HTTP_ERROR', problem.message || '服务暂时不可用，请稍后重试', response.statusCode, body && body.request_id, problem.details);
    }
    if (response.statusCode === 204) return { data: null };
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'data')) {
      throw apiError('INVALID_RESPONSE', '接口返回格式不正确，请检查服务配置');
    }
    return body;
  }
  function networkError(error) {
    const timeout = /timeout/i.test(error && error.errMsg || '');
    return apiError(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', timeout ? '请求超时，请稍后重试' : '连接失败，请检查网络与服务地址');
  }
  return {
    request(path, options) {
      const opts = options || {};
      return new Promise((resolve, reject) => {
        let url;
        try { url = endpoint(path); } catch (error) { reject(error); return; }
        const sentToken = session.token();
        platform.request({
          url, method: opts.method || 'GET', data: opts.data,
          timeout: opts.timeout || config.timeout,
          header: Object.assign({ 'content-type': 'application/json' }, headers()),
          success(response) { try { resolve(unwrap(response, sentToken)); } catch (error) { reject(error); } },
          fail(error) { reject(networkError(error)); },
        });
      });
    },
    upload(filePath, purpose) {
      return new Promise((resolve, reject) => {
        const sentToken = session.token();
        platform.uploadFile({
          url: endpoint('uploads/'), filePath, name: 'file',
          formData: { purpose: purpose || 'recognition' },
          header: headers(), timeout: config.uploadTimeout,
          success(response) { try { resolve(unwrap(response, sentToken).data); } catch (error) { reject(error); } },
          fail(error) { reject(networkError(error)); },
        });
      });
    },
    download(path) {
      return new Promise((resolve, reject) => {
        let url;
        try { url = endpoint(path); } catch (error) { reject(error); return; }
        const sentToken = session.token();
        platform.downloadFile({
          url, header: headers(), timeout: config.uploadTimeout,
          success(response) {
            if (response.statusCode === 401) invalidate(sentToken);
            if (response.statusCode === 200) resolve(response.tempFilePath);
            else reject(apiError('FILE_UNAVAILABLE', '图片已过期或暂不可访问', response.statusCode));
          },
          fail(error) { reject(networkError(error)); },
        });
      });
    },
  };
}
module.exports = { createClient, apiError };
