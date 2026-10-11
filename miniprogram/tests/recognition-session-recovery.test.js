const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../lib/session');

function setup(kind) {
  const storage = new Map(), media = [], calls = [], notices = [];
  const session = createSession({ getStorageSync: key => storage.get(key), setStorageSync: (key, val) => storage.set(key, val), removeStorageSync: key => storage.delete(key) });
  session.save({ token: 'token-a', user: { id: 'user-a' } });
  const jobsPath = kind === 'flower' ? 'recognition-jobs/' : 'assessment-jobs/';
  const app = { session, globalData: {}, config: { maxUploadBytes: 5 * 1024 * 1024 }, api: {
    request: async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET', data: opts.data });
      if (path === 'health/') return { data: { recognition: { enabled: true }, assessment: { enabled: true } } };
      if (opts.method === 'POST') return { data: { id: 'new-job', status: 'queued', asset_id: opts.data.asset_id } };
      return { data: [] };
    },
    upload: async path => { calls.push({ upload: path }); return { id: 'new-asset' }; },
  } };
  global.getApp = () => app;
  global.wx = { chooseMedia: opts => media.push(opts), showToast: opts => notices.push(opts.title), showModal: opts => notices.push(opts.content), stopPullDownRefresh() {} };
  let definition;
  global.Page = value => { definition = value; };
  const file = require.resolve('../pages/' + (kind === 'flower' ? 'recognize' : 'assessment') + '/index');
  delete require.cache[file]; require(file);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); }, poll: async () => {} };
  const choose = () => { page.choose(); media.at(-1).success({ tempFiles: [{ tempFilePath: '/local/chosen.jpg', size: 1000 }] }); };
  return { app, page, calls, notices, media, choose, jobsPath };
}

