import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  ClipboardList,
  MessageSquare,
  Archive,
  Plus,
  RefreshCw,
  Edit3,
  Save,
  Trash2,
  FilePenLine,
  ShieldCheck,
} from "lucide-react";
import { api, allPages } from "../lib/api";
import { useAuth, useToast } from "../state";
import { PageHeader, State, Modal } from "../components";

const label = {
  users_active: "活跃账号",
  regions: "区域",
  places: "公开地点",
  contents: "科普文章",
  routes: "漫步路线",
  stations: "监测站",
  water_bodies: "模拟河湖",
  simulation_runs: "模拟批次",
  observations: "模拟观测",
  rivers: "河道线",
  pending: "待处理",
  resolved: "已处理",
  recognition_jobs: "花卉识别",
  assessment_jobs: "河道观察",
};
const categoryNames = {
  green: "绿色生活",
  plants: "植物知识",
  water: "水资源保护",
  travel: "生态智游",
};
const kindNames = {
  river: "河流",
  lake: "湖泊",
  park: "公园",
  plant: "植物观察",
  waste: "环保设施",
  trail: "步道",
  campus: "校园",
  landmark: "地标",
};
const maintenanceNames = {
  sessions: "登录会话",
  uploads: "上传任务",
  upload_chunks: "上传临时块",
  assets: "私人图片",
  storage_cleanup: "待清理文件",
  llm_sessions: "AI 会话",
  llm_turns: "AI 对话",
  recognition_jobs: "花卉识别记录",
  assessment_jobs: "河道观察记录",
  asset_usage: "图片关联记录",
  llm_owners: "AI 账户状态",
  llm_ledger: "AI 用量账本",
  llm_quotas: "AI 额度记录",
  llm_days: "AI 每日用量",
  upload_budget: "上传预算",
  inference_daily: "识别每日用量",
  weather_requests: "天气请求记录",
  auth_gates: "登录频率记录",
  weather_ai_drafts: "预约解析草稿",
};
const submissionNames = {
  checking: "原始反馈检查中",
  reviewing: "编辑稿检查中",
  pending: "待编辑核实",
  approved: "已采用，原稿私密",
  rejected: "未通过",
};
const auditNames = {
  catalog_created: "新增资料",
  catalog_updated: "更新资料",
  catalog_withdrawn: "下架资料",
  feedback_resolved: "处理反馈",
  retention_updated: "修改保留策略",
  simulation_withdrawn: "维护模拟批次",
  community_approved: "审核通过",
  community_rejected: "审核驳回或下架",
  community_editorial_check_failed: "编辑稿检查未通过",
  community_safety_verified: "内容检查联通核验",
};
const EDITABLE_FIELDS = {
  contents: [
    "title",
    "slug",
    "body",
    "summary",
    "category",
    "place",
    "plant_label",
    "source",
    "is_demo",
  ],
  routes: [
    "title",
    "slug",
    "region",
    "description",
    "source",
    "is_demo",
    "stops",
  ],
  places: [
    "slug",
    "name",
    "kind",
    "description",
    "region",
    "map_layout",
    "x_ratio",
    "y_ratio",
    "latitude",
    "longitude",
    "coordinate_system",
    "source_note",
    "coordinates_verified",
    "source_url",
    "checked_at",
    "access_note",
    "river_id",
  ],
  rivers: [
    "slug",
    "name",
    "description",
    "region",
    "path",
    "coordinate_system",
    "geometry_verified",
    "source_url",
    "source_note",
    "checked_at",
    "access_note",
  ],
};
export function catalogPayload(kind, value) {
  if (
    !EDITABLE_FIELDS[kind] ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error("资料格式无效，请重新打开编辑器。");
  const result = Object.fromEntries(
    EDITABLE_FIELDS[kind]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
  if (kind === "routes")
    result.stops = (result.stops || []).map((stop, index) => ({
      ...(stop.id ? { id: stop.id } : {}),
      order: Number.isInteger(stop.order) ? stop.order : index,
      note: stop.note || "",
      place_id: stop.place_id || stop.place?.id,
    }));
  return result;
}
export function newCatalogValue(kind, regions = []) {
  const region =
    (kind === "rivers" ? regions.find((r) => r.is_demo === false) : regions[0])
      ?.id || "";
  const base = { slug: "" };
  if (kind === "contents")
    return {
      ...base,
      title: "",
      category: "green",
      summary: "",
      body: "",
      source: "",
      plant_label: "",
      place: null,
      is_demo: false,
    };
  if (kind === "routes")
    return {
      ...base,
      title: "",
      region,
      description: "",
      source: "",
      is_demo: regions.find((r) => r.id === region)?.is_demo !== false,
      stops: [],
    };
  if (kind === "places")
    return {
      ...base,
      name: "",
      kind: "park",
      region,
      description: "",
      source_note: "",
      source_url: "",
      checked_at: "",
      access_note: "",
      latitude: null,
      longitude: null,
      coordinate_system: "",
      coordinates_verified: false,
      map_layout: null,
      x_ratio: null,
      y_ratio: null,
      river_id: null,
    };
  return {
    ...base,
    name: "",
    region,
    description: "",
    source_note: "",
    source_url: "",
    checked_at: "",
    access_note: "",
    coordinate_system: "GCJ02",
    geometry_verified: false,
    path: [],
  };
}
const time = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "—";
const tabs = [
  ["stats", "概览", BarChart3],
  ["catalog", "资料管理", BookOpen],
  ["feedback", "私密反馈", MessageSquare],
  ["submissions", "资料反馈编辑", FilePenLine],
  ["audit", "操作记录", ClipboardList],
  ["maintenance", "数据维护", Archive],
];
const isConflict = (e) =>
  ["ADMIN_REVISION_CHANGED", "PREVIEW_CHANGED", "SUBMISSION_CHANGED"].includes(
    e?.code,
  );
const n = (value) => (value === "" ? null : Number(value));
function Field({ label: title, children }) {
  return (
    <label>
      {title}
      {children}
    </label>
  );
}
function CheckField({ label: title, checked, onChange, disabled }) {
  return (
    <label className="check-line">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      {title}
    </label>
  );
}

export default function AdminPage() {
  const { user } = useAuth();
  return <AdminWorkspace key={user?.id || "visitor"} />;
}
function AdminWorkspace() {
  const { user } = useAuth(),
    toast = useToast();
  const [tab, setTab] = useState("stats"),
    [kind, setKind] = useState("contents"),
    [status, setStatus] = useState(null),
    [statusLoading, setStatusLoading] = useState(true),
    [data, setData] = useState(null),
    [meta, setMeta] = useState(null),
    [extra, setExtra] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [editor, setEditor] = useState(null),
    [saving, setSaving] = useState(false),
    [preview, setPreview] = useState(null),
    [policySaved, setPolicySaved] = useState(null),
    [maintenanceKind, setMaintenanceKind] = useState(""),
    [maintenanceLimit, setMaintenanceLimit] = useState(10),
    [regions, setRegions] = useState([]),
    [places, setPlaces] = useState([]),
    [referenceError, setReferenceError] = useState(""),
    [reply, setReply] = useState(""),
    [conflict, setConflict] = useState(false),
    [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const live = useRef(true),
    operationLock = useRef(false),
    requestId = useRef(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setStatusLoading(true);
    setError("");
    api("personal-admin/status/")
      .then((r) => {
        if (active) setStatus(r.data);
      })
      .catch((e) => {
        if (active) {
          setStatus(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (active) setStatusLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user?.id, revision]);
  useEffect(() => {
    if (!status?.enabled) return;
    let active = true;
    Promise.all([allPages("regions/"), allPages("places/")])
      .then(([r, p]) => {
        if (active) {
          setRegions(r);
          setPlaces(p);
          setReferenceError("");
        }
      })
      .catch((e) => {
        if (active) setReferenceError("区域和地点选项暂不可用：" + e.message);
      });
    return () => {
      active = false;
    };
  }, [status?.enabled, revision]);
  useEffect(() => {
    if (!status?.enabled) {
      setData(null);
      setExtra(null);
      setMeta(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    setMeta(null);
    setExtra(null);
    setPreview(null);
    const path =
      tab === "catalog"
        ? "personal-admin/catalog/" + kind + "/"
        : tab === "maintenance"
          ? "personal-admin/simulation/retention/"
          : tab === "submissions"
            ? "personal-admin/community/submissions/"
            : "personal-admin/" + tab + "/";
    const more =
      tab === "maintenance"
        ? api("management/maintenance/")
        : tab === "submissions"
          ? api("personal-admin/community/status/")
          : Promise.resolve(null);
    Promise.all([
      api(path, {
        data: ["catalog", "audit", "feedback", "submissions"].includes(tab)
          ? { page, page_size: 20 }
          : undefined,
      }),
      more,
    ])
      .then(([r, s]) => {
        if (!active) return;
        setData(r.data);
        setMeta(r.meta);
        setExtra(s?.data || null);
        if (tab === "maintenance") setPolicySaved({ ...r.data });
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          if ([401, 403].includes(e.status))
            setStatus({ enabled: false, reason: e.message });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [status?.enabled, tab, kind, page, revision]);
  async function operation(work) {
    if (operationLock.current) return null;
    operationLock.current = true;
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      const r = await work();
      return live.current ? r : null;
    } catch (e) {
      if (live.current) {
        setError(
          isConflict(e)
            ? "管理内容已更新，当前修改尚未保存。请重新读取当前记录并核对后再操作。"
            : e.message,
        );
        setConflict(isConflict(e));
        if (e.code === "PREVIEW_CHANGED") setPreview(null);
        if ([401, 403].includes(e.status)) {
          setStatus({ enabled: false, reason: e.message });
          setEditor(null);
          setData(null);
        }
      }
      return null;
    } finally {
      operationLock.current = false;
      if (live.current) setSaving(false);
    }
  }
  async function revisionNow() {
    const r = await api("personal-admin/status/");
    if (!r.data.enabled)
      throw new Error(r.data.reason || "当前账号无管理权限。");
    return r.data.revision;
  }
  async function edit(row) {
    const selectedKind = kind;
    const result = await operation(async () =>
      row
        ? api("personal-admin/catalog/" + selectedKind + "/" + row.id + "/")
        : {
            data: {
              value: newCatalogValue(selectedKind, regions),
              published: false,
              revision: await revisionNow(),
            },
          },
    );
    if (!result) return;
    const record = result.data;
    setEditor({
      kind: selectedKind,
      id: row?.id || "",
      value: record.value,
      publish: record.published,
      revision: record.revision,
      deleted: record.deleted,
      protectedContent: record.value._community_submission === true,
      pathText: JSON.stringify(record.value.path || [], null, 2),
    });
    setConfirmWithdraw(false);
  }
  function field(key, value) {
    setEditor((old) => {
      const patch = { [key]: value };
      if (
        old.kind === "places" &&
        ["latitude", "longitude", "coordinate_system", "source_url"].includes(
          key,
        )
      )
        patch.coordinates_verified = false;
      if (
        old.kind === "rivers" &&
        ["path", "coordinate_system", "source_url"].includes(key)
      )
        patch.geometry_verified = false;
      return { ...old, value: { ...old.value, ...patch } };
    });
  }
  async function saveEditor(event) {
    event.preventDefault();
    if (editor.protectedContent) return;
    const result = await operation(async () => {
      const value = { ...editor.value };
      if (editor.kind === "rivers") {
        try {
          value.path = JSON.parse(editor.pathText);
        } catch {
          throw new Error("河道点位格式无效，请填写包含经纬度的点位列表。");
        }
      }
      return api(
        "personal-admin/catalog/" +
          editor.kind +
          "/" +
          (editor.id ? editor.id + "/" : ""),
        {
          method: editor.id ? "PATCH" : "POST",
          data: {
            value: catalogPayload(editor.kind, value),
            publish: editor.publish,
            expected_revision: editor.revision,
          },
        },
      );
    });
    if (result) {
      setEditor(null);
      setRevision((v) => v + 1);
      toast("资料已保存。");
    }
  }
  async function withdraw() {
    if (!editor?.id || editor.protectedContent) return;
    const result = await operation(() =>
      api("personal-admin/catalog/" + editor.kind + "/" + editor.id + "/", {
        method: "DELETE",
        data: { expected_revision: editor.revision },
      }),
    );
    if (result) {
      setEditor(null);
      setConfirmWithdraw(false);
      setRevision((v) => v + 1);
      toast("资料已下架，原文保留在管理库中。");
    }
  }
  async function feedbackEditor(row) {
    const result = await operation(revisionNow);
    if (result === null) return;
    setReply(row.reply || "");
    setEditor({ ...row, type: "feedback", revision: result });
  }
  async function resolve(event) {
    event.preventDefault();
    if (!reply.trim()) {
      setError("请填写处理回复。");
      return;
    }
    const result = await operation(() =>
      api("personal-admin/feedback/" + editor.id + "/resolve/", {
        method: "POST",
        data: { reply: reply.trim(), expected_revision: editor.revision },
      }),
    );
    if (result) {
      setEditor(null);
      setRevision((v) => v + 1);
      toast("反馈已处理。");
    }
  }
  const policyDirty =
    tab === "maintenance" &&
    data &&
    policySaved &&
    (Number(data.retain_days) !== policySaved.retain_days ||
      Number(data.keep_successful) !== policySaved.keep_successful);
  async function savePolicy(event) {
    event.preventDefault();
    const result = await operation(() =>
      api("personal-admin/simulation/retention/", {
        method: "PUT",
        data: {
          retain_days: Number(data.retain_days),
          keep_successful: Number(data.keep_successful),
          expected_revision: data.revision,
        },
      }),
    );
    if (result) {
      setPreview(null);
      setRevision((v) => v + 1);
      toast("保留策略已保存。");
    }
  }
  async function previewCleanup() {
    if (policyDirty) {
      setError("请先保存保留策略，再预览维护范围。");
      return;
    }
    const result = await operation(() =>
      api("personal-admin/simulation/cleanup-preview/"),
    );
    if (result) setPreview(result.data);
  }
  async function cleanup() {
    if (!preview || policyDirty) return;
    const result = await operation(() =>
      api("personal-admin/simulation/cleanup/", {
        method: "POST",
        data: {
          fingerprint: preview.fingerprint,
          expected_revision: preview.revision,
        },
      }),
    );
    if (result) {
      setPreview(null);
      setRevision((v) => v + 1);
      toast(
        "已撤下 " +
          result.data.withdrawn_runs +
          " 个模拟批次，隐藏 " +
          result.data.hidden_observations +
          " 条关联观测。",
      );
    }
  }
  async function maintain() {
    const limit = Number(maintenanceLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      setError("每批检查数量须为 1 至 20 条。");
      return;
    }
    const result = await operation(() =>
      api("management/maintenance/", {
        method: "POST",
        data: { limit, ...(maintenanceKind ? { kind: maintenanceKind } : {}) },
      }),
    );
    if (result) {
      setRevision((v) => v + 1);
      toast(
        "本批检查 " +
          result.data.scanned +
          " 条，清理 " +
          result.data.removed +
          " 条，失败 " +
          result.data.failed +
          " 条。",
      );
    }
  }
  function openSubmission(row, decision) {
    setError("");
    setConflict(false);
    requestId.current = null;
    setEditor({
      ...row,
      type: "submission",
      decision,
      edited_title: row.editorial?.title || "",
      edited_body: row.editorial?.body || "",
      edited_source: row.editorial?.source || "",
      reason: "",
    });
  }
  async function reviewSubmission(event) {
    event.preventDefault();
    const payload = {
      decision: editor.decision,
      expected_version: editor.version,
    };
    if (editor.decision === "approved") {
      if (!extra?.submissions_enabled) {
        setError("资料反馈发布尚未开放，不能绕过内容安全检查。");
        return;
      }
      Object.assign(payload, {
        edited_title: editor.edited_title.trim(),
        edited_body: editor.edited_body.trim(),
        edited_source: editor.edited_source.trim(),
      });
      const fingerprint = JSON.stringify(payload);
      if (requestId.current?.fingerprint !== fingerprint)
        requestId.current = { fingerprint, id: crypto.randomUUID() };
      payload.request_id = requestId.current.id;
    } else payload.reason = editor.reason.trim();
    const result = await operation(() =>
      api("personal-admin/community/submissions/" + editor.id + "/review/", {
        method: "POST",
        data: payload,
      }),
    );
    if (result) {
      setEditor(null);
      setRevision((v) => v + 1);
      toast(
        result.data.status === "approved"
          ? "编辑稿已通过检查并发布。"
          : result.data.review_reason || "资料反馈状态已更新。",
      );
    }
  }
  function closeEditor() {
    if (saving) return;
    setEditor(null);
    setError("");
    setConflict(false);
    setConfirmWithdraw(false);
  }
  const editorFormId = "admin-edit-form";
  return (
    <main className="admin-page">
      <PageHeader title="管理工作台" eyebrow="HYHQ / MANAGEMENT">
        <div className="button-row">
          <button
            className="btn secondary"
            disabled={saving || loading}
            onClick={() => setRevision((v) => v + 1)}
          >
            <RefreshCw size={16} />
            刷新
          </button>
          <Link className="btn secondary" to="/admin/blog"><ShieldCheck size={16} />博客审核</Link>
          <Link className="btn secondary" to="/me">
            返回我的主页
          </Link>
        </div>
      </PageHeader>
      {statusLoading && !status ? (
        <State loading />
      ) : !status?.enabled ? (
        <div className="state card">
          <ShieldCheck />
          <p>{error || status?.reason || "当前账号无管理权限。"}</p>
          {!user && (
            <Link to="/login?next=/admin" className="btn">
              登录管理账号
            </Link>
          )}
          <button
            className="btn secondary"
            disabled={saving}
            onClick={() => setRevision((v) => v + 1)}
          >
            重新核对权限
          </button>
        </div>
      ) : (
        <>
          <nav className="admin-tabs" aria-label="管理分类">
            {tabs.map(([id, name, Icon]) => (
              <button
                key={id}
                disabled={saving}
                className={tab === id ? "active" : ""}
                aria-pressed={tab === id}
                onClick={() => {
                  setTab(id);
                  setPage(1);
                  setData(null);
                  setError("");
                  setPreview(null);
                }}
              >
                <Icon size={18} />
                {name}
              </button>
            ))}
          </nav>
          {tab === "catalog" && (
            <div className="admin-toolbar">
              <select
                aria-label="管理资料类型"
                value={kind}
                disabled={saving}
                onChange={(e) => {
                  setKind(e.target.value);
                  setPage(1);
                  setData(null);
                }}
              >
                {(status.editable_kinds || Object.keys(EDITABLE_FIELDS))
                  .filter((k) => EDITABLE_FIELDS[k])
                  .map((k) => (
                    <option value={k} key={k}>
                      {label[k]}
                    </option>
                  ))}
              </select>
              <button
                className="btn"
                disabled={saving || loading}
                onClick={() => edit(null)}
              >
                <Plus size={17} />
                新增资料
              </button>
            </div>
          )}
          <State
            loading={loading}
            error={error && !editor ? error : ""}
            onRetry={() => setRevision((v) => v + 1)}
          >
            {data && tab === "stats" && (
              <>
                <div className="admin-stats">
                  <article className="card">
                    <span>活跃账号</span>
                    <strong>{data.users_active}</strong>
                  </article>
                  {Object.entries(data.public_catalog || {}).map(([k, v]) => (
                    <article key={k} className="card">
                      <span>{label[k] || k}</span>
                      <strong>{v}</strong>
                    </article>
                  ))}
                </div>
                <div className="admin-summary-grid">
                  <section className="card">
                    <h2>识别与反馈</h2>
                    {Object.entries(data.jobs || {}).map(([k, v]) => (
                      <p key={k}>
                        {label[k]}
                        <strong>{v.visible_total}</strong>
                      </p>
                    ))}
                    <p>
                      待处理反馈<strong>{data.feedback?.pending ?? "—"}</strong>
                    </p>
                    <p>
                      已处理反馈
                      <strong>{data.feedback?.resolved ?? "—"}</strong>
                    </p>
                  </section>
                  <section className="card">
                    <h2>AI 今日用量</h2>
                    <p>
                      调用尝试<strong>{data.llm_today?.attempts ?? "—"}</strong>
                    </p>
                    <p>
                      已记账 Token
                      <strong>{data.llm_today?.accounted_tokens ?? "—"}</strong>
                    </p>
                    <p>
                      尚在预留
                      <strong>{data.llm_today?.reserved_tokens ?? "—"}</strong>
                    </p>
                    <small className="muted">
                      内部使用记录，实际费用以提供方账单为准。
                    </small>
                  </section>
                  <section className="card">
                    <h2>天气请求预算</h2>
                    <p>
                      本月
                      <strong>
                        {data.weather_budget?.calendar_month_requests ?? "—"} /{" "}
                        {data.weather_budget?.environment_limit ?? "—"}
                      </strong>
                    </p>
                    <p>
                      滚动 31 天
                      <strong>
                        {data.weather_budget?.rolling_31_days_requests ?? "—"}
                      </strong>
                    </p>
                    <small className="muted">
                      网页环境独立预留 100 次，保留既有部署的预算分配。
                    </small>
                  </section>
                </div>
                <details className="card stats-note">
                  <summary>统计口径</summary>
                  <p>{data.counting_note}</p>
                  <small>统计时间：{time(data.as_of)}</small>
                </details>
              </>
            )}
            {Array.isArray(data) && tab === "catalog" && (
              <div className="admin-table card">
                <table>
                  <thead>
                    <tr>
                      <th>资料</th>
                      <th>状态</th>
                      <th>分类</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <strong>{row.title}</strong>
                          <small>{row.slug}</small>
                        </td>
                        <td>
                          <span className="tag">
                            {row.deleted
                              ? "已下架"
                              : row.published
                                ? "已发布"
                                : "草稿"}
                          </span>
                        </td>
                        <td>{categoryNames[row.category] || "—"}</td>
                        <td>
                          <button
                            className="btn secondary small"
                            disabled={saving}
                            onClick={() => edit(row)}
                          >
                            <Edit3 size={14} />
                            编辑
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.length && (
                  <div className="state">暂无资料，可新建私人管理草稿。</div>
                )}
              </div>
            )}
            {Array.isArray(data) && tab === "feedback" && (
              <div className="admin-feedback">
                {data.length ? (
                  data.map((row) => (
                    <article className="card" key={row.id}>
                      <div className="section-title">
                        <span className="tag">
                          {row.status === "resolved" ? "已回复" : "待处理"}
                        </span>
                        <small>{time(row.created_at)}</small>
                      </div>
                      <p style={{ whiteSpace: "pre-wrap" }}>{row.body}</p>
                      {row.reply && (
                        <blockquote>
                          {row.reply}
                          <small> · {time(row.resolved_at)}</small>
                        </blockquote>
                      )}
                      <button
                        className="btn secondary"
                        disabled={saving}
                        onClick={() => feedbackEditor(row)}
                      >
                        {row.status === "resolved" ? "更新回复" : "整理回复"}
                      </button>
                    </article>
                  ))
                ) : (
                  <div className="state card">暂无私密反馈</div>
                )}
              </div>
            )}
            {Array.isArray(data) && tab === "submissions" && (
              <div className="admin-feedback">
                <div className="card">
                  <h2>原稿私密，编辑稿独立检查</h2>
                  <p>
                    私人草稿不会进入此列表。只有作者主动提交的资料反馈可由获授权编辑核实；原始正文不能直接公开。
                  </p>
                  {!extra?.submissions_enabled && (
                    <p className="inline-warning">
                      资料反馈发布尚未开放。内容安全能力或资格未完成核验，当前不能发布编辑稿。
                    </p>
                  )}
                  <small>
                    内容安全核验：
                    {extra?.safety_verified_at
                      ? time(extra.safety_verified_at)
                      : "尚未验证"}{" "}
                    · 文章评论保持关闭。
                  </small>
                </div>
                {data.map((row) => (
                  <article className="card" key={row.id}>
                    <div className="section-title">
                      <h2>{row.title || "资料反馈"}</h2>
                      <span className="tag">
                        {submissionNames[row.status] || row.status}
                      </span>
                    </div>
                    <p style={{ whiteSpace: "pre-wrap" }}>{row.body}</p>
                    {row.source && <p>原始来源：{row.source}</p>}
                    <small>
                      原始内容检查：{row.safety_status} · 编辑稿检查：
                      {row.editorial_safety_status || "unchecked"}
                    </small>
                    {row.review_reason && (
                      <blockquote>{row.review_reason}</blockquote>
                    )}
                    <div className="button-row">
                      {row.status === "pending" &&
                        row.safety_status === "pass" && (
                          <button
                            className="btn"
                            disabled={saving || !extra?.submissions_enabled}
                            onClick={() => openSubmission(row, "approved")}
                          >
                            独立编辑官方文章
                          </button>
                        )}
                      {["pending", "reviewing", "approved"].includes(
                        row.status,
                      ) && (
                        <button
                          className="btn secondary"
                          disabled={saving}
                          onClick={() => openSubmission(row, "rejected")}
                        >
                          {row.status === "approved"
                            ? "撤下并说明"
                            : "驳回并说明"}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
                {!data.length && (
                  <div className="state card">
                    暂无已提交的资料反馈；用户私人草稿不会列出。
                  </div>
                )}
              </div>
            )}
            {Array.isArray(data) && tab === "audit" && (
              <div className="admin-table card">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>操作</th>
                      <th>对象</th>
                      <th>变更字段</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row) => (
                      <tr key={row.id}>
                        <td>{time(row.created_at)}</td>
                        <td>{auditNames[row.action] || row.action}</td>
                        <td>
                          {label[row.kind] || row.kind}
                          <small>{row.target_id}</small>
                        </td>
                        <td>{row.changed_fields?.join("、") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.length && <div className="state">暂无关键操作记录</div>}
              </div>
            )}
            {data && tab === "maintenance" && (
              <>
                <section className="card retention">
                  <h2>到期私人数据维护</h2>
                  <p className="muted">
                    仅按固定隐私保留规则清理到期资料。头像保留至替换或账号注销。
                  </p>
                  <div className="admin-stats">
                    {[
                      [
                        "原图保留",
                        (extra?.policy?.original_hours ?? 24) + " 小时",
                      ],
                      [
                        "识别缩略图",
                        (extra?.policy?.recognition_thumbnail_days ?? 30) +
                          " 天",
                      ],
                      [
                        "用量账本",
                        (extra?.policy?.accounting_days ?? 90) + " 天",
                      ],
                    ].map(([title, value]) => (
                      <article key={title}>
                        <span>{title}</span>
                        <strong style={{ fontSize: 23 }}>{value}</strong>
                      </article>
                    ))}
                  </div>
                  <p className="muted">
                    {extra?.policy?.automatic_schedule_enabled
                      ? "已收到自动维护成功记录。上次运行：" +
                        time(extra?.timer_verified_at)
                      : "尚无已验证的自动维护执行记录，可手动检查。"}
                  </p>
                  <div className="form-grid">
                    <Field label="维护类型">
                      <select
                        value={maintenanceKind}
                        disabled={saving}
                        onChange={(e) => setMaintenanceKind(e.target.value)}
                      >
                        <option value="">自动轮换下一类</option>
                        {extra?.kinds?.map((k) => (
                          <option value={k} key={k}>
                            {maintenanceNames[k] || k}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="本批检查条数">
                      <input
                        type="number"
                        min="1"
                        max="20"
                        step="1"
                        value={maintenanceLimit}
                        disabled={saving}
                        onChange={(e) => setMaintenanceLimit(e.target.value)}
                      />
                    </Field>
                  </div>
                  <button
                    className="btn secondary"
                    disabled={saving || extra?.running}
                    onClick={maintain}
                  >
                    {extra?.running ? "已有维护任务执行中" : "执行一批到期维护"}
                  </button>
                </section>
                <section className="card retention">
                  <h2>模拟数据保留策略</h2>
                  <p className="muted">
                    真实来源不参与维护。除保留天数外，仍保留每来源、场景及每站最新批次。
                  </p>
                  <form onSubmit={savePolicy}>
                    <Field label="保留天数">
                      <input
                        type="number"
                        min="30"
                        max="3650"
                        step="1"
                        required
                        disabled={saving}
                        value={data.retain_days}
                        onChange={(e) => {
                          setData({ ...data, retain_days: e.target.value });
                          setPreview(null);
                        }}
                      />
                    </Field>
                    <Field label="每个来源与场景至少保留的批次">
                      <input
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        required
                        disabled={saving}
                        value={data.keep_successful}
                        onChange={(e) => {
                          setData({ ...data, keep_successful: e.target.value });
                          setPreview(null);
                        }}
                      />
                    </Field>
                    <div className="button-row">
                      <button className="btn" disabled={saving}>
                        保存策略
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={previewCleanup}
                        disabled={saving || policyDirty}
                      >
                        预览维护范围
                      </button>
                    </div>
                    {policyDirty && (
                      <p className="muted">当前修改尚未保存，请先保存策略。</p>
                    )}
                  </form>
                  {preview && (
                    <div className="cleanup-preview">
                      <h3>本次将撤下 {preview.selected_run_count} 个批次</h3>
                      <p>
                        涉及 {preview.selected_observation_count}{" "}
                        条模拟观测。截止时间：{time(preview.cutoff)}
                      </p>
                      <p>{preview.notice}</p>
                      {preview.candidates?.map((row) => (
                        <p key={row.id}>
                          {row.source} · {row.scenario} ·{" "}
                          {row.observation_count} 条观测 · {time(row.end)}
                        </p>
                      ))}
                      {!preview.selected_run_count && (
                        <p>当前没有符合条件的模拟批次。</p>
                      )}
                      {preview.has_more && (
                        <p>另有符合条件的批次，本次完成后可重新预览。</p>
                      )}
                      <button
                        className="btn"
                        disabled={
                          saving || policyDirty || !preview.selected_run_count
                        }
                        onClick={cleanup}
                      >
                        确认维护以上模拟批次
                      </button>
                    </div>
                  )}
                </section>
                {!!extra?.recent?.length && (
                  <section className="card">
                    <h2>近期到期维护记录</h2>
                    {extra.recent.map((row, index) => (
                      <p key={row.finished_at + index}>
                        {maintenanceNames[row.kind] || row.kind} ·{" "}
                        {row.aborted ? "未完整执行" : "本批完成"} · 检查{" "}
                        {row.scanned} / 清理 {row.removed} / 失败 {row.failed}
                        <small> · {time(row.finished_at)}</small>
                      </p>
                    ))}
                  </section>
                )}
              </>
            )}
            {["catalog", "audit", "feedback", "submissions"].includes(tab) &&
              meta && (
                <div className="pagination">
                  <button
                    className="btn secondary"
                    disabled={page === 1 || saving}
                    onClick={() => setPage((v) => v - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    第 {page} 页 · 共 {meta.count ?? 0} 条
                  </span>
                  <button
                    className="btn secondary"
                    disabled={!meta.next || saving}
                    onClick={() => setPage((v) => v + 1)}
                  >
                    下一页
                  </button>
                </div>
              )}
          </State>
        </>
      )}
      {editor && (
        <Modal
          title={
            editor.type === "feedback"
              ? "反馈回复"
              : editor.type === "submission"
                ? editor.decision === "approved"
                  ? "独立编辑官方文章"
                  : "审核说明"
                : editor.id
                  ? "编辑资料"
                  : "新增资料"
          }
          onClose={closeEditor}
          className="admin-editor"
        >
          <div className="modal-body">
            {editor.type === "feedback" ? (
              <form id={editorFormId} onSubmit={resolve}>
                <p style={{ whiteSpace: "pre-wrap" }}>{editor.body}</p>
                <Field label="处理回复">
                  <textarea
                    rows={6}
                    maxLength={1000}
                    required
                    value={reply}
                    disabled={saving}
                    onChange={(e) => setReply(e.target.value)}
                  />
                </Field>
              </form>
            ) : editor.type === "submission" ? (
              <form id={editorFormId} onSubmit={reviewSubmission}>
                <p className="muted">
                  原始反馈保持私密。发布前须核实公开来源、独立改写、去除个人信息，并再次通过内容安全检查。
                </p>
                {editor.decision === "approved" ? (
                  <>
                    <Field label="编辑后的标题">
                      <input
                        maxLength={80}
                        required
                        disabled={saving}
                        value={editor.edited_title}
                        onChange={(e) =>
                          setEditor({ ...editor, edited_title: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="独立编辑后的正文">
                      <textarea
                        rows={10}
                        maxLength={2000}
                        required
                        disabled={saving}
                        value={editor.edited_body}
                        onChange={(e) =>
                          setEditor({ ...editor, edited_body: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="已核实的公开来源">
                      <textarea
                        rows={2}
                        maxLength={300}
                        required
                        disabled={saving}
                        value={editor.edited_source}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            edited_source: e.target.value,
                          })
                        }
                      />
                    </Field>
                  </>
                ) : (
                  <Field label="驳回或撤下原因">
                    <textarea
                      rows={5}
                      maxLength={300}
                      required
                      disabled={saving}
                      value={editor.reason}
                      onChange={(e) =>
                        setEditor({ ...editor, reason: e.target.value })
                      }
                    />
                  </Field>
                )}
              </form>
            ) : (
              <form id={editorFormId} onSubmit={saveEditor}>
                {editor.protectedContent ? (
                  <div className="inline-warning">
                    这篇文章来源于资料反馈，须通过“资料反馈编辑”处理，不能在普通资料管理中绕过内容检查。
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => {
                        closeEditor();
                        setTab("submissions");
                        setPage(1);
                      }}
                    >
                      前往资料反馈编辑
                    </button>
                  </div>
                ) : (
                  <>
                    {referenceError && (
                      <p className="inline-warning">{referenceError}</p>
                    )}
                    <div className="form-grid">
                      <Field
                        label={
                          ["places", "rivers"].includes(editor.kind)
                            ? "名称"
                            : "标题"
                        }
                      >
                        <input
                          required
                          maxLength={
                            ["places", "rivers"].includes(editor.kind)
                              ? 120
                              : 180
                          }
                          disabled={saving}
                          value={
                            editor.value[
                              ["places", "rivers"].includes(editor.kind)
                                ? "name"
                                : "title"
                            ] || ""
                          }
                          onChange={(e) =>
                            field(
                              ["places", "rivers"].includes(editor.kind)
                                ? "name"
                                : "title",
                              e.target.value,
                            )
                          }
                        />
                      </Field>
                      <Field label="唯一资料标识（字母、数字、短横线）">
                        <input
                          required
                          pattern="[-a-zA-Z0-9_]+"
                          maxLength={100}
                          disabled={saving}
                          placeholder="例如 river-notes-2026"
                          value={editor.value.slug || ""}
                          onChange={(e) => field("slug", e.target.value)}
                        />
                      </Field>
                    </div>
                    {editor.kind !== "contents" && (
                      <Field label="所属区域">
                        <select
                          required
                          disabled={
                            saving ||
                            (!!editor.id &&
                              ["places", "rivers"].includes(editor.kind))
                          }
                          value={editor.value.region || ""}
                          onChange={(e) => {
                            field("region", e.target.value);
                            if (editor.kind === "routes") field("stops", []);
                          }}
                        >
                          <option value="">选择区域</option>
                          {regions
                            .filter(
                              (r) =>
                                editor.kind !== "rivers" || r.is_demo === false,
                            )
                            .map((r) => (
                              <option value={r.id} key={r.id}>
                                {r.name}
                                {r.is_demo ? " · 模拟示范" : ""}
                              </option>
                            ))}
                        </select>
                      </Field>
                    )}
                    {editor.kind === "contents" && (
                      <>
                        <div className="form-grid">
                          <Field label="分类">
                            <select
                              value={editor.value.category || "green"}
                              disabled={saving}
                              onChange={(e) =>
                                field("category", e.target.value)
                              }
                            >
                              {Object.entries(categoryNames).map(
                                ([v, name]) => (
                                  <option value={v} key={v}>
                                    {name}
                                  </option>
                                ),
                              )}
                            </select>
                          </Field>
                          <Field label="植物标签">
                            <select
                              value={editor.value.plant_label || ""}
                              disabled={saving}
                              onChange={(e) =>
                                field("plant_label", e.target.value)
                              }
                            >
                              <option value="">无植物标签</option>
                              {[
                                ["daisy", "雏菊类"],
                                ["tulips", "郁金香类"],
                                ["dandelion", "蒲公英类"],
                                ["roses", "蔷薇属"],
                                ["sunflowers", "向日葵类"],
                              ].map(([v, name]) => (
                                <option key={v} value={v}>
                                  {name}
                                </option>
                              ))}
                              {editor.value.plant_label &&
                                ![
                                  "daisy",
                                  "tulips",
                                  "dandelion",
                                  "roses",
                                  "sunflowers",
                                ].includes(editor.value.plant_label) && (
                                  <option value={editor.value.plant_label}>
                                    {editor.value.plant_label}
                                  </option>
                                )}
                            </select>
                          </Field>
                        </div>
                        <Field label="关联地点（可选）">
                          <select
                            value={editor.value.place || ""}
                            disabled={saving}
                            onChange={(e) =>
                              field("place", e.target.value || null)
                            }
                          >
                            <option value="">不关联地点</option>
                            {places.map((p) => (
                              <option value={p.id} key={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </>
                    )}
                    {editor.kind === "places" && (
                      <Field label="地点类型">
                        <select
                          value={editor.value.kind || "park"}
                          disabled={saving}
                          onChange={(e) => field("kind", e.target.value)}
                        >
                          {Object.entries(kindNames).map(([v, name]) => (
                            <option value={v} key={v}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <Field label={editor.kind === "contents" ? "摘要" : "简介"}>
                      <textarea
                        rows={3}
                        maxLength={editor.kind === "contents" ? 3000 : 20000}
                        disabled={saving}
                        value={
                          editor.value[
                            editor.kind === "contents"
                              ? "summary"
                              : "description"
                          ] || ""
                        }
                        onChange={(e) =>
                          field(
                            editor.kind === "contents"
                              ? "summary"
                              : "description",
                            e.target.value,
                          )
                        }
                      />
                    </Field>
                    {editor.kind === "contents" && (
                      <Field label="正文 · 支持 Markdown">
                        <textarea
                          rows={12}
                          maxLength={20000}
                          required
                          disabled={saving}
                          value={editor.value.body || ""}
                          onChange={(e) => field("body", e.target.value)}
                        />
                      </Field>
                    )}
                    <Field label="可核对的来源">
                      <textarea
                        rows={2}
                        maxLength={500}
                        required={
                          editor.publish &&
                          ["contents", "routes"].includes(editor.kind)
                        }
                        disabled={saving}
                        value={
                          editor.value[
                            ["places", "rivers"].includes(editor.kind)
                              ? "source_note"
                              : "source"
                          ] || ""
                        }
                        onChange={(e) =>
                          field(
                            ["places", "rivers"].includes(editor.kind)
                              ? "source_note"
                              : "source",
                            e.target.value,
                          )
                        }
                      />
                    </Field>
                    {editor.kind === "routes" && (
                      <section>
                        <div className="section-title">
                          <h3>路线节点</h3>
                          <button
                            type="button"
                            className="btn secondary small"
                            disabled={
                              saving || editor.value.stops?.length >= 50
                            }
                            onClick={() =>
                              field("stops", [
                                ...(editor.value.stops || []),
                                {
                                  order: (editor.value.stops || []).length,
                                  note: "",
                                  place_id: "",
                                },
                              ])
                            }
                          >
                            <Plus size={14} />
                            添加节点
                          </button>
                        </div>
                        {(editor.value.stops || []).map((stop, index) => (
                          <div className="card" key={stop.id || index}>
                            <div className="form-grid">
                              <Field label={"第 " + (index + 1) + " 个地点"}>
                                <select
                                  required
                                  disabled={saving}
                                  value={stop.place_id || stop.place?.id || ""}
                                  onChange={(e) =>
                                    field(
                                      "stops",
                                      editor.value.stops.map((s, i) =>
                                        i === index
                                          ? {
                                              ...s,
                                              place_id: e.target.value,
                                              place: undefined,
                                            }
                                          : s,
                                      ),
                                    )
                                  }
                                >
                                  <option value="">选择本区域地点</option>
                                  {places
                                    .filter(
                                      (p) => p.region === editor.value.region,
                                    )
                                    .map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                </select>
                              </Field>
                              <Field label="顺序编号">
                                <input
                                  type="number"
                                  min="0"
                                  max="1000"
                                  step="1"
                                  required
                                  disabled={saving}
                                  value={stop.order ?? index}
                                  onChange={(e) =>
                                    field(
                                      "stops",
                                      editor.value.stops.map((s, i) =>
                                        i === index
                                          ? {
                                              ...s,
                                              order: Number(e.target.value),
                                            }
                                          : s,
                                      ),
                                    )
                                  }
                                />
                              </Field>
                            </div>
                            <Field label="节点说明">
                              <input
                                maxLength={300}
                                disabled={saving}
                                value={stop.note || ""}
                                onChange={(e) =>
                                  field(
                                    "stops",
                                    editor.value.stops.map((s, i) =>
                                      i === index
                                        ? { ...s, note: e.target.value }
                                        : s,
                                    ),
                                  )
                                }
                              />
                            </Field>
                            <button
                              type="button"
                              className="btn secondary small"
                              disabled={saving}
                              onClick={() =>
                                field(
                                  "stops",
                                  editor.value.stops.filter(
                                    (s, i) => i !== index,
                                  ),
                                )
                              }
                            >
                              移除此节点
                            </button>
                          </div>
                        ))}
                        {!editor.value.stops?.length && (
                          <p className="muted">暂未添加节点，可先保存草稿。</p>
                        )}
                      </section>
                    )}
                    {["places", "rivers"].includes(editor.kind) && (
                      <details>
                        <summary>位置、来源与核验信息</summary>
                        {editor.kind === "places" ? (
                          <div className="form-grid">
                            <Field label="纬度">
                              <input
                                type="number"
                                step="any"
                                min="-90"
                                max="90"
                                disabled={saving}
                                value={editor.value.latitude ?? ""}
                                onChange={(e) =>
                                  field("latitude", n(e.target.value))
                                }
                              />
                            </Field>
                            <Field label="经度">
                              <input
                                type="number"
                                step="any"
                                min="-180"
                                max="180"
                                disabled={saving}
                                value={editor.value.longitude ?? ""}
                                onChange={(e) =>
                                  field("longitude", n(e.target.value))
                                }
                              />
                            </Field>
                          </div>
                        ) : (
                          <Field label="已核对的河道点位列表">
                            <textarea
                              className="code-input"
                              rows={7}
                              disabled={saving}
                              value={editor.pathText}
                              placeholder={
                                '[{"latitude":39.1,"longitude":117.2}]'
                              }
                              onChange={(e) =>
                                setEditor({
                                  ...editor,
                                  pathText: e.target.value,
                                  value: {
                                    ...editor.value,
                                    geometry_verified: false,
                                  },
                                })
                              }
                            />
                            <small>
                              经纬度点按河道顺序排列，最多 200
                              点；发布至少需要两个核验点。
                            </small>
                          </Field>
                        )}
                        <Field label="坐标系">
                          <select
                            value={editor.value.coordinate_system || ""}
                            disabled={saving || editor.kind === "rivers"}
                            onChange={(e) =>
                              field("coordinate_system", e.target.value)
                            }
                          >
                            {editor.kind !== "rivers" && (
                              <option value="">未提供坐标</option>
                            )}
                            {(editor.kind === "rivers"
                              ? ["GCJ02"]
                              : ["GCJ02", "WGS84", "BD09"]
                            ).map((c) => (
                              <option value={c} key={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="坐标来源链接">
                          <input
                            maxLength={1000}
                            disabled={saving}
                            value={editor.value.source_url || ""}
                            onChange={(e) =>
                              field("source_url", e.target.value)
                            }
                          />
                        </Field>
                        <Field label="核对日期">
                          <input
                            type="date"
                            disabled={saving}
                            value={editor.value.checked_at || ""}
                            onChange={(e) =>
                              field("checked_at", e.target.value)
                            }
                          />
                        </Field>
                        <Field label="访问说明">
                          <textarea
                            rows={2}
                            maxLength={1000}
                            disabled={saving}
                            value={editor.value.access_note || ""}
                            onChange={(e) =>
                              field("access_note", e.target.value)
                            }
                          />
                        </Field>
                        <CheckField
                          disabled={saving}
                          label={
                            editor.kind === "rivers"
                              ? "我已核实河道折线、GCJ02 坐标、来源和日期"
                              : "我已核实实际点位、GCJ02 坐标、来源和日期"
                          }
                          checked={
                            editor.value[
                              editor.kind === "rivers"
                                ? "geometry_verified"
                                : "coordinates_verified"
                            ]
                          }
                          onChange={(v) =>
                            field(
                              editor.kind === "rivers"
                                ? "geometry_verified"
                                : "coordinates_verified",
                              v,
                            )
                          }
                        />
                        <small>
                          修改坐标或来源链接后，须重新核对；示范地点不能标为真实导航坐标。
                        </small>
                      </details>
                    )}
                    {["contents", "routes"].includes(editor.kind) && (
                      <CheckField
                        label="明确标为科普模拟资料"
                        checked={editor.value.is_demo}
                        disabled={saving}
                        onChange={(v) => field("is_demo", v)}
                      />
                    )}
                    <CheckField
                      label="公开发布整理后的资料"
                      checked={editor.publish}
                      disabled={saving}
                      onChange={(value) =>
                        setEditor({ ...editor, publish: value })
                      }
                    />
                  </>
                )}
              </form>
            )}
            {error && (
              <p className="inline-warning" role="alert">
                {error}
              </p>
            )}
            {conflict && (
              <p className="muted">
                请先保留你需要的修改，再关闭编辑器并刷新列表；重新打开记录会载入最新版本。
              </p>
            )}
            {confirmWithdraw && (
              <div className="inline-warning">
                <p>
                  确认撤下「{editor.value?.title || editor.value?.name}
                  」？公开页面与 AI 将不再引用，原文仍留在管理库中。
                </p>
                <div className="button-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={saving}
                    onClick={withdraw}
                  >
                    确认下架
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={saving}
                    onClick={() => setConfirmWithdraw(false)}
                  >
                    取消下架
                  </button>
                </div>
              </div>
            )}
            <div className="button-row">
              {!editor.protectedContent && (
                <button
                  className="btn"
                  form={editorFormId}
                  type="submit"
                  disabled={saving || conflict}
                >
                  <Save size={16} />
                  {saving
                    ? "正在处理…"
                    : editor.type === "submission" &&
                        editor.decision === "approved"
                      ? "检查编辑稿并发布"
                      : "保存"}
                </button>
              )}
              {editor.id &&
                !editor.type &&
                !editor.deleted &&
                !editor.protectedContent && (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={saving || conflict}
                    onClick={() => setConfirmWithdraw(true)}
                  >
                    <Trash2 size={15} />
                    下架资料
                  </button>
                )}
              <button
                type="button"
                className="btn secondary"
                disabled={saving}
                onClick={closeEditor}
              >
                关闭
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
