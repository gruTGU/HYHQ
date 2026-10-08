export const time = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "时间未提供";
export const pending = (value) =>
  value && ["queued", "running"].includes(value.status);
export const statusLabel = (value) =>
  ({
    queued: "等待处理",
    running: "处理中",
    succeeded: "已完成",
    failed: "处理失败",
  })[value] || "状态未知";
export const errorText = (error) => error?.message || "暂时无法完成，请重试。";
export const submissionStatuses = {
  draft: "私人草稿",
  checking: "原始反馈检查中",
  reviewing: "编辑内容检查中",
  pending: "等待编辑核实",
  rejected: "未通过",
  approved: "已采用 · 原稿仍为私密",
  withdrawn: "已撤回",
};
export const categories = [
  { value: "green", name: "绿色生活" },
  { value: "plants", name: "植物知识" },
  { value: "water", name: "水资源保护" },
  { value: "travel", name: "生态智游" },
];
export { THEMES as themes } from "../lib/themes.js";
export function listData(response) {
  if (!Array.isArray(response?.data))
    throw new Error("记录格式不正确，请刷新核对。");
  return response.data;
}
export function safeNext(value, endpoint) {
  if (!value) return "";
  if (typeof value !== "string") throw new Error("分页地址无效");
  const url = new URL(value, window.location.origin + "/api/v1/");
  if (
    url.origin !== window.location.origin ||
    url.pathname !== "/api/v1/" + endpoint
  )
    throw new Error("分页地址无效");
  return endpoint + url.search;
}

function thresholdNote(threshold) {
  if (threshold === 0)
    return "当前版本未启用低分拒识。图片质量合格时会在支持类别中给出候选，范围外对象也可能得到高分；结果仅供观察参考。";
  if (
    typeof threshold === "number" &&
    Number.isFinite(threshold) &&
    threshold > 0 &&
    threshold <= 1
  )
    return "低于分类分数阈值时显示“暂时无法确认”；此规则不能保证排除范围外对象。";
  return "服务端未提供有效分类阈值，请仅将候选作为观察参考。";
}

export function flowerCapability(health) {
  const details = (health && health.recognition) || {};
  const enabled =
    details.enabled === true ||
    (details.enabled === undefined &&
      health &&
      health.features &&
      health.features.recognition === true);
  return {
    enabled: Boolean(enabled),
    scope:
      details.scope ||
      (enabled
        ? "识别范围以当前启用模型的覆盖类别为限。"
        : "当前没有启用图像识别模型。"),
    labels: (Array.isArray(details.labels) ? details.labels : [])
      .filter((label) => label && typeof label === "object")
      .map((label) => ({
        id: label.id || label.label || label.name,
        name: label.name || label.label || label.id,
      })),
    modelName: details.model_name || "",
    modelVersion: details.model_version || "",
    threshold: details.threshold,
    thresholdNote: thresholdNote(details.threshold),
  };
}

