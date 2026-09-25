const test = require('node:test');
const assert = require('node:assert/strict');
const ID = '8a61b290-6cc9-4ed8-b1c8-8ea6410b24ea';
const OTHER = '8a61b290-6cc9-4ed8-b1c8-8ea6410b24eb';
function metadata(id = ID) { return { id, title: '测试资料', revision: 'a'.repeat(64), mime_type: 'audio/wav', audio_path: '/api/v1/narrations/' + id + '/audio/' }; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { await Promise.resolve(); await Promise.resolve(); }
function fixture(request = async () => ({ data: metadata() }), options = {}) {
  let definition;
  const audios = [], calls = [];
  global.Component = (value) => { definition = value; };
  global.getApp = () => ({ config: { baseURL: 'https://example.test/api/v1' }, api: { request: (...args) => { calls.push(args); return request(...args); } } });
  global.wx = { createInnerAudioContext() {
    const handlers = {};
    const audio = { handlers, playCount: 0, stopCount: 0, destroyCount: 0,
      play() { this.playCount += 1; if (!options.silentPlay && handlers.Play) handlers.Play(); },
      pause() { if (handlers.Pause) handlers.Pause(); },
      stop() { this.stopCount += 1; if (handlers.Stop) handlers.Stop(); },
      destroy() { this.destroyCount += 1; },
    };
    for (const name of ['Play', 'Pause', 'Stop', 'Ended', 'Error', 'TimeUpdate']) audio['on' + name] = (handler) => { handlers[name] = handler; };
    audios.push(audio);
    return audio;
  } };
  const path = require.resolve('../components/narration-player/index');
  delete require.cache[path]; require(path);
  const instance = { ...definition.methods, data: { ...structuredClone(definition.data), kind: 'content', targetId: ID },
    setData(patch) { Object.assign(this.data, patch); } };
  return { instance, definition, audios, calls };
}

function fakeTimers(t) {
  const timers = new Map();
  let sequence = 0;
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const id = sequence++;
    timers.set(id, { callback, delay, cancelled: false });
    return id;
  });
  t.mock.method(global, 'clearTimeout', (id) => {
    const timer = timers.get(id);
    if (timer) timer.cancelled = true;
  });
  return { latest: () => [...timers.values()].at(-1), pending: () => [...timers.values()].filter((timer) => !timer.cancelled) };
}

test('no configured narration remains invisible and never creates an audio player', async () => {
  const { instance, definition, audios } = fixture(async () => ({ data: null }));
  definition.lifetimes.attached.call(instance); await flush();
  assert.equal(instance.data.narration, null);
  assert.equal(audios.length, 0);
});

test('metadata loads without autoplay; explicit play revalidates then supports pause, resume and stop', async () => {
  const { instance, definition, audios, calls } = fixture();
  definition.lifetimes.attached.call(instance); await flush();
  assert.equal(instance.data.narration.id, ID);
  assert.equal(audios.length, 0);
  await instance.toggle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['narrations/', { data: { content: ID } }]);
  const audio = audios[0];
  assert.equal(audio.autoplay, false);
  assert.equal(audio.src, 'https://example.test/api/v1/narrations/' + ID + '/audio/');
  assert.equal(instance.data.playing, true);
  await instance.toggle();
  assert.equal(instance.data.paused, true);
  await instance.toggle();
  assert.equal(audio.playCount, 2);
  assert.equal(calls.length, 3);
  audio.currentTime = 61; audio.duration = 123; audio.handlers.TimeUpdate();
  assert.equal(instance.data.elapsed, '1:01');
  assert.equal(instance.data.duration, '2:03');
  instance.stop();
  assert.equal(audio.stopCount, 1);
  assert.equal(audio.destroyCount, 1);
  assert.equal(instance.data.elapsed, '0:00');
  assert.equal(instance.data.playing, false);
});

