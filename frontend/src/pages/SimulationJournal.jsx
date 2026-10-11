import React, { useState, useId, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  Waves,
  BarChart3,
  ArrowUpRight,
  FlaskConical,
  Bell,
} from "lucide-react";
import { SCENARIOS, METRICS, chartPoints } from "./simulation-domain";
import { Modal } from "../components";
import { useAuth } from "../state";
import { api } from "../lib/api";
import { notifyNotificationsChanged } from "../NotificationButton";
import "./SimulationJournal.css";
export default function SimulationJournal() {
  const [selected, setSelected] = useState("steady"),
    [metric, setMetric] = useState("oxygen"),
    [reminderOpen, setReminderOpen] = useState(false),
    [sending, setSending] = useState(false),
    [reminderSent, setReminderSent] = useState(false),
    [reminderError, setReminderError] = useState("");
  const { user, loading: authLoading } = useAuth();
  const identity = useRef({ id: user?.id, alive: true }),
    request = useRef(null),
    mutation = useRef(false);
  if (identity.current.id !== user?.id)
    identity.current = { id: user?.id, alive: true };
  useEffect(() => {
    setReminderOpen(false);
    setSending(false);
    setReminderSent(false);
    setReminderError("");
    request.current = null;
    mutation.current = false;
  }, [user?.id]);
  useEffect(
    () => () => {
      identity.current.alive = false;
    },
    [],
  );
  async function sendSimulation() {
    if (!user || mutation.current) return;
    const ticket = identity.current;
    mutation.current = true;
    setSending(true);
    setReminderError("");
    if (!request.current) request.current = crypto.randomUUID();
    try {
      await api("weather-data/reminders/simulation-test/", {
        method: "POST",
        data: { request_key: request.current },
      });
      if (identity.current !== ticket || !ticket.alive) return;
      request.current = null;
      setReminderSent(true);
      notifyNotificationsChanged();
    } catch (error) {
      if (identity.current === ticket && ticket.alive)
        setReminderError(error.message);
    } finally {
      if (identity.current === ticket && ticket.alive) {
        mutation.current = false;
        setSending(false);
      }
    }
  }
  const scenario = SCENARIOS.find((s) => s.id === selected),
    current = METRICS.find((m) => m.id === metric);
  const values = scenario.series[metric],
    points = chartPoints(values),
    gradient = "sim" + useId().replaceAll(":", "");
  return (
    <section
      className="simulation-journal"
      id="ecology-observation"
      style={{ "--scenario": scenario.color }}
    >
      <div className="simulation-heading">
        <div>
          <h2>生态观察</h2>
          <p>海晏河清示范校园 · 虚拟数据</p>
        </div>
        <span className="simulation-label">
          <FlaskConical size={15} />
          科普模拟 · 非实测
        </span>
      </div>
      <nav
        className="simulation-links simulation-links--navigation"
        aria-label="生态观察相关功能"
      >
        <Link to="/water?region=demo-campus">
          <Waves size={21} />
          <span>
            智慧河湖<small>模拟指标与观察方法</small>
          </span>
          <ArrowUpRight size={18} />
        </Link>
        <Link to="/data-center?region=demo-campus">
          <BarChart3 size={21} />
          <span>
            生态数据中心<small>历史趋势与观测明细</small>
          </span>
          <ArrowUpRight size={18} />
        </Link>
      </nav>
      <div
        className="simulation-scenarios"
        role="group"
        aria-label="选择模拟情景"
      >
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            aria-pressed={s.id === selected}
            onClick={() => setSelected(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div className="simulation-body">
        <div className="simulation-chart">
          <h3>{scenario.subtitle}</h3>
          <div className="simulation-metrics">
            {METRICS.map((m) => (
              <button
                key={m.id}
                aria-pressed={m.id === metric}
                onClick={() => setMetric(m.id)}
              >
                <span>{m.label}</span>
                <strong>
                  {scenario.series[m.id][3]}
                  <small>{m.unit}</small>
                </strong>
              </button>
            ))}
          </div>
          <svg
            viewBox="0 0 640 150"
            role="img"
            aria-label={`${scenario.name}，${current.label}模拟趋势，依次为${values.join("、")}${current.unit}`}
          >
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={scenario.color}
                  stopOpacity=".22"
                />
                <stop
                  offset="100%"
                  stopColor={scenario.color}
                  stopOpacity="0"
                />
              </linearGradient>
            </defs>
            {[35, 75, 115].map((y) => (
              <path
                key={y}
                d={`M20 ${y}H620`}
                stroke="currentColor"
                opacity=".08"
              />
            ))}
            <path
              d={`M20 145 L${points.map((p) => p.join(",")).join(" L")} L620 145 Z`}
              fill={`url(#${gradient})`}
            />
            <polyline
              points={points.map((p) => p.join(",")).join(" ")}
              fill="none"
              stroke={scenario.color}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {points.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r="4" fill={scenario.color}>
                <title>
                  {
                    [
                      "06:00",
                      "09:00",
                      "12:00",
                      "15:00",
                      "18:00",
                      "21:00",
                      "24:00",
                    ][i]
                  }{" "}
                  · {values[i]} {current.unit}
                </title>
              </circle>
            ))}
          </svg>
          <div className="simulation-axis">
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>24:00</span>
          </div>
          <p className="simulation-note">
            教学示例日 · {current.label} {Math.min(...values)}–
            {Math.max(...values)} {current.unit} · 各指标纵轴独立缩放
          </p>
        </div>
        <aside>
          <span className="eyebrow">观察提示</span>
          <h3>{scenario.name}</h3>
          <p>{scenario.explanation}</p>
          <details>
            <summary>查看此情景的全部数值</summary>
            <div className="simulation-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    {METRICS.map((m) => (
                      <th key={m.id}>
                        {m.label}
                        <br />
                        {m.unit}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {values.map((_, i) => (
                    <tr key={i}>
                      <td>{String(6 + i * 3).padStart(2, "0")}:00</td>
                      {METRICS.map((m) => (
                        <td key={m.id}>{scenario.series[m.id][i]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </aside>
      </div>
      <div className="simulation-reminder-footer">
        <button
          className="btn secondary"
          type="button"
          onClick={() => {
            setReminderError("");
            setReminderSent(false);
            setReminderOpen(true);
          }}
        >
          <Bell size={17} /> 模拟异常提醒
        </button>
      </div>
      {reminderOpen && (
        <Modal
          title="模拟异常提醒"
          className="simulation-reminder-modal"
          onClose={() => {
            if (!mutation.current) setReminderOpen(false);
          }}
        >
          <div className="modal-body">
            <p>
              固定异常演练，与当前图表无关，非实测预警。确认后立即发送一次站内提醒。
            </p>
            <blockquote>模拟异常：浊度偏高，请复核</blockquote>
            {reminderError && (
              <p role="alert" className="inline-warning">
                {reminderError}
              </p>
            )}
            {reminderSent ? (
              <>
                <p role="status">已发送到站内通知中心。</p>
                <Link
                  className="btn full"
                  to="/notifications"
                  onClick={() => setReminderOpen(false)}
                >
                  查看站内通知
                </Link>
              </>
            ) : authLoading ? (
              <p>正在读取账号…</p>
            ) : !user ? (
              <Link className="btn full" to="/login?next=/">
                登录后体验
              </Link>
            ) : (
              <button
                className="btn full"
                disabled={sending}
                onClick={sendSimulation}
              >
                {sending ? "正在发送…" : "立即发送一次"}
              </button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