/** Scores are model outputs, not calibrated probabilities of correctness. */
export function flowerResult(result) {
  if (!result || typeof result !== "object") return null;
  const candidates = (Array.isArray(result.candidates) ? result.candidates : [])
    .filter((candidate) => candidate && typeof candidate === "object")
    .slice(0, 3)
    .map((candidate, index) => {
      const valid =
        typeof candidate.score === "number" &&
        Number.isFinite(candidate.score) &&
        candidate.score >= 0 &&
        candidate.score <= 1;
      return Object.assign({}, candidate, {
        rank: index + 1,
        name: candidate.name || candidate.label || "未命名类别",
        score_label: valid ? candidate.score.toFixed(3) : "—",
        bar_width: valid ? (candidate.score * 100).toFixed(1) : "0",
      });
    });
  const recognized =
    result.decision === "recognized" &&
    candidates.length > 0 &&
    candidates[0].score_label !== "—";
  const lowQuality = result.reason === "LOW_IMAGE_QUALITY";
  return {
    recognized,
    reason: result.reason || "",
    decision: recognized ? "recognized" : "uncertain",
    heading: recognized
      ? (result.threshold === 0 ? "候选参考：" : "识别结果：") +
        candidates[0].name
      : "暂时无法确认",
    explanation: recognized
      ? "模型从支持类别中给出的候选，可结合科普资料进一步核对；未验证校园实拍与范围外对象。"
      : lowQuality
        ? "图片质量不足，本次未进行类别判断。请上传尺寸足够、主体清晰的照片。"
        : "这张照片不足以给出确定结果。请对准单个主体重新拍摄，或确认对象属于支持类别。",
    candidates,
    threshold_label:
      typeof result.threshold === "number" && Number.isFinite(result.threshold)
        ? result.threshold.toFixed(3)
        : "未提供",
    threshold_note: thresholdNote(result.threshold),
    model_name: (result.model && result.model.name) || "未提供模型名称",
    model_version: (result.model && result.model.version) || "未提供版本",
    disclaimer:
      result.disclaimer ||
      "候选分数未经校准，不代表判断正确的概率；覆盖类别之外的对象可能被误识别。",
  };
}

const SCOPE =
  "当前仅支持 IWHR 数据训练的水面漂浮物观察，不区分塑料瓶、排污口或其他生态类别。";
const DISCLAIMER =
  "图像教学规则分仅用于观察练习，不是官方生态等级或水质评价。检测框面积不是水面覆盖率，也不代表真实污染程度。";
const STATES = {
  queued: "等待处理",
  running: "观察中",
  succeeded: "观察完成",
  failed: "处理失败",
};