test('hiding and detaching stop and destroy; late old-player callbacks cannot touch a new page', async () => {
  const { instance, definition, audios } = fixture();
  definition.lifetimes.attached.call(instance); await flush();
  await instance.toggle();
  const old = audios[0];
  definition.pageLifetimes.hide.call(instance);
  assert.equal(old.destroyCount, 1);
  old.handlers.Play();
  assert.equal(instance.data.playing, false);
  definition.pageLifetimes.show.call(instance); await flush();
  assert.equal(audios.length, 1);
  await instance.toggle();
  assert.equal(audios.length, 2);
  old.handlers.Error();
  assert.equal(instance.data.playing, true);
  definition.lifetimes.detached.call(instance);
  instance.setData = () => { throw new Error('write after detach'); };
  audios[1].handlers.TimeUpdate(); audios[1].handlers.Error();
  assert.equal(audios[1].destroyCount, 1);
});

test('source changes invalidate pending metadata and stop old playback', async () => {
  const pending = deferred(); let first = true;
  const { instance, definition, audios } = fixture(() => first ? (first = false, pending.promise) : Promise.resolve({ data: metadata(OTHER) }));
  definition.lifetimes.attached.call(instance);
  instance.data.targetId = OTHER;
  definition.observers['kind,targetId'].call(instance); await flush();
  assert.equal(instance.data.narration.id, OTHER);
  pending.resolve({ data: metadata() }); await flush();
  assert.equal(instance.data.narration.id, OTHER);
  await instance.toggle();
  instance.data.kind = 'route';
  definition.observers['kind,targetId'].call(instance); await flush();
  assert.equal(audios[0].destroyCount, 1);
  assert.equal(instance.data.playing, false);
});

test('hide or stop during explicit start validation prevents background playback', async () => {
  for (const action of ['hide', 'stop']) {
    const pending = deferred(); let calls = 0;
    const { instance, definition, audios } = fixture(() => ++calls === 1 ? Promise.resolve({ data: metadata() }) : pending.promise);
    definition.lifetimes.attached.call(instance); await flush();
    const playing = instance.toggle();
    if (action === 'hide') definition.pageLifetimes.hide.call(instance); else instance.stop();
    pending.resolve({ data: metadata() }); await playing;
    assert.equal(audios.length, 0);
    assert.equal(instance.data.playing, false);
  }
});

test('withdrawal before play hides the card, and arbitrary remote source URLs never play', async () => {
  let calls = 0;
  const { instance, definition, audios } = fixture(async () => ({ data: ++calls === 1 ? metadata() : null }));
  definition.lifetimes.attached.call(instance); await flush();
  await instance.toggle();
  assert.equal(instance.data.narration, null);
  assert.equal(audios.length, 0);
  const invalid = fixture(async () => ({ data: { ...metadata(), audio_path: 'https://untrusted.example/file.mp3' } }));
  invalid.definition.lifetimes.attached.call(invalid.instance); await flush();
  assert.equal(invalid.instance.data.narration, null);
  assert.equal(invalid.audios.length, 0);
});

test('audio errors offer explicit retry with a fresh instance; ended state never auto-replays', async () => {
  const { instance, definition, audios } = fixture();
  definition.lifetimes.attached.call(instance); await flush();
  await instance.toggle();
  audios[0].handlers.Error();
  assert.match(instance.data.error, /重试/);
  assert.equal(audios[0].destroyCount, 1);
  await instance.toggle();
  assert.equal(audios.length, 2);
  assert.equal(instance.data.error, '');
  audios[1].handlers.Ended();
  assert.equal(instance.data.playing, false);
  assert.equal(audios[1].destroyCount, 1);
  assert.equal(audios[1].playCount, 1);
});

test('metadata network failure adds no empty card; invalid source IDs cause no request', async () => {
  const { instance, definition, audios } = fixture(async () => { throw new Error('offline'); });
  definition.lifetimes.attached.call(instance); await flush();
  assert.equal(instance.data.narration, null);
  assert.equal(audios.length, 0);
  const invalid = fixture();
  invalid.instance.data.targetId = '../../private';
  invalid.definition.lifetimes.attached.call(invalid.instance); await flush();
  assert.equal(invalid.calls.length, 0);
});

