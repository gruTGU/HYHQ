'use strict';
// Fixed educational samples at the fourth (15:00) point of the observation
// journal. Appointment time controls delivery only; these are never live data.
const CAMPUS = '海晏河清示范校园';
const RULE_NOTICE = '本平台仿真规则，不是水质标准';
const SCENARIOS = Object.freeze({
  steady: { name: '平稳晴日', temperature: 25, ph: 7.4, turbidity: 11, oxygen: 7.2 },
  rain: { name: '降雨之后', temperature: 22, ph: 7.1, turbidity: 46, oxygen: 7.3 },
  heat: { name: '高温午后', temperature: 32, ph: 7.6, turbidity: 13, oxygen: 5.9 },
  check: { name: '异常读数复核', temperature: 22, ph: 9.1, turbidity: 55, oxygen: 4.1 },
});
function preview(scenario) {
  const row = typeof scenario === 'string' && Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : null;
  if (!row) return null;
  const metrics = [
    { id: 'temperature', label: '水温', value: row.temperature, unit: '℃', rule: '>30℃', triggered: row.temperature > 30 },
    { id: 'ph', label: '酸碱度', value: row.ph, unit: 'pH', rule: '<6.5或>8.5', triggered: row.ph < 6.5 || row.ph > 8.5 },
    { id: 'turbidity', label: '浊度', value: row.turbidity, unit: 'NTU', rule: '≥40NTU', triggered: row.turbidity >= 40 },
    { id: 'oxygen', label: '溶解氧', value: row.oxygen, unit: 'mg/L', rule: '<6mg/L', triggered: row.oxygen < 6 },
  ];
  const alerts = metrics.filter(metric => metric.triggered);
  const summaries = { steady: '模拟：平稳晴日，指标平稳', rain: '模拟：降雨后，浊度46NTU', heat: '模拟：水温32℃，溶氧5.9', check: '模拟：pH9.1，含3项异常' };
  return { type: 'ecology_simulation', scenario, scenario_name: row.name, campus: CAMPUS, source_type: 'simulation',
    sample_label: '固定15:00演示样本，非预约时刻实测值', rule_notice: RULE_NOTICE, metrics, alert_count: alerts.length,
    state: alerts.length ? 'simulation_alert' : 'simulation_normal',
    description: alerts.length ? alerts.map(metric => `${metric.label}${metric.value}${metric.unit}（规则${metric.rule}）`).join('；') : '本组演示指标未触发仿真规则。',
    reminder_text: summaries[scenario] };
}
module.exports = { CAMPUS, RULE_NOTICE, SCENARIOS, preview };
