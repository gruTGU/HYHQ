const LABELS = ['左上', '上中', '右上', '左中', '中央', '右中', '左下', '下中', '右下'];
const ratio = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 300;
const UNAVAILABLE = '这条记录暂不能生成观察摘要。未检出或资料不完整，都不能说明水体清洁。';

function summaryView(job) {
  if (!job || job.status !== 'succeeded') return null;
  const value = job.observation_summary;
  // An older backend/result must never become a made-up zero or a clean-water claim.
  if (!value || value.schema_version !== 1) return { ready: false, message: UNAVAILABLE };
  if (value.status !== 'ready') {
    const messages = {
      LOW_IMAGE_QUALITY: '照片质量不足，暂不能生成观察摘要。可以在安全位置补拍清晰照片。',
      INVALID_IMAGE_DIMENSIONS: '这条记录缺少有效原图尺寸，暂不能生成位置分布和框面积摘要。',
    };
    return { ready: false, message: messages[value.reason] || UNAVAILABLE };
  }
  const confidence = value.confidence || {};
  const grid = value.grid;
  const validGrid = Array.isArray(grid) && grid.length === 9 && grid.every((cell, index) => cell
    && cell.key === String(index) && count(cell.count)) && grid.reduce((total, cell) => total + cell.count, 0) === value.candidate_count;
  if (!count(value.candidate_count) || !value.candidate_count || !count(value.excluded_count)
      || value.candidate_count + value.excluded_count > 300 || !ratio(value.box_area_ratio)
      || !ratio(confidence.min) || !ratio(confidence.max) || !ratio(confidence.mean)
      || confidence.min > confidence.mean || confidence.mean > confidence.max || !validGrid) {
    return { ready: false, message: UNAVAILABLE };
  }
  const percent = value.box_area_ratio * 100;
  return {
    ready: true,
    count: value.candidate_count,
    excluded: value.excluded_count,
    area: percent > 0 && percent < .01 ? '< 0.01%' : percent.toFixed(2) + '%',
    confidence: confidence.min.toFixed(3) + ' – ' + confidence.max.toFixed(3),
    grid: grid.map((cell, index) => ({ key: cell.key, label: LABELS[index], count: cell.count, active: cell.count > 0 })),
  };
}

module.exports = { summaryView };
