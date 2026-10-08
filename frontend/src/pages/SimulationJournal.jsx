import React, { useState, useId } from "react";
import { Link } from "react-router-dom";
import { Waves, BarChart3, ArrowUpRight, FlaskConical } from "lucide-react";
import { SCENARIOS, METRICS, chartPoints } from "./simulation-domain";
import "./SimulationJournal.css";
export default function SimulationJournal() {
  const [selected, setSelected] = useState("steady"), [metric, setMetric] = useState("oxygen");
  const scenario = SCENARIOS.find(s => s.id === selected), current = METRICS.find(m => m.id === metric);
  const values = scenario.series[metric], points = chartPoints(values), gradient = "sim" + useId().replaceAll(":", "");
  return <section className="simulation-journal" style={{ "--scenario": scenario.color }}>
    <div className="simulation-heading"><div><h2>生态观察</h2><p>换一种情景，读懂曲线里的变化。</p></div><span className="simulation-label"><FlaskConical size={15}/>科普模拟 · 非实测</span></div>
    <nav className="simulation-links simulation-links--navigation" aria-label="生态观察相关功能"><Link to="/water"><Waves size={21}/><span>智慧河湖<small>模拟指标与观察方法</small></span><ArrowUpRight size={18}/></Link><Link to="/data-center"><BarChart3 size={21}/><span>生态数据中心<small>历史趋势与观测明细</small></span><ArrowUpRight size={18}/></Link></nav>
    <div className="simulation-scenarios" role="group" aria-label="选择模拟情景">{SCENARIOS.map(s => <button key={s.id} aria-pressed={s.id===selected} onClick={() => setSelected(s.id)}>{s.name}</button>)}</div>
    <div className="simulation-body"><div className="simulation-chart"><h3>{scenario.subtitle}</h3><div className="simulation-metrics">{METRICS.map(m => <button key={m.id} aria-pressed={m.id===metric} onClick={() => setMetric(m.id)}><span>{m.label}</span><strong>{scenario.series[m.id][3]}<small>{m.unit}</small></strong></button>)}</div>
      <svg viewBox="0 0 640 150" role="img" aria-label={`${scenario.name}，${current.label}模拟趋势，依次为${values.join('、')}${current.unit}`}><defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={scenario.color} stopOpacity=".22"/><stop offset="100%" stopColor={scenario.color} stopOpacity="0"/></linearGradient></defs>{[35,75,115].map(y=><path key={y} d={`M20 ${y}H620`} stroke="currentColor" opacity=".08"/>)}<path d={`M20 145 L${points.map(p=>p.join(',')).join(' L')} L620 145 Z`} fill={`url(#${gradient})`}/><polyline points={points.map(p=>p.join(',')).join(' ')} fill="none" stroke={scenario.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>{points.map(([x,y],i)=><circle key={i} cx={x} cy={y} r="4" fill={scenario.color}><title>{['06:00','09:00','12:00','15:00','18:00','21:00','24:00'][i]} · {values[i]} {current.unit}</title></circle>)}</svg>
      <div className="simulation-axis"><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div><p className="simulation-note">教学示例日 · {current.label} {Math.min(...values)}–{Math.max(...values)} {current.unit} · 各指标纵轴独立缩放</p></div>
      <aside><span className="eyebrow">观察提示</span><h3>{scenario.name}</h3><p>{scenario.explanation}</p><details><summary>查看此情景的全部数值</summary><div className="simulation-table-wrap"><table><thead><tr><th>时间</th>{METRICS.map(m=><th key={m.id}>{m.label}<br/>{m.unit}</th>)}</tr></thead><tbody>{values.map((_,i)=><tr key={i}><td>{String(6+i*3).padStart(2,'0')}:00</td>{METRICS.map(m=><td key={m.id}>{scenario.series[m.id][i]}</td>)}</tr>)}</tbody></table></div></details></aside></div>
  </section>;
}
