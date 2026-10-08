// These deliberately illustrative series never enter the live-weather cache.
export const SCENARIOS = [
  { id: "steady", name: "平稳晴日", color: "#3a7d5c", subtitle: "从一天的平缓变化开始观察", explanation: "示例中温度随日照升高，其他指标小幅波动。单个读数需要放在时间趋势和测量条件里理解。", series: { temperature: [17,18,21,25,26,23,20], ph: [7.2,7.2,7.3,7.4,7.4,7.3,7.2], turbidity: [9,10,9,11,10,9,9], oxygen: [7.8,7.7,7.5,7.2,7.1,7.4,7.7] } },
  { id: "rain", name: "降雨之后", color: "#598b9b", subtitle: "留意雨前与雨后的差异", explanation: "此情景演示降雨径流伴随浊度升高、温度回落的可能变化。现实中的幅度和原因需要现场采样核实，不能据此判断某条河流。", series: { temperature: [25,25,24,22,21,21,22], ph: [7.4,7.4,7.3,7.1,7.0,7.1,7.2], turbidity: [10,12,28,46,41,30,22], oxygen: [7.2,7.1,7.0,7.3,7.6,7.5,7.4] } },
  { id: "heat", name: "高温午后", color: "#b5764d", subtitle: "比较温度与溶解氧的变化", explanation: "教学曲线演示升温与溶解氧下降的可能关系。光合作用、流速与天气也会影响观测；曲线不用于安全判断。", series: { temperature: [24,26,29,32,33,30,27], ph: [7.2,7.3,7.4,7.6,7.7,7.5,7.3], turbidity: [11,12,12,13,12,11,11], oxygen: [7.1,6.9,6.4,5.9,5.6,6.1,6.6] } },
  { id: "check", name: "异常读数复核", color: "#9a6b7e", subtitle: "先核对设备，再解释变化", explanation: "单次突变后迅速恢复，可能与传感器、采样或真实短时变化有关。先复测、校准并核对记录，不直接生成污染结论。", series: { temperature: [21,21,22,22,23,22,21], ph: [7.2,7.3,7.2,9.1,7.3,7.2,7.2], turbidity: [10,11,10,55,12,11,10], oxygen: [7.5,7.4,7.3,4.1,7.3,7.4,7.5] } },
];
export const METRICS = [
  { id: "temperature", label: "水温", unit: "℃" }, { id: "ph", label: "酸碱度", unit: "pH" },
  { id: "turbidity", label: "浊度", unit: "NTU" }, { id: "oxygen", label: "溶解氧", unit: "mg/L" },
];
export function chartPoints(values, width = 640, height = 150) {
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  return values.map((value, i) => [20 + i * (width - 40) / (values.length - 1), height - 20 - (value - min) / span * (height - 40)]);
}
