'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const inference = require('../../cloudfunctions/hyhqApi/lib/inference');
function tensor(items, count = items.length) {
  const data = new Float32Array(19 * count);
  items.forEach((item, n) => { item.box.forEach((value, c) => { data[c * count + n] = value; }); for (const [id, score] of Object.entries(item.scores)) data[(4 + Number(id)) * count + n] = score; });
  return { dims: [1, 19, count], data };
}
function image(width, height, value = 100) { return { width, height, data: new Uint8Array(width * height * 3).fill(value) }; }
function detection(box, confidence = 0.8) { return { class_id: 9, eval_category: 'floating_debris', bbox: box, confidence }; }

test('fixed model snapshots expose honest five-class threshold and supported detector class', () => {
  const flower = inference.snapshot('recognition'), river = inference.snapshot('assessment');
  assert.equal(flower.labels.length, 5); assert.equal(flower.threshold, 0); assert.match(flower.scope, /开放集未验证/);
  assert.deepEqual(river.preprocessing.supported_class_ids, [9]); assert.equal(river.threshold, 0.5); assert.match(river.scope, /未检出不代表清洁/);
  flower.labels[0].name = 'changed'; assert.notEqual(inference.snapshot('recognition').labels[0].name, 'changed');
  assert.throws(() => inference.snapshot('user-supplied'), { code: 'MODEL_NOT_CONFIGURED' });
});

test('artifact verification rejects missing, corrupt and symlinked models before ONNX load', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyhq-model-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(inference.verifiedBytes('recognition', root), { code: 'MODEL_NOT_CONFIGURED' });
  const filename = path.join(root, 'flowers-efficientnet-b0-v1.onnx'); await fs.writeFile(filename, 'bad graph');
  await assert.rejects(inference.verifiedBytes('recognition', root), { code: 'MODEL_CHECKSUM_MISMATCH' });
  await fs.unlink(filename); await fs.writeFile(path.join(root, 'other'), 'private'); await fs.symlink(path.join(root, 'other'), filename);
  await assert.rejects(inference.verifiedBytes('recognition', root), { code: 'MODEL_PATH_INVALID' });
});

test('low quality rejects tiny and single-channel constant images; detailed image is accepted', () => {
  assert.equal(inference.lowQuality(image(31, 100)), true); assert.equal(inference.lowQuality(image(100, 100)), true);
  const red = image(100, 100, 0); for (let n = 0; n < red.data.length; n += 3) red.data[n] = 255;
  assert.equal(inference.lowQuality(red), true);
  const gradient = image(100, 100); for (let n = 0; n < gradient.data.length; n++) gradient.data[n] = n % 256;
  assert.equal(inference.lowQuality(gradient), false);
});

test('bilinear resize preserves constant images and Python tie-to-even center crop', () => {
  assert.equal(inference.roundEven(16.5), 16); assert.equal(inference.roundEven(17.5), 18);
  const resized = inference.resize(image(7, 5, 42), 13, 11); assert.ok(resized.data.every(value => value === 42));
  const source = image(2, 2, 0); source.data.set([0, 0, 0, 100, 100, 100, 200, 200, 200, 255, 255, 255]);
  assert.deepEqual([...inference.resize(source, 1, 1).data], [139, 139, 139]);
});

test('bounded center crop does not allocate the full resized extreme-aspect image', () => {
  const result = inference.preprocess('recognition', image(2048, 32));
  assert.deepEqual(result.shape, [1, 3, 224, 224]); assert.equal(result.pixels.length, 150528); assert.ok(result.pixels.every(Number.isFinite));
});

test('river preprocessing letterboxes with independent rounding-aware x/y scaling', () => {
  const result = inference.preprocess('assessment', image(101, 51, 255));
  assert.deepEqual(result.shape, [1, 3, 640, 640]); assert.equal(result.scaleX, 640 / 101); assert.equal(result.scaleY, 323 / 51); assert.equal(result.padY, 158);
  assert.equal(result.pixels[0], Math.fround(114 / 255)); assert.equal(result.pixels[158 * 640], 1);
});

test('detector accepts only supported winning class 9, bounds NMS and rejects malformed scores', () => {
  const output = inference.postprocess(tensor([
    { box: [100, 100, 30, 30], scores: { 9: 0.9 } },
    { box: [101, 101, 30, 30], scores: { 9: 0.8 } },
    { box: [200, 200, 10, 10], scores: { 0: 0.99, 9: 0.9 } },
    { box: [300, 300, 0, 30], scores: { 9: 0.9 } },
    { box: [400, 400, 10, 10], scores: { 9: 0.4 } },
  ]));
  assert.equal(output.length, 1); assert.equal(output[0].class_id, 9); assert.deepEqual(output[0].bbox, [85, 85, 115, 115]);
  const invalid = tensor([{ box: [1, 1, 1, 1], scores: { 9: 1.1 } }]);
  assert.throws(() => inference.postprocess(invalid), { code: 'MODEL_OUTPUT_INVALID' });
  invalid.data[0] = NaN; assert.throws(() => inference.postprocess(invalid), { code: 'MODEL_OUTPUT_INVALID' });
  assert.throws(() => inference.postprocess({ dims: [1, 19, 30001], data: new Float32Array(19 * 30001) }), { code: 'MODEL_OUTPUT_INVALID' });
  const many = Array.from({ length: 200 }, (_, n) => ({ box: [n * 5, 0, 1, 1], scores: { 9: 0.9 } }));
  assert.equal(inference.postprocess(tensor(many)).length, 100);
});

test('teaching score uses box union and never declares clean water from no detection', () => {
  assert.equal(inference.unionArea([[0, 0, 10, 10], [5, 0, 15, 10]]), 150);
  const empty = inference.assessmentResult([], 100, 100); assert.equal(empty.score, null); assert.equal(empty.decision, 'uncertain');
  const result = inference.assessmentResult([detection([0, 0, 10, 10]), detection([5, 0, 15, 10])], 100, 100);
  assert.equal(result.score, 90); assert.equal(result.issues.floating_debris.box_area_ratio, 0.015); assert.match(result.limitation, /不是官方水质/);
  assert.throws(() => inference.assessmentResult([detection([-1, 0, 10, 10])], 100, 100), { code: 'MODEL_OUTPUT_INVALID' });
});

test('observation summary filters invalid boxes and reports image grid without geographic inference', () => {
  const job = { status: 'succeeded', image_width: 90, image_height: 90, detections: [detection([0, 0, 10, 10]), detection([40, 40, 50, 50]), { ...detection([60, 60, 70, 70]), class_id: 0 }, null] };
  const summary = inference.summary(job); assert.equal(summary.candidate_count, 2); assert.equal(summary.excluded_count, 2);
  assert.equal(summary.grid[0].count, 1); assert.equal(summary.grid[4].count, 1); assert.match(summary.spatial_note, /不是地图方位/);
  assert.equal(inference.summary({ ...job, status: 'running' }), null);
  assert.equal(inference.summary({ ...job, reason: 'LOW_IMAGE_QUALITY' }).status, 'unavailable');
});

test('image decoder rejects invalid bytes and oversized input before inference', async () => {
  await assert.rejects(inference.decode(Buffer.alloc(0)), { code: 'INVALID_IMAGE' });
  await assert.rejects(inference.decode(Buffer.alloc(6 * 1024 * 1024 + 1)), { code: 'INVALID_IMAGE' });
  await assert.rejects(inference.decode(Buffer.from('not a JPEG')), { code: 'IMAGE_UNAVAILABLE' });
});
