'use strict';
// Optional CPU comparison against artifacts produced by the existing Python adapters.
// Inputs and model weights remain local. Set both HYHQ_TEST_MODEL_ROOT and
// HYHQ_TEST_COMPARISON_ROOT to run; these tests never download or call providers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inference = require('../../cloudfunctions/hyhqApi/lib/inference');
const models = process.env.HYHQ_TEST_MODEL_ROOT, comparison = process.env.HYHQ_TEST_COMPARISON_ROOT;
if (!models || !comparison) {
  test('actual fixed ONNX CPU / Python comparison requires local artifacts', { skip: 'Provide HYHQ_TEST_MODEL_ROOT and HYHQ_TEST_COMPARISON_ROOT.' }, () => {});
} else {
  const cases = JSON.parse(fs.readFileSync(path.join(comparison, 'python.json'), 'utf8'));
  assert.ok(cases.length >= 7 && cases.filter(row => row.kind === 'recognition').length >= 5 && cases.filter(row => row.kind === 'assessment').length >= 2);
  for (const row of cases) test('actual CPU preserves Python inputs and outputs: ' + row.name, async () => {
    const bytes = fs.readFileSync(row.file), image = await inference.decode(bytes);
    assert.equal(image.width, row.width); assert.equal(image.height, row.height);
    assert.deepEqual(image.data, fs.readFileSync(path.join(comparison, row.name + '.rgb')));
    assert.equal(inference.lowQuality(image), row.low_quality);
    const actual = inference.preprocess(row.kind, image).pixels;
    assert.deepEqual(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), fs.readFileSync(path.join(comparison, row.name + '.f32')));
    const result = await inference.infer(row.kind, bytes, { modelRoot: models });
    if (row.kind === 'recognition') {
      assert.equal(result.decision, row.result.decision);
      assert.equal(result.threshold, 0);
      assert.deepEqual(result.candidates.map(c => c.label), row.result.candidates.map(c => c.label));
      result.candidates.forEach((candidate, i) => assert.ok(Math.abs(candidate.score - row.result.candidates[i].score) < 1e-6));
    } else {
      assert.equal(result.detections.length, row.result.detections.length);
      result.detections.forEach((d, i) => {
        assert.equal(d.class_id, 9);
        assert.ok(Math.abs(d.confidence - row.result.detections[i].confidence) < 1e-6);
        d.bbox.forEach((coordinate, j) => assert.ok(Math.abs(coordinate - row.result.detections[i].bbox[j]) < 0.001));
      });
      assert.equal(result.score_name, '图像规则分(教学)');
    }
  });
}