test('silent native start times out at 20 seconds and retry creates a fresh protected player', async (t) => {
  const timers = fakeTimers(t);
  const { instance, definition, audios } = fixture(undefined, { silentPlay: true });
  definition.lifetimes.attached.call(instance); await flush();
  await instance.toggle();
  const expired = timers.latest();
  assert.equal(expired.delay, 20000);
  assert.equal(instance.data.loading, true);
  expired.callback();
  assert.equal(instance.data.loading, false);
  assert.match(instance.data.error, /超时.*重试/);
  assert.equal(audios[0].stopCount, 1);
  assert.equal(audios[0].destroyCount, 1);
  await instance.toggle();
  const current = audios[1], currentTimer = timers.latest();
  expired.callback(); audios[0].handlers.Play(); audios[0].handlers.Error();
  assert.equal(instance._audio, current);
  assert.equal(instance.data.loading, true);
  current.handlers.Play();
  assert.equal(currentTimer.cancelled, true);
  assert.equal(instance.data.playing, true);
  currentTimer.callback();
  assert.equal(instance.data.playing, true);
  assert.equal(instance.data.error, '');
});

test('resume has its own startup deadline and a cancelled initial timer cannot interrupt it', async (t) => {
  const timers = fakeTimers(t);
  const { instance, definition, audios } = fixture(undefined, { silentPlay: true });
  definition.lifetimes.attached.call(instance); await flush();
  await instance.toggle();
  const initialTimer = timers.latest();
  audios[0].handlers.Play();
  await instance.toggle();
  assert.equal(instance.data.paused, true);
  await instance.toggle();
  const resumeTimer = timers.latest();
  assert.notEqual(initialTimer, resumeTimer);
  assert.equal(resumeTimer.delay, 20000);
  initialTimer.callback();
  assert.equal(instance.data.loading, true);
  resumeTimer.callback();
  assert.match(instance.data.error, /超时/);
  assert.equal(instance.data.paused, false);
  assert.equal(audios[0].destroyCount, 1);
});

test('native play, pause, stop, error and end all cancel the pending startup callback', async (t) => {
  const timers = fakeTimers(t);
  for (const event of ['Play', 'Pause', 'Stop', 'Error', 'Ended']) {
    const { instance, definition, audios } = fixture(undefined, { silentPlay: true });
    definition.lifetimes.attached.call(instance); await flush();
    await instance.toggle();
    const timer = timers.latest();
    audios[0].handlers[event]();
    assert.equal(timer.cancelled, true, event);
    const state = structuredClone(instance.data);
    timer.callback();
    assert.deepEqual(instance.data, state, event);
    definition.lifetimes.detached.call(instance);
  }
  assert.equal(timers.pending().length, 0);
});

test('loading can be stopped; source change, hide and detach cancel startup without late state writes', async (t) => {
  const timers = fakeTimers(t);
  for (const action of ['stop', 'source', 'hide', 'detach']) {
    const { instance, definition, audios } = fixture(undefined, { silentPlay: true });
    definition.lifetimes.attached.call(instance); await flush();
    await instance.toggle();
    assert.equal(instance.data.loading, true);
    const timer = timers.latest();
    if (action === 'stop') instance.stop();
    else if (action === 'source') { instance.data.targetId = OTHER; definition.observers['kind,targetId'].call(instance); await flush(); }
    else if (action === 'hide') definition.pageLifetimes.hide.call(instance);
    else definition.lifetimes.detached.call(instance);
    assert.equal(timer.cancelled, true, action);
    assert.equal(audios[0].destroyCount, 1, action);
    const state = structuredClone(instance.data);
    instance.setData = () => { throw new Error('stale callback after ' + action); };
    timer.callback(); audios[0].handlers.Play(); audios[0].handlers.Error();
    assert.deepEqual(instance.data, state, action);
    if (action !== 'detach') assert.equal(instance.data.loading, false, action);
  }
  assert.equal(timers.pending().length, 0);
});
