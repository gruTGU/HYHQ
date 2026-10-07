const { time } = require('./format');

const SCOPE = '当前仅支持 IWHR 数据训练的水面漂浮物观察，不区分塑料瓶、排污口或其他生态类别。';
const DISCLAIMER = '图像教学规则分仅用于观察练习，不是官方生态等级或水质评价。检测框面积不是水面覆盖率，也不代表真实污染程度。';
const STATES = { queued: '等待处理', running: '观察中', succeeded: '观察完成', failed: '处理失败' };

function capability(health) {
  const details = health && health.assessment || {};
  return {
    enabled: details.enabled === true || (details.enabled === undefined && Boolean(health && health.features && health.features.assessment)),
    scope: SCOPE,
    modelName: details.model_name || '',
    modelVersion: details.model_version || '',
    ruleVersion: details.rule_version || '',
  };
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function dimension(value) { return finite(value) && value > 0; }

/** Pixel boxes refer to the original image, never to a downloaded thumbnail's pixels. */
function detectionViews(job) {
  const width = job.image_width;
  const height = job.image_height;
  return (Array.isArray(job.detections) ? job.detections : []).filter((item) => item && item.class_id === 9 && item.eval_category === 'floating_debris').map((item, index) => {
    const confidence = finite(item.confidence) && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : null;
    const box = Array.isArray(item.bbox) ? item.bbox : [];
    const valid = dimension(width) && dimension(height) && box.length === 4 && box.every(finite)
      && box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1] && box[2] <= width && box[3] <= height;
    return {
      id: index, label: '水面漂浮物', confidence_label: confidence === null ? '—' : confidence.toFixed(3),
      box_style: valid ? `left:${box[0] / width * 100}%;top:${box[1] / height * 100}%;width:${(box[2] - box[0]) / width * 100}%;height:${(box[3] - box[1]) / height * 100}%;` : '',
    };
  });
}

function resultView(job) {
  if (!job || job.status !== 'succeeded') return null;
  const detections = detectionViews(job);
  // An empty detection set never implies clean water, even for old or malformed results.
  const score = detections.length && finite(job.score) && job.score >= 0 && job.score <= 100 ? job.score : null;
  const causes = (Array.isArray(job.causes) ? job.causes : []).map((item) => typeof item === 'string' ? item : item && item.text).filter(Boolean);
  const suggestions = (Array.isArray(job.suggestions) ? job.suggestions : []).map((item) => typeof item === 'string' ? item : item && item.text).filter(Boolean);
  return {
    heading: detections.length ? '发现漂浮物候选' : '暂时无法确认',
    explanation: detections.length ? '这些是模型候选，需结合照片与现场情况人工核对。置信分数不是正确概率。' : '未检出可展示的漂浮物候选，不能据此认定没有污染或水质良好。',
    score_label: score === null ? '—' : String(score),
    has_score: score !== null,
    detections,
    boxes: detections.filter((item) => item.box_style),
    causes,
    suggestions: suggestions.length ? suggestions : ['可在安全位置补拍清晰照片，结合现场观察人工核对；不要仅凭照片作水质或污染判定。'],
    model_name: job.model && job.model.name || '未提供',
    model_version: job.model && job.model.version || '未提供',
    rule_version: job.rule_version || '未提供',
    disclaimer: DISCLAIMER,
  };
}

function imageEligible(item, now = Date.now()) {
  return Boolean(item && ['succeeded', 'failed'].includes(item.status) && typeof item.id === 'string' && item.id
    && typeof item.asset_id === 'string' && item.asset_id && (!item.expires_at || Date.parse(item.expires_at) > now));
}

function assessmentTask(item) {
  const view = resultView(item);
  return Object.assign({}, item, {
    status_label: STATES[item.status] || '状态未知',
    created_label: time(item.created_at),
    error_label: item.error_code === 'MODEL_NOT_CONFIGURED' ? '河道观察模型当前未启用，本次未产生结论。' : item.message || item.error_message || '',
    result_view: view,
    can_image_ai: imageEligible(item),
    title: '河道图像观察',
  });
}

module.exports = { capability, assessmentTask, resultView, detectionViews, imageEligible, SCOPE, DISCLAIMER };