for (const kind of ['flower', 'river']) {
  test(kind + ': upload expiry keeps only the chosen local photo and allows same-account re-login/retry', async () => {
    const f = setup(kind); await f.page.onShow(); f.choose();
    f.page.data.jobs = [{ id: 'private-history' }]; f.page.data.location = { latitude: 39, longitude: 117 };
    const goodUpload = f.app.api.upload;
    f.app.api.upload = async () => { f.app.session.clear('expired'); throw Object.assign(new Error('expired'), { status: 401 }); };
    await f.page.submit();
    assert.equal(f.page.data.imagePath, '/local/chosen.jpg');
    assert.equal(f.page.data.imageOrigin, 'selected');
    assert.equal(f.page.data.busy, false); assert.equal(f.page.data.loggedIn, false);
    assert.match(f.page.data.authNotice, /重新登录/); assert.match(f.page.data.authNotice, /照片已保留/);
    assert.deepEqual(f.page.data.jobs, []); assert.equal(f.page.data.task, null);
    if (kind === 'river') assert.equal(f.page.data.location, null);
    assert.equal(f.calls.some(item => item.method === 'POST'), false);
    f.page.onHide(); await f.page.onShow();
    assert.equal(f.page.data.imagePath, '/local/chosen.jpg');
    f.page.onHide(); f.app.session.save({ token: 'token-a-new', user: { id: 'user-a' } }); await f.page.onShow();
    assert.equal(f.page.data.imagePath, '/local/chosen.jpg'); assert.equal(f.page.data.authNotice, '');
    f.app.api.upload = goodUpload; await f.page.submit();
    assert.equal(f.page.data.task.id, 'new-job'); assert.equal(f.page.data.busy, false);
    assert.equal(f.calls.filter(item => item.path === f.jobsPath && item.method === 'POST').length, 1);
  });

  test(kind + ': expiry after file upload does not create a duplicate job and permits an explicit fresh retry', async () => {
    const f = setup(kind); await f.page.onShow(); f.choose();
    const request = f.app.api.request;
    let rejectedCreates = 0;
    f.app.api.request = async (path, opts = {}) => {
      if (path === f.jobsPath && opts.method === 'POST') {
        rejectedCreates++; f.app.session.clear('expired');
        throw Object.assign(new Error('expired'), { status: 401 });
      }
      return request(path, opts);
    };
    await f.page.submit();
    assert.equal(rejectedCreates, 1); assert.equal(f.page.data.task, null);
    assert.equal(f.page.data.imagePath, '/local/chosen.jpg'); assert.equal(f.page.data.busy, false);
    assert.match(f.page.data.authNotice, /重新登录/);
    f.app.session.save({ token: 'token-a-new', user: { id: 'user-a' } });
    f.app.api.request = request; await f.page.onShow(); await f.page.submit();
    assert.equal(f.calls.filter(item => item.upload).length, 2);
    assert.equal(f.calls.filter(item => item.path === f.jobsPath && item.method === 'POST').length, 1);
    assert.equal(f.page.data.task.id, 'new-job');
  });

  test(kind + ': locally expired token before submit shows re-login instead of silently discarding the selection', async () => {
    const f = setup(kind); await f.page.onShow(); f.choose();
    f.app.session.save({ token: 'token-a', user: { id: 'user-a' }, expires_at: '2000-01-01T00:00:00Z' });
    await f.page.submit();
    assert.equal(f.page.data.imagePath, '/local/chosen.jpg'); assert.equal(f.page.data.imageOrigin, 'selected');
    assert.match(f.page.data.authNotice, /照片已保留/); assert.equal(f.page.data.loggedIn, false);
    assert.equal(f.calls.some(item => item.upload || item.method === 'POST'), false);
  });

  test(kind + ': explicit logout and another account clear the photo instead of transferring a draft', async () => {
    const f = setup(kind); await f.page.onShow(); f.choose(); f.page.onHide();
    f.app.session.clear(); f.app.session.save({ token: 'token-a-new', user: { id: 'user-a' } }); await f.page.onShow();
    assert.equal(f.page.data.imagePath, '');
    f.choose(); f.page.onHide(); f.app.session.save({ token: 'token-b', user: { id: 'user-b' } }); await f.page.onShow();
    assert.equal(f.page.data.imagePath, ''); assert.equal(f.page.data.imageOrigin, '');
  });

  test(kind + ': oversize or missing picker files leave a persistent explanation without an upload', async () => {
    const f = setup(kind); await f.page.onShow(); f.page.choose(); f.page.onHide();
    f.media.at(-1).success({ tempFiles: [{ tempFilePath: '/local/river-0.png', size: 5292459 }] });
    await f.page.onShow();
    assert.equal(f.page.data.imagePath, ''); assert.match(f.page.data.photoError, /超过 5MB/);
    assert.equal(f.page.data.loggedIn, true); assert.equal(f.calls.some(item => item.upload), false);
    f.page.choose(); f.media.at(-1).success({ tempFiles: [] });
    assert.match(f.page.data.photoError, /没有取得可用照片/);
    f.choose(); assert.equal(f.page.data.photoError, ''); assert.equal(f.page.data.imagePath, '/local/chosen.jpg');
    await f.page.submit(); assert.equal(f.page.data.task.id, 'new-job');
  });

  test(kind + ': native photo picker hide/show does not reset a same-session choice or prevent submission', async () => {
    const f = setup(kind); await f.page.onShow(); f.page.choose(); f.page.onHide();
    f.media.at(-1).success({ tempFiles: [{ tempFilePath: '/local/picker.jpg', size: 1000 }] });
    await f.page.onShow(); assert.equal(f.page.data.imagePath, '/local/picker.jpg');
    await f.page.submit(); assert.equal(f.page.data.task.id, 'new-job');
  });

  test(kind + ': expiry while the native album is open preserves its new photo and explains the login requirement', async () => {
    for (const callbackAfterShow of [false, true]) {
      const f = setup(kind); await f.page.onShow(); f.page.choose(); f.page.onHide();
      f.app.session.clear('expired');
      if (callbackAfterShow) await f.page.onShow();
      f.media.at(-1).success({ tempFiles: [{ tempFilePath: '/local/new-from-album.jpg', size: 1000 }] });
      if (!callbackAfterShow) await f.page.onShow();
      assert.equal(f.page.data.imagePath, '/local/new-from-album.jpg');
      assert.equal(f.page.data.imageOrigin, 'selected'); assert.equal(f.page.data.loggedIn, false);
      assert.match(f.page.data.authNotice, /照片已保留/);
      f.app.session.save({ token: 'token-a-renewed', user: { id: 'user-a' } });
      await f.page.onShow(); await f.page.submit();
      assert.equal(f.page.data.task.id, 'new-job');
      assert.equal(f.calls.filter(item => item.method === 'POST').length, 1);
    }
  });

  test(kind + ': album callbacks cannot transfer a photo after logout or switching account', async () => {
    for (const otherAccount of [false, true]) {
      const f = setup(kind); await f.page.onShow(); f.page.choose(); f.page.onHide();
      if (otherAccount) f.app.session.save({ token: 'token-b', user: { id: 'user-b' } });
      else { f.app.session.clear(); f.app.session.save({ token: 'token-a-renewed', user: { id: 'user-a' } }); }
      await f.page.onShow();
      f.media.at(-1).success({ tempFiles: [{ tempFilePath: '/local/old-account-photo.jpg', size: 1000 }] });
      assert.equal(f.page.data.imagePath, ''); assert.match(f.page.data.photoError, /账号已变化/);
      await f.page.submit(); assert.equal(f.calls.some(item => item.upload), false);
    }
  });

  test(kind + ': an album selection survives same-account token renewal without a logout', async () => {
    const f = setup(kind); await f.page.onShow(); f.page.choose(); f.page.onHide();
    f.app.session.save({ token: 'token-a-renewed', user: { id: 'user-a' } });
    await f.page.onShow();
    f.media.at(-1).success({ tempFiles: [{ tempFilePath: '/local/renewed-account-photo.jpg', size: 1000 }] });
    assert.equal(f.page.data.imagePath, '/local/renewed-account-photo.jpg');
    await f.page.submit(); assert.equal(f.page.data.task.id, 'new-job');
  });

  test(kind + ': late callbacks from an earlier picker cannot replace or report an error over a newer photo', async () => {
    const f = setup(kind); await f.page.onShow(); f.page.choose(); const oldPicker = f.media.at(-1);
    f.page.choose(); const newPicker = f.media.at(-1);
    newPicker.success({ tempFiles: [{ tempFilePath: '/local/newest.jpg', size: 1000 }] });
    oldPicker.success({ tempFiles: [{ tempFilePath: '/local/old.jpg', size: 1000 }] });
    oldPicker.fail({ errMsg: 'old camera failure' });
    assert.equal(f.page.data.imagePath, '/local/newest.jpg'); assert.equal(f.page.data.photoError, '');
  });

  test(kind + ': session renewal during an upload without onShow releases busy state and does not create a job', async () => {
    const f = setup(kind); await f.page.onShow(); f.choose();
    f.app.api.upload = async () => { f.app.session.save({ token: 'token-a-new', user: { id: 'user-a' } }); return { id: 'old-session-asset' }; };
    await f.page.submit();
    assert.equal(f.page.data.imagePath, '/local/chosen.jpg'); assert.equal(f.page.data.busy, false);
    assert.match(f.page.data.error, /再次提交/);
    assert.equal(f.calls.some(item => item.method === 'POST'), false);
  });

  test(kind + ': a normal transport failure preserves the retry draft and displays its error', async () => {
    const f = setup(kind); await f.page.onShow(); f.choose();
    f.app.api.upload = async () => { throw new Error('图片上传超时，请重试'); };
    await f.page.submit();
    assert.equal(f.page.data.imagePath, '/local/chosen.jpg'); assert.equal(f.page.data.imageOrigin, 'selected');
    assert.match(f.page.data.error, /上传超时/); assert.equal(f.page.data.busy, false);
    assert.equal(f.page.data.loggedIn, true);
  });
}
