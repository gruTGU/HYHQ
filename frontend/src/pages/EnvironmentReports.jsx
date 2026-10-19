import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  ClipboardList,
  ChevronRight,
  ExternalLink,
  LockKeyhole,
  MapPin,
  Send,
} from "lucide-react";
import { api, allPages } from "../lib/api";
import { useAuth } from "../state";
import { Modal, PageHeader, State } from "../components";
import {
  ENVIRONMENT_NOTE,
  validEnvironmentDescription,
} from "./activity-domain";
import "./Activities.css";

export function EnvironmentNotice() {
  return (
    <p className="activity-simulation">
      <span>私密 · 模拟演示</span>
      {ENVIRONMENT_NOTE}
    </p>
  );
}

export function EnvironmentFeedbackEntry({ task, river, photo }) {
  const { user } = useAuth(),
    [open, setOpen] = useState(false);
  return (
    <>
      {user ? (
        <button
          className="btn secondary environment-entry-button"
          onClick={() => setOpen(true)}
          aria-label="查看环境情况并填写反馈"
          title="核对环境情况，选择是否提交给平台管理员"
        >
          环境情况 <ChevronRight size={16} aria-hidden="true" />
        </button>
      ) : (
        <Link
          className="btn secondary environment-entry-button"
          to="/login"
          aria-label="登录后查看环境情况并填写反馈"
        >
          环境情况 <ChevronRight size={16} aria-hidden="true" />
        </Link>
      )}
      {open && user && (
        <EnvironmentReportDialog
          key={user.id + task.id}
          task={task}
          river={river}
          photo={photo}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function EnvironmentReportDialog({ task, river, photo, onClose }) {
  const [context, setContext] = useState(null),
    [places, setPlaces] = useState([]),
    [location, setLocation] = useState("");
  const [description, setDescription] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [saved, setSaved] = useState(null);
  const [photoReady, setPhotoReady] = useState(false),
    [photoFailed, setPhotoFailed] = useState(false);
  const active = useRef(true),
    taskKind = river ? "assessment" : "recognition";
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api("environment-reports/context/", {
        data: { task_kind: taskKind, task_id: task.id },
        signal: controller.signal,
      }),
      allPages("places/", { signal: controller.signal }),
      api("web/map-points/", { signal: controller.signal }),
    ])
      .then(([response, catalog, references]) => {
        if (controller.signal.aborted) return;
        const ctx = response.data,
          points = Array.isArray(references.data)
            ? references.data
            : references.data?.points || references.data?.locations || [];
        const list = [
          ...catalog
            .filter((p) => p.is_published !== false && !p.is_demo)
            .map((p) => ({
              key: "place:" + p.id,
              place_id: p.id,
              name: p.name,
            })),
          ...points.map((p) => ({
            key: "reference:" + p.id,
            map_reference_id: p.id,
            name: p.name,
          })),
        ];
        const original = ctx.location;
        if (original?.place_id || original?.map_reference_id) {
          const key = original.place_id
            ? "place:" + original.place_id
            : "reference:" + original.map_reference_id;
          if (!list.some((p) => p.key === key))
            list.unshift({ ...original, key });
          setLocation(key);
        }
        setContext(ctx);
        setPlaces(list);
        setSaved(ctx.existing_report || null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [task.id, taskKind, revision]);

  async function submit(event) {
    event.preventDefault();
    const selected = places.find((p) => p.key === location);
    if (
      busy ||
      !selected ||
      !confirmed ||
      !photoReady ||
      !validEnvironmentDescription(description)
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await api("environment-reports/", {
        method: "POST",
        data: {
          task_kind: taskKind,
          task_id: task.id,
          description: description.trim(),
          ...(selected.place_id
            ? { place_id: selected.place_id }
            : { map_reference_id: selected.map_reference_id }),
        },
      });
      if (active.current) setSaved(response.data);
    } catch (e) {
      if (active.current)
        setError(
          e.message +
            " 如提交状态未确认，请先到我的环境反馈核对，避免重复提交。",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <Modal
      title={
        saved
          ? "环境反馈已保存"
          : river
            ? "该地河道情况如何？"
            : "该地环境情况如何？"
      }
      className="activity-dialog environment-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {!saved && (
        <p className="environment-intent">
          是否选择上报有关部门？当前反馈仅提交给平台管理员，供私密模拟处理，未发送给政府或环保部门。请先核对地点、照片与实际观察；图像识别不能判断污染程度或水质等级。
        </p>
      )}
      <EnvironmentNotice />
      <section
        className="environment-official-links"
        aria-label="生态环境局官网通知与信息"
      >
        <h3>官网通知与信息</h3>
        <p className="activity-note">
          可自行打开官网查看通知与公开信息；网站跳转不会提交本次照片或反馈。
        </p>
        <div className="activity-actions">
          <a
            className="btn secondary"
            href="https://sthj.tj.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            天津生态环境局网站跳转 <ExternalLink size={15} aria-hidden="true" />
          </a>
          <a
            className="btn secondary"
            href="https://sthjj.beijing.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            北京生态环境局网站跳转 <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
      </section>
      {saved ? (
        <div className="environment-saved">
          <Check size={34} />
          <h3>
            {saved.status === "resolved"
              ? "管理员已回复"
              : "已进入平台管理员待办"}
          </h3>
          <p>
            这条识别记录已有环境反馈，可查看处理进度。未向政府或环保部门发送任何内容。
          </p>
          <div className="activity-actions">
            <Link className="btn" to="/environment-reports" onClick={onClose}>
              查看我的环境反馈
            </Link>
            <button className="btn secondary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      ) : (
        <State
          loading={loading}
          error={!context && error}
          onRetry={() => setRevision((v) => v + 1)}
        >
          {context && (
            <form className="environment-form" onSubmit={submit}>
              <figure className="environment-photo">
                {(context.photo_url || photo) && !photoFailed ? (
                  <img
                    src={context.photo_url || photo}
                    alt="本次识别照片的缩略图，请核对"
                    onLoad={() => setPhotoReady(true)}
                    onError={() => {
                      setPhotoFailed(true);
                      setPhotoReady(false);
                    }}
                  />
                ) : (
                  <p role="alert">照片暂不可用，请重新打开识别记录核对。</p>
                )}
                <figcaption>
                  本次识别照片缩略图 · 仅本人和处理反馈的管理员可查看
                </figcaption>
              </figure>
              <label>
                核对地点
                <select
                  required
                  value={location}
                  disabled={busy}
                  onChange={(e) => {
                    setLocation(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">请选择实际拍摄地点</option>
                  {places.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="activity-note">
                {context.location_hint ||
                  "请只选择照片实际拍摄的地点。若列表没有对应地点，请先保留记录，不要选择相近地点代替。"}
              </p>
              <label>
                现场观察描述
                <textarea
                  required
                  minLength={5}
                  maxLength={1000}
                  rows={4}
                  placeholder="例如：步道东侧草地上有几处塑料包装，照片摄于今天下午。只描述实际看到的情况。"
                  value={description}
                  disabled={busy}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <small>{[...description].length} / 1000 字，至少 5 字</small>
              <p className="activity-note">
                {typeof context.observation === "string" && context.observation}{" "}
                图像模型不能测量水质，也不能据此作出污染结论。
              </p>
              <label className="environment-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  我已核对照片、地点和描述，了解这是仅供平台管理员处理的私密模拟反馈。
                </span>
              </label>
              {error && (
                <p className="activity-error" role="alert">
                  {error}
                </p>
              )}
              <div className="activity-actions">
                <button
                  className="btn"
                  disabled={
                    busy ||
                    !confirmed ||
                    !location ||
                    !validEnvironmentDescription(description) ||
                    !photoReady
                  }
                >
                  <Send size={16} />
                  {busy ? "正在提交…" : "提交给平台管理员"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy}
                  onClick={onClose}
                >
                  暂不提交
                </button>
              </div>
            </form>
          )}
        </State>
      )}
    </Modal>
  );
}

function ReportCard({ report, admin, onReview }) {
  return (
    <article className="card environment-report">
      <div className="activity-card-top">
        <span className="activity-badge">
          {report.status === "resolved" ? "已回复" : "待处理"} · 模拟反馈
        </span>
        <small>{String(report.created_at || "").slice(0, 10)}</small>
      </div>
      <h2>
        <MapPin size={18} />
        {report.location?.name || "关联地点"}
      </h2>
      {report.photo_url && (
        <img
          className="environment-report-photo"
          src={report.photo_url}
          alt="环境反馈照片缩略图"
          loading="lazy"
        />
      )}
      <p className="environment-description">{report.description}</p>
      <p className="activity-note">
        {typeof report.observation === "string" && report.observation}
      </p>
      {report.reply && (
        <blockquote>
          <strong>平台管理员答复</strong>
          <p>{report.reply}</p>
        </blockquote>
      )}
      {admin && (
        <div className="activity-actions">
          <button className="btn secondary" onClick={() => onReview(report)}>
            {report.status === "resolved"
              ? "查看与更新处理记录"
              : "处理私密待办"}
          </button>
        </div>
      )}
    </article>
  );
}

function reportTemplate(report) {
  return [
    "环境观察记录 · 模拟上报模板（未发送）",
    "",
    "本模板仅供人工核对，未提交政府或环保部门。",
    "地点：" + (report.location?.name || "待核对"),
    "记录时间：" + (report.created_at || ""),
    "反馈编号：" + report.id,
    "",
    "现场描述：",
    report.description,
    "",
    "观察说明：",
    typeof report.observation === "string"
      ? report.observation
      : "图片识别仅为观察参考。",
    "",
    "图片不能证明污染或判定水质等级。实际情况需要现场核实。",
    "照片：仅附在平台私密反馈中，不在此文本中公开链接。",
    "",
    "人工核对与处理意见：",
    report.reply || "（待补充）",
  ].join("\n");
}

function ReportReview({ report, onClose, onSaved }) {
  const [reply, setReply] = useState(report.reply || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [template, setTemplate] = useState("");
  const [revision, setRevision] = useState(null);
  const [conflicted, setConflicted] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api("personal-admin/status/", { signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) setRevision(r.data?.revision ?? null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  async function resolve(event) {
    event.preventDefault();
    if (busy || !reply.trim() || revision === null || conflicted) return;
    setBusy(true);
    setError("");
    try {
      await api(
        "personal-admin/environment-reports/" +
          encodeURIComponent(report.id) +
          "/resolve/",
        {
          method: "POST",
          data: { reply: reply.trim(), expected_revision: revision },
        },
      );
      onSaved();
    } catch (e) {
      if (e.code === "ADMIN_REVISION_CHANGED") {
        setConflicted(true);
        try {
          const status = await api("personal-admin/status/");
          setRevision(status.data?.revision ?? null);
          setError(
            "管理记录已被更新，请关闭弹窗并刷新列表核对最新反馈，再重新处理。",
          );
        } catch (refreshError) {
          setRevision(null);
          setError(refreshError.message);
        }
      } else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([template], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "环境观察模拟模板-" + report.id + ".txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Modal
      title="处理环境反馈 · 私密待办"
      className="activity-dialog environment-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <EnvironmentNotice />
      <ReportCard report={report} />
      <form className="environment-form" onSubmit={resolve}>
        <label>
          平台答复
          <textarea
            rows={4}
            value={reply}
            required
            maxLength={1000}
            onChange={(e) => setReply(e.target.value)}
            disabled={busy}
            placeholder="记录核对结果和处理建议；不得标记为已向政府发送。"
          />
        </label>
        {error && (
          <p className="activity-error" role="alert">
            {error}
          </p>
        )}
        <div className="activity-actions">
          <button
            className="btn"
            disabled={busy || !reply.trim() || revision === null || conflicted}
          >
            {busy ? "正在保存…" : "保存答复并标记已处理"}
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setTemplate(reportTemplate({ ...report, reply }))}
          >
            生成模拟上报模板
          </button>
        </div>
      </form>
      {template && (
        <div className="environment-template">
          <label>
            可复制的模拟模板 · 未发送
            <textarea
              rows={10}
              readOnly
              value={template}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <div className="activity-actions">
            <button className="btn secondary" onClick={download}>
              下载文本模板
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function EnvironmentReportsPage({ admin = false }) {
  const { user } = useAuth();
  return (
    <main className="activities-page">
      <PageHeader
        eyebrow={
          admin ? "MANAGEMENT / 私密环境待办" : "ENVIRONMENT / 我的环境反馈"
        }
        title={admin ? "环境反馈 · 管理员待办" : "我的环境反馈"}
      >
        <Link className="btn secondary" to={admin ? "/admin" : "/recognize"}>
          {admin ? "返回管理工作台" : "去识别并记录"}
        </Link>
      </PageHeader>
      <EnvironmentNotice />
      {!user ? (
        <div className="card activity-empty">
          <LockKeyhole size={25} />
          <p>登录后查看属于自己的私密环境反馈。</p>
          <Link className="btn" to="/login">
            登录
          </Link>
        </div>
      ) : admin && user.role !== "admin" ? (
        <State error="当前账号无管理权限。" />
      ) : (
        <EnvironmentReportList key={user.id + String(admin)} admin={admin} />
      )}
    </main>
  );
}

function EnvironmentReportList({ admin }) {
  const [rows, setRows] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [filter, setFilter] = useState(admin ? "pending" : ""),
    [selected, setSelected] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRows([]);
    setError("");
    allPages(
      (admin ? "personal-admin/" : "") +
        "environment-reports/" +
        (filter ? "?status=" + filter : ""),
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setRows(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [admin, filter, revision]);
  return (
    <>
      <div className="activity-calendar-heading">
        <label>
          处理进度{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">全部</option>
            <option value="pending">待处理</option>
            <option value="resolved">已回复</option>
          </select>
        </label>
        <button
          className="btn secondary"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          刷新记录
        </button>
      </div>
      <State
        loading={loading}
        error={error}
        onRetry={() => setRevision((v) => v + 1)}
      >
        {rows.length ? (
          <div className="activity-grid">
            {rows.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                admin={admin}
                onReview={setSelected}
              />
            ))}
          </div>
        ) : (
          <div className="card activity-empty">
            <ClipboardList size={28} />
            <p>
              {admin
                ? "当前没有符合条件的环境反馈。"
                : "暂无环境反馈。花卉或河道识别完成后，可点击结果标题旁的“环境情况”提交。"}
            </p>
          </div>
        )}
      </State>
      {selected && (
        <ReportReview
          report={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            setRevision((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