export function riverCapability(health) {
  const details = (health && health.assessment) || {};
  return {
    enabled:
      details.enabled === true ||
      (details.enabled === undefined &&
        Boolean(health && health.features && health.features.assessment)),
    scope: SCOPE,
    modelName: details.model_name || "",
    modelVersion: details.model_version || "",
    ruleVersion: details.rule_version || "",
  };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function dimension(value) {
  return finite(value) && value > 0;
}

/** Pixel boxes refer to the original image, never to a downloaded thumbnail's pixels. */
export function detectionViews(job) {
  const width = job.image_width;
  const height = job.image_height;
  return (Array.isArray(job.detections) ? job.detections : [])
    .filter(
      (item) =>
        item && item.class_id === 9 && item.eval_category === "floating_debris",
    )
    .map((item, index) => {
      const confidence =
        finite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
          ? item.confidence
          : null;
      const box = Array.isArray(item.bbox) ? item.bbox : [];
      const valid =
        dimension(width) &&
        dimension(height) &&
        box.length === 4 &&
        box.every(finite) &&
        box[0] >= 0 &&
        box[1] >= 0 &&
        box[2] > box[0] &&
        box[3] > box[1] &&
        box[2] <= width &&
        box[3] <= height;
      return {
        id: index,
        label: "水面漂浮物",
        confidence_label: confidence === null ? "—" : confidence.toFixed(3),
        box_style: valid
          ? `left:${(box[0] / width) * 100}%;top:${(box[1] / height) * 100}%;width:${((box[2] - box[0]) / width) * 100}%;height:${((box[3] - box[1]) / height) * 100}%;`
          : "",
      };
    });
}

export function riverResult(job) {
  if (!job || job.status !== "succeeded") return null;
  const detections = detectionViews(job);
  // An empty detection set never implies clean water, even for old or malformed results.
  const score =
    detections.length && finite(job.score) && job.score >= 0 && job.score <= 100
      ? job.score
      : null;
  const causes = (Array.isArray(job.causes) ? job.causes : [])
    .map((item) => (typeof item === "string" ? item : item && item.text))
    .filter(Boolean);
  const suggestions = (Array.isArray(job.suggestions) ? job.suggestions : [])
    .map((item) => (typeof item === "string" ? item : item && item.text))
    .filter(Boolean);
  return {
    heading: detections.length ? "发现漂浮物候选" : "暂时无法确认",
    explanation: detections.length
      ? "这些是模型候选，需结合照片与现场情况人工核对。置信分数不是正确概率。"
      : "未检出可展示的漂浮物候选，不能据此认定没有污染或水质良好。",
    score_label: score === null ? "—" : String(score),
    has_score: score !== null,
    detections,
    boxes: detections.filter((item) => item.box_style),
    causes,
    suggestions: suggestions.length
      ? suggestions
      : [
          "可在安全位置补拍清晰照片，结合现场观察人工核对；不要仅凭照片作水质或污染判定。",
        ],
    model_name: (job.model && job.model.name) || "未提供",
    model_version: (job.model && job.model.version) || "未提供",
    rule_version: job.rule_version || "未提供",
    disclaimer: DISCLAIMER,
  };
}

function imageEligible(item, now = Date.now()) {
  return Boolean(
    item &&
    ["succeeded", "failed"].includes(item.status) &&
    typeof item.id === "string" &&
    item.id &&
    typeof item.asset_id === "string" &&
    item.asset_id &&
    (!item.expires_at || Date.parse(item.expires_at) > now),
  );
}

function assessmentTask(item) {
  const view = riverResult(item);
  return Object.assign({}, item, {
    status_label: STATES[item.status] || "状态未知",
    created_label: time(item.created_at),
    error_label:
      item.error_code === "MODEL_NOT_CONFIGURED"
        ? "河道观察模型当前未启用，本次未产生结论。"
        : item.message || item.error_message || "",
    result_view: view,
    can_image_ai: imageEligible(item),
    title: "河道图像观察",
  });
}

const LABELS = [
  "左上",
  "上中",
  "右上",
  "左中",
  "中央",
  "右中",
  "左下",
  "下中",
  "右下",
];
const ratio = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 300;
const UNAVAILABLE =
  "这条记录暂不能生成观察摘要。未检出或资料不完整，都不能说明水体清洁。";

export function summaryView(job) {
  if (!job || job.status !== "succeeded") return null;
  const value = job.observation_summary;
  // An older backend/result must never become a made-up zero or a clean-water claim.
  if (!value || value.schema_version !== 1)
    return { ready: false, message: UNAVAILABLE };
  if (value.status !== "ready") {
    const messages = {
      LOW_IMAGE_QUALITY:
        "照片质量不足，暂不能生成观察摘要。可以在安全位置补拍清晰照片。",
      INVALID_IMAGE_DIMENSIONS:
        "这条记录缺少有效原图尺寸，暂不能生成位置分布和框面积摘要。",
    };
    return { ready: false, message: messages[value.reason] || UNAVAILABLE };
  }
  const confidence = value.confidence || {};
  const grid = value.grid;
  const validGrid =
    Array.isArray(grid) &&
    grid.length === 9 &&
    grid.every(
      (cell, index) => cell && cell.key === String(index) && count(cell.count),
    ) &&
    grid.reduce((total, cell) => total + cell.count, 0) ===
      value.candidate_count;
  if (
    !count(value.candidate_count) ||
    !value.candidate_count ||
    !count(value.excluded_count) ||
    value.candidate_count + value.excluded_count > 300 ||
    !ratio(value.box_area_ratio) ||
    !ratio(confidence.min) ||
    !ratio(confidence.max) ||
    !ratio(confidence.mean) ||
    confidence.min > confidence.mean ||
    confidence.mean > confidence.max ||
    !validGrid
  ) {
    return { ready: false, message: UNAVAILABLE };
  }
  const percent = value.box_area_ratio * 100;
  return {
    ready: true,
    count: value.candidate_count,
    excluded: value.excluded_count,
    area: percent > 0 && percent < 0.01 ? "< 0.01%" : percent.toFixed(2) + "%",
    confidence: confidence.min.toFixed(3) + " – " + confidence.max.toFixed(3),
    grid: grid.map((cell, index) => ({
      key: cell.key,
      label: LABELS[index],
      count: cell.count,
      active: cell.count > 0,
    })),
  };
}
