'use strict';
// Fixed, previously validated ONNX artifacts. No user model paths, external graphs or custom ops.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ApiError } = require('./core');
const FLOWERS = require('../data/models/flowers-efficientnet-b0-v1.manifest.json');
const RIVER = require('../data/models/river-floating-debris-v1.manifest.json');
const FIXED = Object.freeze({
  recognition: { manifest: FLOWERS, artifact: 'flowers-efficientnet-b0-v1.onnx', checksum: '01d132fd6fc189adf636060adbe633de57343977d124590e944150f3084fac8f', bytes: 16047581 },
  assessment: { manifest: RIVER, artifact: 'river-eco-yolov8n-v1.onnx', checksum: '96fc7178c28f1eb29bae9703f440d6bda9c041433edb3e335691f38a5ee6da6c', bytes: 12276950 },
});
const DISCLAIMER = '分数是模型排序分数，不是准确率；仅支持登记的五类花卉，尚未验证开放集识别，不能用于安全或专业判断。';
const SCORE_NAME = '图像规则分(教学)';
const LIMITATION = '仅反映照片中受支持的漂浮物检测提示，不是官方水质或生态指数，不能据此判断污染成因。';
const AREA_NOTE = '检测框并集面积占整张图片的比例，是框面积代理，不是水面覆盖率。';
const SPATIAL_NOTE = '按检测框中心在原图中的位置计数；不是地图方位、污染分布或实际密度。';
const PREPROCESSING_VERSION = 'node-rgb-bilinear-v1';
function error(code) { return new ApiError(code, '图像处理暂不可用，请重试或联系管理员', 503); }
function descriptor(kind) { if (!Object.hasOwn(FIXED, kind)) throw error('MODEL_NOT_CONFIGURED'); return FIXED[kind]; }
function snapshot(kind) {
  const { manifest: m, checksum } = descriptor(kind);
  return { id: checksum.slice(0, 8) + '-' + checksum.slice(8, 12) + '-' + checksum.slice(12, 16) + '-' + checksum.slice(16, 20) + '-' + checksum.slice(20, 32), name: m.model_name, version: m.model_version,
    checksum, config_digest: crypto.createHash('sha256').update(JSON.stringify({ labels: m.labels, preprocessing: m.preprocessing, threshold: m.threshold, engine: PREPROCESSING_VERSION })).digest('hex'), scope: m.scope,
    labels: structuredClone(m.labels), threshold: m.threshold, preprocessing: structuredClone(m.preprocessing), preprocessing_version: PREPROCESSING_VERSION };
}
function validateModelFileId(environment, artifact, value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(environment || '') || typeof value !== 'string' || value.length > 512) throw error('MODEL_NOT_CONFIGURED');
  const match = /^cloud:\/\/([a-z0-9_-]+)\.([a-z0-9_-]+)\/([a-zA-Z0-9_.\/-]+)$/.exec(value);
  if (!match || match[1] !== environment || match[3].split('/').some(part => !part || part === '.' || part === '..') || path.posix.basename(match[3]) !== artifact) throw error('MODEL_FILE_ID_INVALID');
  return value;
}
function cloudModelConfiguration(env = process.env, deployment = {}) {
  const environment = env.HYHQ_MODEL_ENV || deployment.env || '', runtime = env.TCB_ENV || env.SCF_NAMESPACE;
  if (!runtime || runtime !== environment) throw error('MODEL_ENV_MISMATCH');
  const files = { recognition: env.HYHQ_FLOWER_MODEL_FILE_ID || (deployment.modelFiles || {}).recognition,
    assessment: env.HYHQ_RIVER_MODEL_FILE_ID || (deployment.modelFiles || {}).assessment };
  for (const kind of Object.keys(FIXED)) validateModelFileId(environment, FIXED[kind].artifact, files[kind]);
  return { environment, files };
}
async function readVerifiedModel(filename, model) {
  const resolved = await fs.realpath(filename).catch(() => { throw error('MODEL_NOT_CONFIGURED'); });
  if (resolved !== filename) throw error('MODEL_PATH_INVALID');
  const file = await fs.open(resolved, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== model.bytes) throw error('MODEL_CHECKSUM_MISMATCH');
    const bytes = await file.readFile();
    if (bytes.length !== model.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== model.checksum) throw error('MODEL_CHECKSUM_MISMATCH');
    return bytes;
  } finally { await file.close(); }
}
function createPrivateModelCache({ environment, files, download, definitions = FIXED, temporaryRoot = os.tmpdir(), timeoutMs = 15000, availableBytes, retryDelayMs = 60000 }) {
  const pending = new Map(), failures = new Map();
  return async kind => {
    if (!Object.hasOwn(definitions, kind)) throw error('MODEL_NOT_CONFIGURED');
    const model = definitions[kind];
    if (!/^[a-f0-9]{64}$/.test(model.checksum || '') || !/^[a-z0-9][a-z0-9_.-]*\.onnx$/i.test(model.artifact || '') || !Number.isSafeInteger(model.bytes) || model.bytes < 1 || model.bytes > 20 * 1024 * 1024) throw error('MODEL_NOT_CONFIGURED');
    const fileID = validateModelFileId(environment, model.artifact, files[kind]);
    const oldFailure = failures.get(kind); if (oldFailure && oldFailure.until > Date.now()) throw error(oldFailure.code);
    if (!pending.has(kind)) {
      const work = (async () => {
        const temporary = await fs.realpath(temporaryRoot), directory = path.join(temporary, 'hyhq-models-' + crypto.createHash('sha256').update(environment).digest('hex').slice(0, 24));
        await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('MODEL_PATH_INVALID');
        const filename = path.join(directory, model.checksum + '.onnx');
        try { await fs.lstat(filename); await readVerifiedModel(filename, model); return filename; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        const free = availableBytes ? await availableBytes(temporary) : await fs.statfs(temporary).then(value => value.bavail * value.bsize);
        if (!Number.isFinite(free) || free < model.bytes + 16 * 1024 * 1024) throw error('MODEL_CACHE_SPACE');
        let timer, destination;
        try {
          const response = await Promise.race([Promise.resolve().then(() => download({ fileID })), new Promise((_, reject) => { timer = setTimeout(() => reject(error('MODEL_DOWNLOAD_TIMEOUT')), Math.min(15000, Math.max(1, timeoutMs))); })]);
          const bytes = response && response.fileContent;
          if (!Buffer.isBuffer(bytes) || bytes.length !== model.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== model.checksum) throw error('MODEL_CHECKSUM_MISMATCH');
          destination = path.join(directory, '.' + crypto.randomUUID() + '.partial'); await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
          await fs.rename(destination, filename); destination = null;
          return filename;
        } finally { clearTimeout(timer); if (destination) await fs.rm(destination, { force: true }); }
      })().catch(cause => { const code = cause instanceof ApiError ? cause.code : 'MODEL_DOWNLOAD_FAILED'; failures.set(kind, { until: Date.now() + retryDelayMs, code }); throw error(code); });
      pending.set(kind, work);
      work.finally(() => pending.delete(kind)).catch(() => {});
    }
    return readVerifiedModel(await pending.get(kind), model);
  };
}
let privateModelCache;
function privateConfiguration() {
  let deployment = {}; try { deployment = require('../deployment.local.json'); } catch (cause) { if (cause.code !== 'MODULE_NOT_FOUND') throw error('MODEL_NOT_CONFIGURED'); }
  return cloudModelConfiguration(process.env, deployment);
}
async function configured(kind, modelRoot) {
  const model = descriptor(kind);
  if (model.manifest.sha256 !== model.checksum || model.manifest.artifact !== model.artifact) throw error('MODEL_CHECKSUM_MISMATCH');
  if (modelRoot || process.env.HYHQ_MODEL_ROOT) { await verifiedBytes(kind, modelRoot); return 'verified_local'; }
  // Public health and queue creation never download a large model. Downloading
  // happens only after a job owns the user/global daily budget and CPU lease.
  privateConfiguration(); return 'configured';
}
async function verifiedBytes(kind, modelRoot) {
  const model = descriptor(kind);
  if (model.manifest.sha256 !== model.checksum || model.manifest.artifact !== model.artifact) throw error('MODEL_CHECKSUM_MISMATCH');
  if (modelRoot || process.env.HYHQ_MODEL_ROOT) {
    const root = await fs.realpath(modelRoot || process.env.HYHQ_MODEL_ROOT).catch(() => { throw error('MODEL_NOT_CONFIGURED'); });
    return readVerifiedModel(path.join(root, model.artifact), model);
  }
  // Deployed cloud functions keep only fixed model declarations in their code
  // package. Weights are data, fetched through the initialized server SDK from
  // the same private environment. No URLs, model graphs or code come from users.
  if (!privateModelCache) {
    const configuration = privateConfiguration(), sdk = require('wx-server-sdk');
    privateModelCache = createPrivateModelCache({ ...configuration, download: options => sdk.downloadFile(options) });
  }
  return privateModelCache(kind);
}
function roundEven(value) { const lower = Math.floor(value), fraction = value - lower; return fraction === 0.5 ? lower + (lower % 2) : Math.round(value); }
// Separable antialiased bilinear with 22-bit coefficients and intermediate 8-bit rounding.
// This reimplements the published Pillow resampling arithmetic for preprocessing parity,
// rather than using sharp's different default Lanczos kernel. RGB decoding still uses sharp.
function coefficients(input, output, start, count) {
  const scale = input / output, filterScale = Math.max(1, scale), precision = 4194304;
  return Array.from({ length: count }, (_, i) => {
    const center = (start + i + 0.5) * scale;
    const first = Math.max(0, Math.trunc(center - filterScale + 0.5)), end = Math.min(input, Math.trunc(center + filterScale + 0.5));
    const weights = []; let total = 0;
    for (let source = first; source < end; source++) { const weight = Math.max(0, 1 - Math.abs((source - center + 0.5) / filterScale)); weights.push(weight); total += weight; }
    return { first, weights: weights.map(weight => Math.trunc(weight / total * precision + 0.5)) };
  });
}
function resize(image, width, height, crop = { left: 0, top: 0, width, height }) {
  const cw = crop.width, ch = crop.height;
  if (![width, height, cw, ch, image.width, image.height].every(n => Number.isInteger(n) && n > 0) || cw > 2048 || ch > 2048 || crop.left < 0 || crop.top < 0 || crop.left + cw > width || crop.top + ch > height) throw error('IMAGE_SHAPE_INVALID');
  const horizontal = coefficients(image.width, width, crop.left, cw), vertical = coefficients(image.height, height, crop.top, ch);
  const intermediate = new Uint8Array(cw * image.height * 3), output = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < cw; x++) {
    const { first, weights } = horizontal[x];
    for (let c = 0; c < 3; c++) { let sum = 2097152; for (let n = 0; n < weights.length; n++) sum += image.data[(y * image.width + first + n) * 3 + c] * weights[n]; intermediate[(y * cw + x) * 3 + c] = Math.min(255, Math.max(0, Math.floor(sum / 4194304))); }
  }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const { first, weights } = vertical[y];
    for (let c = 0; c < 3; c++) { let sum = 2097152; for (let n = 0; n < weights.length; n++) sum += intermediate[((first + n) * cw + x) * 3 + c] * weights[n]; output[(y * cw + x) * 3 + c] = Math.min(255, Math.max(0, Math.floor(sum / 4194304))); }
  }
  return { data: output, width: cw, height: ch };
}
async function decode(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 6 * 1024 * 1024) throw error('INVALID_IMAGE');
  try {
    const sharp = require('sharp');
    // Pillow's RGB conversion ignores an embedded ICC profile. Do the same so
    // fixed model inputs are not silently colour-corrected by libvips.
    const input = sharp(bytes, { limitInputPixels: 2048 * 2048, failOn: 'warning', ignoreIcc: true });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1 || metadata.width * metadata.height > 2048 * 2048) throw error('INVALID_IMAGE');
    const { data, info } = await input.rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || info.width * info.height > 2048 * 2048) throw error('INVALID_IMAGE');
    return { data, width: info.width, height: info.height };
  } catch (cause) { if (cause instanceof ApiError) throw cause; throw error('IMAGE_UNAVAILABLE'); }
}
function lowQuality(image) {
  if (Math.min(image.width, image.height) < 32) return true;
  const scale = Math.min(1, 128 / image.width, 128 / image.height);
  const sampled = resize(image, Math.max(1, roundEven(image.width * scale)), Math.max(1, roundEven(image.height * scale)));
  const size = sampled.width * sampled.height, sum = [0, 0, 0], squares = [0, 0, 0];
  for (let n = 0; n < sampled.data.length; n++) { const c = n % 3, value = sampled.data[n]; sum[c] += value; squares[c] += value * value; }
  return Math.max(...sum.map((value, c) => Math.sqrt(Math.max(0, squares[c] / size - (value / size) ** 2)))) < 2;
}
function preprocess(kind, image) {
  if (kind === 'recognition') {
    const { preprocessing: p } = snapshot(kind), { width, height } = image;
    const rw = width <= height ? p.resize_shorter : Math.floor(width * p.resize_shorter / height), rh = width <= height ? Math.floor(height * p.resize_shorter / width) : p.resize_shorter;
    const crop = resize(image, rw, rh, { left: roundEven((rw - p.crop_size) / 2), top: roundEven((rh - p.crop_size) / 2), width: p.crop_size, height: p.crop_size });
    const plane = crop.width * crop.height, pixels = new Float32Array(plane * 3);
    for (let n = 0; n < plane; n++) for (let c = 0; c < 3; c++) pixels[c * plane + n] = Math.fround(Math.fround(Math.fround(crop.data[n * 3 + c] / 255) - Math.fround(p.mean[c])) / Math.fround(p.std[c]));
    return { pixels, shape: [1, 3, 224, 224] };
  }
  descriptor(kind);
  const scale = Math.min(640 / image.width, 640 / image.height), width = Math.max(1, roundEven(image.width * scale)), height = Math.max(1, roundEven(image.height * scale));
  const padX = Math.floor((640 - width) / 2), padY = Math.floor((640 - height) / 2), resized = resize(image, width, height), plane = 640 * 640;
  const pixels = new Float32Array(plane * 3).fill(Math.fround(114 / 255));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) pixels[c * plane + (y + padY) * 640 + x + padX] = Math.fround(resized.data[(y * width + x) * 3 + c] / 255);
  return { pixels, shape: [1, 3, 640, 640], scaleX: width / image.width, scaleY: height / image.height, padX, padY };
}
function postprocess(raw, labels = RIVER.labels, threshold = 0.5) {
  const dims = raw && raw.dims, values = raw && raw.data;
  if (!dims || dims.length !== 3 || dims[0] !== 1 || dims[1] !== 4 + labels.length || !Number.isInteger(dims[2]) || dims[2] < 1 || dims[2] > 30000 || !(values instanceof Float32Array) || values.length !== dims[1] * dims[2] || !values.every(Number.isFinite)) throw error('MODEL_OUTPUT_INVALID');
  const count = dims[2], candidates = [];
  for (let index = 0; index < count; index++) {
    let classId = 0, confidence = -1;
    for (let c = 0; c < labels.length; c++) { const score = values[(4 + c) * count + index]; if (score < 0 || score > 1) throw error('MODEL_OUTPUT_INVALID'); if (score > confidence) { confidence = score; classId = c; } }
    const width = values[count * 2 + index], height = values[count * 3 + index];
    if (classId !== 9 || confidence < threshold || width <= 0 || height <= 0) continue;
    const cx = values[index], cy = values[count + index];
    candidates.push({ class_id: classId, confidence, bbox: [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2] });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const pending = candidates.slice(0, 3000), output = [];
  for (const item of pending) {
    if (output.some(kept => iou(item.bbox, kept.bbox) > 0.45)) continue;
    output.push(item); if (output.length === 100) break;
  }
  return output;
}
function iou(a, b) {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection;
  return union > 0 ? intersection / union : 0;
}
function unionArea(boxes) {
  const xs = [...new Set(boxes.flatMap(box => [box[0], box[2]]))].sort((a, b) => a - b); let total = 0;
  for (let n = 1; n < xs.length; n++) {
    const left = xs[n - 1], right = xs[n], intervals = boxes.filter(box => box[0] < right && box[2] > left).map(box => [box[1], box[3]]).sort((a, b) => a[0] - b[0]);
    let length = 0, end = -Infinity;
    for (const [bottom, top] of intervals) { length += Math.max(0, top - Math.max(bottom, end)); end = Math.max(end, top); }
    total += (right - left) * length;
  }
  return total;
}
function assessmentResult(detections, width, height, reason = '') {
  const result = { detections, image_width: width, image_height: height, score_name: SCORE_NAME, score: null, grade: '无法确认', causes: [], issues: {}, decision: 'uncertain', reason: reason || 'NO_SUPPORTED_DETECTIONS', limitation: LIMITATION };
  if (!detections.length || reason === 'LOW_IMAGE_QUALITY') return result;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || detections.length > 300) throw error('MODEL_OUTPUT_INVALID');
  for (const d of detections) if (d.class_id !== 9 || d.eval_category !== 'floating_debris' || !Array.isArray(d.bbox) || d.bbox.length !== 4 || !d.bbox.every(Number.isFinite) || !(d.bbox[0] >= 0 && d.bbox[1] >= 0 && d.bbox[2] > d.bbox[0] && d.bbox[3] > d.bbox[1] && d.bbox[2] <= width && d.bbox[3] <= height) || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) throw error('MODEL_OUTPUT_INVALID');
  const ratio = Math.max(0, Math.min(1, unionArea(detections.map(d => d.bbox)) / (width * height))), count = detections.length;
  const countPenalty = count >= 11 ? 20 : count >= 4 ? 12 : 5, areaPenalty = ratio >= 0.05 ? 10 : ratio >= 0.01 ? 5 : 0, score = 100 - countPenalty - areaPenalty;
  return { ...result, score, grade: score >= 85 ? '提示较少' : score >= 70 ? '需要关注' : score >= 50 ? '建议核查' : '重点核查', decision: 'assessed', reason: '',
    causes: [{ rule: 'floating_debris_observed', text: `图像中有 ${count} 处疑似漂浮物提示，建议现场核查；无法据图确认污染来源。` }],
    issues: { floating_debris: { count, box_area_ratio: Number(ratio.toFixed(6)), area_note: AREA_NOTE } } };
}
function summary(job) {
  if (job.status !== 'succeeded') return null;
  const base = { schema_version: 1, status: 'unavailable', candidate_count: null, excluded_count: 0, box_area_ratio: null, confidence: null, grid: [], area_note: AREA_NOTE, spatial_note: SPATIAL_NOTE };
  if (job.reason === 'LOW_IMAGE_QUALITY') return { ...base, reason: job.reason };
  const w = job.image_width, h = job.image_height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return { ...base, reason: 'INVALID_IMAGE_DIMENSIONS' };
  if (!Array.isArray(job.detections) || job.detections.length > 300) return { ...base, reason: 'INVALID_DETECTIONS' };
  const grid = ['左上', '上中', '右上', '左中', '中央', '右中', '左下', '下中', '右下'].map((label, index) => ({ key: String(index), label, count: 0 })), valid = []; let excluded = 0;
  for (const d of job.detections) {
    const b = d && d.bbox, score = d && d.confidence;
    if (!d || d.class_id !== 9 || d.eval_category !== 'floating_debris' || !Number.isFinite(score) || score < 0 || score > 1 || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || !(b[0] >= 0 && b[1] >= 0 && b[2] > b[0] && b[3] > b[1] && b[2] <= w && b[3] <= h)) { excluded++; continue; }
    valid.push(d); grid[Math.min(2, Math.floor((b[1] + b[3]) / 2 / h * 3)) * 3 + Math.min(2, Math.floor((b[0] + b[2]) / 2 / w * 3))].count++;
  }
  if (!valid.length) return { ...base, reason: 'NO_SUPPORTED_DETECTIONS', excluded_count: excluded };
  const confidence = valid.map(d => d.confidence), rounded = n => Number(n.toFixed(6));
  return { ...base, status: 'ready', reason: '', candidate_count: valid.length, excluded_count: excluded, box_area_ratio: Math.min(1, Math.max(0, unionArea(valid.map(d => d.bbox)) / (w * h))), confidence: { min: rounded(Math.min(...confidence)), max: rounded(Math.max(...confidence)), mean: rounded(confidence.reduce((a, b) => a + b, 0) / confidence.length) }, grid };
}
let tail = Promise.resolve();
async function infer(kind, bytes, options = {}) {
  const operation = tail.then(async () => {
    const snapshotValue = snapshot(kind), blob = await verifiedBytes(kind, options.modelRoot), image = await decode(bytes);
    const quality = lowQuality(image);
    if (quality) return kind === 'recognition' ? { decision: 'uncertain', reason: 'LOW_IMAGE_QUALITY', candidates: [], threshold: snapshotValue.threshold, model: snapshotValue, scope: snapshotValue.scope, disclaimer: DISCLAIMER } : assessmentResult([], image.width, image.height, 'LOW_IMAGE_QUALITY');
    const input = preprocess(kind, image), ort = require('onnxruntime-node');
    let session;
    try {
      session = await ort.InferenceSession.create(blob, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all', logSeverityLevel: 3, extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } });
      if (session.inputNames.length !== 1 || session.outputNames.length !== 1) throw error('MODEL_IO_INVALID');
      const raw = (await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input.pixels, input.shape) }))[session.outputNames[0]];
      if (kind === 'recognition') {
        if (!raw || raw.type !== 'float32' || raw.dims.join(',') !== '1,5' || raw.data.length !== 5 || !raw.data.every(Number.isFinite)) throw error('MODEL_OUTPUT_INVALID');
        const max = Math.max(...raw.data), values = Array.from(raw.data, value => Math.exp(value - max)), total = values.reduce((a, b) => a + b, 0);
        const candidates = values.map((value, i) => ({ label: snapshotValue.labels[i].id, name: snapshotValue.labels[i].name, score: value / total, content_id: null })).sort((a, b) => b.score - a.score).slice(0, 3);
        return { decision: candidates[0].score >= snapshotValue.threshold ? 'recognized' : 'uncertain', ...(candidates[0].score < snapshotValue.threshold ? { reason: 'LOW_CONFIDENCE' } : {}), candidates, threshold: snapshotValue.threshold, model: snapshotValue, scope: snapshotValue.scope, disclaimer: DISCLAIMER };
      }
      const detections = [];
      for (const found of postprocess(raw)) {
        const [a, b, c, d] = found.bbox, x1 = Math.min(image.width, Math.max(0, (a - input.padX) / input.scaleX)), x2 = Math.min(image.width, Math.max(0, (c - input.padX) / input.scaleX)), y1 = Math.min(image.height, Math.max(0, (b - input.padY) / input.scaleY)), y2 = Math.min(image.height, Math.max(0, (d - input.padY) / input.scaleY));
        if (x2 <= x1 || y2 <= y1) continue;
        detections.push({ ...found, label: RIVER.labels[9].name, eval_category: 'floating_debris', bbox: [x1, y1, x2, y2], area_ratio: Number(((x2 - x1) * (y2 - y1) / (image.width * image.height)).toFixed(6)) });
      }
      return assessmentResult(detections, image.width, image.height);
    } catch (cause) { if (cause instanceof ApiError) throw cause; throw error('MODEL_INFERENCE_FAILED'); }
    finally { if (session) await session.release(); }
  });
  tail = operation.catch(() => {});
  return operation;
}
module.exports = { infer, snapshot, configured, verifiedBytes, createPrivateModelCache, cloudModelConfiguration, validateModelFileId, decode, preprocess, lowQuality, resize, roundEven, postprocess, unionArea, assessmentResult, summary, PREPROCESSING_VERSION, SCORE_NAME, LIMITATION, AREA_NOTE, SPATIAL_NOTE };
