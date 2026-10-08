import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  FilePenLine,
  MessageCircle,
  Send,
  ShieldCheck,
  Trash2,
  Flag,
  Eye,
  Save,
} from "lucide-react";
import { api } from "../lib/api.js";
import { useAuth } from "../state.jsx";
import {
  AIButton,
  Markdown,
  Modal,
  PageHeader,
  State,
} from "../components.jsx";
import {
  CATEGORY_NAMES,
  PLANT_NAMES,
  formatTime,
  loadAll,
} from "./public-domain.js";
import "./BlogPages.css";

const API = "web/blog/";
const stateNames = {
  draft: "草稿",
  pending: "待审核",
  published: "已发布",
  rejected: "未通过",
  withdrawn: "已下架",
  approved: "已公开",
  hidden: "已隐藏",
  resolved: "已处理",
  dismissed: "不予采纳",
};
const reasonOptions = [
  "资料不准确",
  "侵犯权益或隐私",
  "广告或垃圾内容",
  "不当内容",
  "其他",
];
const registered = (user) => Boolean(user?.id && user.auth_kind !== "guest");
function useResource(path, identity = "") {
  const [revision, setRevision] = useState(0),
    [state, setState] = useState({
      key: "",
      loading: true,
      data: null,
      meta: null,
      error: "",
    });
  const key = path + "|" + identity + "|" + revision;
  useEffect(() => {
    const c = new AbortController();
    let active = true;
    if (!path) {
      setState({ key, loading: false, data: null, meta: null, error: "" });
      return;
    }
    setState({ key, loading: true, data: null, meta: null, error: "" });
    api(path, { signal: c.signal })
      .then((r) => {
        if (active)
          setState({
            key,
            loading: false,
            data: r.data,
            meta: r.meta,
            error: "",
          });
      })
      .catch((e) => {
        if (active && e.name !== "AbortError")
          setState({
            key,
            loading: false,
            data: null,
            meta: null,
            error: e.message,
          });
      });
    return () => {
      active = false;
      c.abort();
    };
  }, [key]);
  return {
    ...(state.key === key
      ? state
      : { loading: true, data: null, meta: null, error: "" }),
    reload: () => setRevision((n) => n + 1),
  };
}
function useAction() {
  const active = useRef(true),
    lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run(fn, done) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await fn();
      if (active.current) done?.(value);
    } catch (e) {
      if (active.current) setError(e.message || "操作未完成");
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  return { busy, error, notice, setNotice, run };
}
function Notices({ action }) {
  return (
    <>
      {action.error && (
        <p className="blog-error" role="alert">
          {action.error}
        </p>
      )}
      {action.notice && (
        <p className="blog-notice" role="status">
          {action.notice}
        </p>
      )}
    </>
  );
}
function Label({ status }) {
  return (
    <span className={"blog-status status-" + status}>
      {stateNames[status] || status}
    </span>
  );
}
function Access({ admin = false }) {
  return (
    <div className="blog-access card">
      <ShieldCheck size={28} />
      <h2>{admin ? "管理员登录后可审核" : "登录后写下你的自然发现"}</h2>
      <p>
        {admin
          ? "审核权限由服务端核验。"
          : "注册用户可保存草稿、投稿和评论。公开内容须经管理员审核。"}
      </p>
      <Link className="btn" to="/login">
        登录 / 注册
      </Link>
      <Link className="text-link" to="/learn">
        继续阅读
      </Link>
    </div>
  );
}
function Pagination({ meta, page, onPage }) {
  if (!meta || meta.total_pages < 2) return null;
  return (
    <nav className="blog-pagination" aria-label="分页">
      <button
        className="btn secondary"
        disabled={!meta.previous}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </button>
      <span>
        {page} / {meta.total_pages}
      </span>
      <button
        className="btn secondary"
        disabled={!meta.next}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}
export function BlogLinks() {
  const { user, loading } = useAuth();
  return (
    <div className="blog-links">
      <Link className="btn secondary" to="/blog/mine">
        我的投稿
      </Link>
      {loading ? (
        <button className="btn" disabled aria-label="正在确认登录状态">
          <FilePenLine size={17} />
          写文章
        </button>
      ) : (
        <Link
          className="btn"
          to={registered(user) ? "/blog/write" : "/login?next=%2Fblog%2Fwrite"}
        >
          <FilePenLine size={17} />
          写文章
        </Link>
      )}
      {user?.role === "admin" && (
        <Link className="btn secondary" to="/admin/blog">
          博客审核
        </Link>
      )}
    </div>
  );
}

export function BlogReportButton({ kind, id }) {
  const { user } = useAuth();
  return (
    <ReportButton
      key={(user?.id || "") + kind + id}
      kind={kind}
      id={id}
      user={user}
    />
  );
}
function ReportButton({ kind, id, user }) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(reasonOptions[0]),
    [details, setDetails] = useState(""),
    action = useAction();
  return (
    <>
      <button className="blog-text-button" onClick={() => setOpen(true)}>
        <Flag size={14} />
        举报
      </button>
      {open && (
        <Modal
          title="举报内容"
          className="blog-report-modal"
          onClose={() => {
            if (!action.busy) setOpen(false);
          }}
        >
          {registered(user) ? (
            <form
              className="blog-form"
              onSubmit={(e) => {
                e.preventDefault();
                action.run(
                  () =>
                    api(API + "reports/", {
                      method: "POST",
                      data: {
                        target_kind: kind,
                        target_id: id,
                        reason,
                        details,
                      },
                    }),
                  () => {
                    action.setNotice(
                      "举报已提交，处理结果可在“我的投稿 → 举报”查看。",
                    );
                    setDetails("");
                  },
                );
              }}
            >
              <label>
                原因
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  {reasonOptions.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <label>
                补充说明
                <textarea
                  maxLength={2000}
                  rows={4}
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="请指出具体问题，避免填写与举报无关的个人资料。"
                />
              </label>
              <Notices action={action} />
              <button className="btn" disabled={action.busy || !!action.notice}>
                {action.busy ? "正在提交…" : "提交举报"}
              </button>
            </form>
          ) : (
            <Access />
          )}
        </Modal>
      )}
    </>
  );
}
export function BlogComments({ kind, id }) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <section className="blog-comments">
        <State loading />
      </section>
    );
  return (
    <Comments
      key={(user?.id || "") + kind + id}
      user={user}
      kind={kind}
      id={id}
    />
  );
}
function Comments({ kind, id, user }) {
  const [page, setPage] = useState(1),
    [body, setBody] = useState(""),
    action = useAction();
  const list = useResource(
    API +
      "comments/?" +
      new URLSearchParams({
        target_kind: kind,
        target_id: id,
        page,
        page_size: 20,
      }),
    user?.id || "",
  );
  return (
    <section className="blog-comments">
      <div className="blog-section-heading">
        <h2>
          <MessageCircle size={21} />
          读者讨论
        </h2>
        <BlogReportButton kind={kind} id={id} />
      </div>
      {registered(user) ? (
        <form
          className="blog-comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(
              () =>
                api(API + "comments/", {
                  method: "POST",
                  data: { target_kind: kind, target_id: id, body },
                }),
              () => {
                setBody("");
                action.setNotice(
                  "评论已送审，通过后公开。你可以在“我的投稿 → 评论”查看状态。",
                );
              },
            );
          }}
        >
          <label htmlFor={"comment-" + id}>
            写下你的观察
            <textarea
              id={"comment-" + id}
              maxLength={2000}
              rows={3}
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="分享与文章有关的观察与问题"
            />
          </label>
          <div className="blog-form-footer">
            <span>评论审核后公开 · {body.length}/2000</span>
            <button className="btn" disabled={action.busy || !body.trim()}>
              <Send size={16} />
              {action.busy ? "提交中…" : "提交评论"}
            </button>
          </div>
        </form>
      ) : (
        <p className="blog-muted">
          <Link to="/login">登录或注册</Link> 后参与讨论，评论审核后公开。
        </p>
      )}
      <Notices action={action} />
      <State
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        empty={!list.data?.length && "还没有公开评论"}
      >
        <div className="blog-comment-list">
          {list.data?.map((row) => (
            <article key={row.id} className="blog-comment">
              <div className="blog-comment-meta">
                <strong>{row.author_name}</strong>
                <time>{formatTime(row.created_at)}</time>
              </div>
              <p className="blog-comment-text">{row.body}</p>
              <div className="blog-row-actions">
                {row.owned && (
                  <button
                    className="blog-text-button"
                    disabled={action.busy}
                    onClick={() => {
                      if (window.confirm("删除这条评论？"))
                        action.run(
                          () =>
                            api(API + "comments/" + row.id + "/", {
                              method: "DELETE",
                              data: { version: row.version },
                            }),
                          () => {
                            setPage(1);
                            list.reload();
                          },
                        );
                    }}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                )}
                <BlogReportButton kind="comment" id={row.id} />
              </div>
            </article>
          ))}
        </div>
        <Pagination meta={list.meta} page={page} onPage={setPage} />
      </State>
    </section>
  );
}
export function BlogPostPage() {
  const { id } = useParams();
  const post = useResource(API + "posts/" + encodeURIComponent(id) + "/");
  const row = post.data;
  return (
    <main className="blog-page">
      <Link className="blog-back" to="/learn">
        <ArrowLeft size={16} />
        科普智游
      </Link>
      <State
        loading={post.loading}
        error={post.error}
        onRetry={post.reload}
        empty={!row && "文章暂不可用"}
      >
        {row && (
          <>
            <header className="blog-article-heading">
              <span className="eyebrow">NATURE JOURNAL</span>
              <h1>{row.title}</h1>
              <div className="blog-meta">
                <span>{CATEGORY_NAMES[row.category]}</span>
                <span>{row.author_name}</span>
                <time>{formatTime(row.published_at)}</time>
              </div>
            </header>
            <article className="blog-reading card">
              <p className="blog-summary">{row.summary}</p>
              <Markdown text={row.body} />
              {row.source && (
                <footer className="blog-source">资料出处：{row.source}</footer>
              )}
            </article>
            <BlogComments key={id} kind="post" id={id} />
            <AIButton
              floating
              context={{
                scope: "learn",
                source_type: "blog_post",
                source_id: id,
              }}
            />
          </>
        )}
      </State>
    </main>
  );
}

const blank = {
  title: "",
  summary: "",
  body: "",
  category: "plants",
  region: "",
  place: "",
  plant_label: "",
  source: "",
};
export function BlogEditorPage() {
  const { user } = useAuth(),
    { id } = useParams();
  return registered(user) ? (
    <Editor key={(user?.id || "") + ":" + (id || "new")} user={user} id={id} />
  ) : (
    <main className="blog-page">
      <Access />
    </main>
  );
}
function Editor({ user, id }) {
  const navigate = useNavigate(),
    resource = useResource(
      id ? API + "drafts/" + encodeURIComponent(id) + "/" : null,
      user.id,
    ),
    action = useAction();
  const [form, setForm] = useState(blank),
    [version, setVersion] = useState(null),
    [status, setStatus] = useState("draft"),
    [preview, setPreview] = useState(false),
    [dirty, setDirty] = useState(false),
    [note, setNote] = useState("");
  const catalog = useResource("regions/?page_size=100"),
    [places, setPlaces] = useState([]),
    [placeError, setPlaceError] = useState("");
  useEffect(() => {
    if (resource.data) {
      const r = resource.data;
      setForm(
        Object.fromEntries(Object.keys(blank).map((k) => [k, r[k] || ""])),
      );
      setVersion(r.version);
      setStatus(r.status);
      setNote(r.review_note || "");
      setDirty(false);
    }
  }, [resource.data]);
  useEffect(() => {
    const c = new AbortController();
    let active = true;
    setPlaces([]);
    setPlaceError("");
    if (form.region)
      loadAll(api, "places/", { region: form.region }, c.signal)
        .then((rows) => {
          if (active) setPlaces(rows);
        })
        .catch((e) => {
          if (active && e.name !== "AbortError") setPlaceError(e.message);
        });
    return () => {
      active = false;
      c.abort();
    };
  }, [form.region]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const canEdit = ["draft", "rejected", "withdrawn"].includes(status);
  const change = (key, value) => {
    setDirty(true);
    setForm((f) => ({
      ...f,
      [key]: value,
      ...(key === "region" ? { place: "" } : {}),
    }));
  };
  const accept = (row) => {
    setVersion(row.version);
    setStatus(row.status);
    setDirty(false);
    setNote(row.review_note || "");
  };
  function save() {
    action.run(
      () =>
        api(API + "posts/" + (id ? id + "/" : ""), {
          method: id ? "PATCH" : "POST",
          data: { ...form, ...(id ? { version } : {}) },
        }),
      (r) => {
        accept(r.data);
        action.setNotice("草稿已保存");
        if (!id) navigate("/blog/write/" + r.data.id, { replace: true });
      },
    );
  }
  return (
    <main className="blog-page">
      <PageHeader
        title={id ? "编辑文章" : "写文章"}
        eyebrow="YOUR NATURE JOURNAL"
      >
        <Link
          className="btn secondary"
          to="/blog/mine"
          onClick={(e) => {
            if (dirty && !window.confirm("尚未保存的修改会丢失，继续离开？"))
              e.preventDefault();
          }}
        >
          我的投稿
        </Link>
      </PageHeader>
      <State
        loading={id && resource.loading}
        error={resource.error}
        onRetry={resource.reload}
      >
        <div className="blog-editor-layout">
          <section className="blog-editor card">
            <div className="blog-section-heading">
              <Label status={status} />
              <button
                className="btn secondary"
                type="button"
                onClick={() => setPreview((v) => !v)}
              >
                <Eye size={16} />
                {preview ? "继续编辑" : "预览"}
              </button>
            </div>
            {note && <p className="blog-review-note">审核说明：{note}</p>}
            {!canEdit && (
              <p className="blog-notice">
                {status === "published"
                  ? "文章已公开。撤回后才可编辑，修改后需要重新审核。"
                  : "文章已送审。撤回后才可编辑。"}
              </p>
            )}
            <form
              className="blog-form"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <fieldset disabled={!canEdit || action.busy}>
                <label>
                  标题
                  <input
                    value={form.title}
                    maxLength={120}
                    required
                    onChange={(e) => change("title", e.target.value)}
                    placeholder="给这次发现起个标题"
                  />
                </label>
                <div className="blog-fields">
                  <label>
                    分类
                    <select
                      value={form.category}
                      onChange={(e) => change("category", e.target.value)}
                    >
                      {Object.entries(CATEGORY_NAMES).map(([v, n]) => (
                        <option key={v} value={v}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    区域
                    <select
                      value={form.region}
                      onChange={(e) => change("region", e.target.value)}
                    >
                      <option value="">通用科普</option>
                      {catalog.data?.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {catalog.error && (
                  <p className="blog-error">
                    区域加载失败：{catalog.error}
                    <button
                      type="button"
                      className="blog-text-button"
                      onClick={catalog.reload}
                    >
                      重试
                    </button>
                  </p>
                )}
                <div className="blog-fields">
                  <label>
                    关联地点
                    <select
                      value={form.place}
                      disabled={!form.region}
                      onChange={(e) => change("place", e.target.value)}
                    >
                      <option value="">不关联地点</option>
                      {places.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    植物标签
                    <select
                      value={form.plant_label}
                      onChange={(e) => change("plant_label", e.target.value)}
                    >
                      <option value="">无</option>
                      {Object.entries(PLANT_NAMES).map(([v, n]) => (
                        <option key={v} value={v}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {placeError && (
                  <p className="blog-error">地点加载失败：{placeError}</p>
                )}
                <label>
                  摘要
                  <textarea
                    value={form.summary}
                    maxLength={400}
                    rows={3}
                    onChange={(e) => change("summary", e.target.value)}
                    placeholder="可选，不填写时从正文生成"
                  />
                </label>
                {preview ? (
                  <section className="blog-editor-preview">
                    <h2>{form.title || "文章预览"}</h2>
                    <Markdown text={form.body || "尚未填写正文"} />
                  </section>
                ) : (
                  <label>
                    正文 <span className="blog-muted">支持 Markdown</span>
                    <textarea
                      className="blog-body-input"
                      required
                      value={form.body}
                      maxLength={40000}
                      rows={20}
                      onChange={(e) => change("body", e.target.value)}
                      placeholder="记录观察、引用资料，并说明不确定之处…"
                    />
                  </label>
                )}
                <label>
                  资料出处
                  <input
                    value={form.source}
                    maxLength={500}
                    onChange={(e) => change("source", e.target.value)}
                    placeholder="可选：引用的书目、网站或原创观察说明"
                  />
                </label>
              </fieldset>
              <Notices action={action} />
              <div className="blog-editor-actions">
                {canEdit ? (
                  <>
                    <button
                      className="btn"
                      disabled={
                        action.busy || !form.title.trim() || !form.body.trim()
                      }
                    >
                      <Save size={16} />
                      {action.busy ? "保存中…" : "保存草稿"}
                    </button>
                    {id && (
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={action.busy || dirty}
                        onClick={() =>
                          action.run(
                            () =>
                              api(API + "posts/" + id + "/submit/", {
                                method: "POST",
                                data: { version },
                              }),
                            (r) => {
                              accept(r.data);
                              action.setNotice("文章已提交审核，通过后公开。");
                            },
                          )
                        }
                      >
                        <Send size={16} />
                        提交审核
                      </button>
                    )}
                    {dirty && id && (
                      <span className="blog-muted">先保存修改，再送审</span>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={action.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          status === "published"
                            ? "撤回后文章将不再公开，继续？"
                            : "撤回这篇待审文章？",
                        )
                      )
                        action.run(
                          () =>
                            api(API + "posts/" + id + "/withdraw/", {
                              method: "POST",
                              data: { version },
                            }),
                          (r) => {
                            accept(r.data);
                            action.setNotice("已撤回，可继续编辑");
                          },
                        );
                    }}
                  >
                    撤回并编辑
                  </button>
                )}
              </div>
            </form>
          </section>
          <aside className="blog-writing-aside">
            <FilePenLine size={29} />
            <h2>把观察留在这里</h2>
            <p>
              草稿仅本人可编辑，送审后由管理员核对。审核通过的文章会公开展示署名与内容。
            </p>
            <p>引用资料请注明出处。不要发布他人的个人信息或未经允许的作品。</p>
            <p>正文 {form.body.length.toLocaleString()} / 40,000 字符</p>
          </aside>
        </div>
      </State>
    </main>
  );
}

export function MyBlogPage() {
  const { user } = useAuth();
  return registered(user) ? (
    <MyBlog key={user.id} user={user} />
  ) : (
    <main className="blog-page">
      <Access />
    </main>
  );
}
function MyBlog({ user }) {
  const [kind, setKind] = useState("posts"),
    [page, setPage] = useState(1),
    action = useAction();
  const list = useResource(
    API + "mine/?" + new URLSearchParams({ kind, page, page_size: 20 }),
    user.id,
  );
  return (
    <main className="blog-page">
      <PageHeader title="我的投稿" eyebrow="MY JOURNAL">
        <Link className="btn" to="/blog/write">
          <FilePenLine size={17} />
          写文章
        </Link>
      </PageHeader>
      <div className="blog-tabs">
        {[
          ["posts", "文章"],
          ["comments", "评论"],
          ["reports", "举报"],
        ].map(([k, n]) => (
          <button
            key={k}
            className={kind === k ? "active" : ""}
            onClick={() => {
              setKind(k);
              setPage(1);
            }}
          >
            {n}
          </button>
        ))}
      </div>
      <Notices action={action} />
      <State
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        empty={!list.data?.length && "这里还没有记录"}
      >
        <div className="blog-records">
          {list.data?.map((row) => (
            <article className="card blog-record" key={row.id}>
              <div className="blog-section-heading">
                <Label status={row.status} />
                <time>{formatTime(row.updated_at)}</time>
              </div>
              <h2>
                {kind === "posts"
                  ? row.title
                  : kind === "reports"
                    ? row.reason
                    : "我的评论"}
              </h2>
              {kind === "comments" ? (
                <p className="blog-comment-text">{row.body}</p>
              ) : (
                <p>{row.summary || row.details}</p>
              )}
              {row.review_note && (
                <p className="blog-review-note">处理说明：{row.review_note}</p>
              )}
              <div className="blog-row-actions">
                {kind === "posts" ? (
                  <>
                    <Link
                      className="btn secondary"
                      to={"/blog/write/" + row.id}
                    >
                      管理文章
                    </Link>
                    {row.status === "published" && (
                      <Link className="blog-text-button" to={"/blog/" + row.id}>
                        查看公开文章
                        <ArrowUpRight size={14} />
                      </Link>
                    )}
                  </>
                ) : (
                  row.target_kind !== "comment" && (
                    <Link
                      className="blog-text-button"
                      to={
                        row.target_kind === "post"
                          ? "/blog/" + row.target_id
                          : "/detail/content/" + row.target_id
                      }
                    >
                      查看原文
                      <ArrowUpRight size={14} />
                    </Link>
                  )
                )}
                {kind !== "reports" && (
                  <button
                    className="blog-text-button danger"
                    disabled={action.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "删除这" +
                            (kind === "posts" ? "篇文章" : "条评论") +
                            "？已公开内容将撤下。",
                        )
                      )
                        action.run(
                          () =>
                            api(API + kind + "/" + row.id + "/", {
                              method: "DELETE",
                              data: { version: row.version },
                            }),
                          () => {
                            setPage(1);
                            list.reload();
                          },
                        );
                    }}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        <Pagination meta={list.meta} page={page} onPage={setPage} />
      </State>
    </main>
  );
}
export function BlogModerationPage() {
  const { user } = useAuth();
  return registered(user) && user.role === "admin" ? (
    <Moderation key={user.id} user={user} />
  ) : (
    <main className="blog-page">
      <Access admin />
    </main>
  );
}
function Moderation({ user }) {
  const [kind, setKind] = useState("posts"),
    [state, setState] = useState("pending"),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(null);
  const list = useResource(
    API +
      "moderation/?" +
      new URLSearchParams({ kind, state, page, page_size: 20 }),
    user.id,
  );
  const options = {
    posts: ["pending", "published", "rejected", "withdrawn"],
    comments: ["pending", "approved", "rejected", "hidden"],
    reports: ["pending", "resolved", "dismissed"],
  };
  return (
    <main className="blog-page">
      <PageHeader title="博客审核" eyebrow="EDITORIAL DESK">
        <Link className="btn secondary" to="/admin">
          管理工作台
        </Link>
      </PageHeader>
      <div className="blog-moderation-tools">
        <div className="blog-tabs">
          {[
            ["posts", "文章"],
            ["comments", "评论"],
            ["reports", "举报"],
          ].map(([k, n]) => (
            <button
              key={k}
              className={kind === k ? "active" : ""}
              onClick={() => {
                setKind(k);
                setState("pending");
                setPage(1);
                setSelected(null);
              }}
            >
              {n}
            </button>
          ))}
        </div>
        <label>
          状态
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            {options[kind].map((v) => (
              <option key={v} value={v}>
                {stateNames[v]}
              </option>
            ))}
            <option value="all">全部状态</option>
          </select>
        </label>
      </div>
      <State
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        empty={!list.data?.length && "当前没有需要处理的记录"}
      >
        <div className="blog-records">
          {list.data?.map((row) => (
            <article className="card blog-record" key={row.id}>
              <div className="blog-section-heading">
                <Label status={row.status} />
                <time>{formatTime(row.updated_at)}</time>
              </div>
              <h2>{row.title || row.reason || "评论审核"}</h2>
              <p className="blog-excerpt">
                {row.summary || row.body || row.details}
              </p>
              <div className="blog-row-actions">
                <span className="blog-muted">
                  {row.author_name || "举报记录"} · 版本 {row.version}
                </span>
                <button
                  className="btn secondary"
                  onClick={() => setSelected(row.id)}
                >
                  查看与处理
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
        <Pagination meta={list.meta} page={page} onPage={setPage} />
      </State>
      {selected && (
        <Review
          key={kind + selected}
          kind={kind}
          id={selected}
          user={user}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            list.reload();
          }}
        />
      )}
    </main>
  );
}
function Review({ kind, id, user, onClose, onDone }) {
  const detail = useResource(
      API + "moderation/" + kind + "/" + id + "/",
      user.id,
    ),
    [note, setNote] = useState(""),
    action = useAction(),
    row = detail.data;
  function decide(value) {
    if (
      !window.confirm(
        "确认" +
          {
            publish: "发布文章",
            reject: "退回内容",
            unpublish: "下架文章",
            approve: "公开评论",
            hide: "隐藏评论",
            remove: "下架举报对象并结案",
            resolve: "标记举报已处理",
            dismiss: "不予采纳举报",
          }[value] +
          "？",
      )
    )
      return;
    action.run(
      () =>
        api(API + "moderation/" + kind + "/" + id + "/", {
          method: "POST",
          data: {
            version: row.version,
            action: value,
            note,
            ...(value === "remove"
              ? { target_version: row.target?.version }
              : {}),
          },
        }),
      onDone,
    );
  }
  const actions =
    kind === "posts"
      ? row?.status === "pending"
        ? [
            ["publish", "通过并发布"],
            ["reject", "退回修改"],
          ]
        : row?.status === "published"
          ? [["unpublish", "下架文章"]]
          : []
      : kind === "comments"
        ? row?.status === "pending"
          ? [
              ["approve", "通过并公开"],
              ["reject", "不予公开"],
            ]
          : row?.status === "approved"
            ? [["hide", "隐藏评论"]]
            : []
        : row?.status === "pending"
          ? [
              ["resolve", "处理完成"],
              ["dismiss", "不予采纳"],
              ...(row.target && row.target_kind !== "content"
                ? [["remove", "下架对象并结案"]]
                : []),
            ]
          : [];
  return (
    <Modal
      title={
        kind === "posts"
          ? "文章审核"
          : kind === "comments"
            ? "评论审核"
            : "举报处理"
      }
      onClose={() => {
        if (!action.busy) onClose();
      }}
      className="blog-review-modal"
    >
      <State
        loading={detail.loading}
        error={detail.error}
        onRetry={detail.reload}
      >
        {row && (
          <>
            <div className="blog-section-heading">
              <Label status={row.status} />
              <span>版本 {row.version}</span>
            </div>
            <h2>{row.title || row.reason || "读者评论"}</h2>
            {kind === "posts" ? (
              <>
                <p>
                  {row.author_name} · {CATEGORY_NAMES[row.category]}
                </p>
                <p>{row.summary}</p>
                <Markdown text={row.body} />
                {row.source && (
                  <p className="blog-source">资料出处：{row.source}</p>
                )}
              </>
            ) : (
              <p className="blog-comment-text">{row.body || row.details}</p>
            )}
            {kind === "reports" && (
              <section className="blog-report-target">
                <h3>举报对象</h3>
                {row.target ? (
                  <>
                    <p>{row.target.title || row.target.author_name}</p>
                    <p className="blog-comment-text">{row.target.body}</p>
                    {row.target_kind === "content" && (
                      <Link
                        className="btn secondary"
                        to="/admin"
                        onClick={onClose}
                      >
                        前往原有资料管理
                      </Link>
                    )}
                  </>
                ) : (
                  <p>对象已不可用，请核对后填写处理结论。</p>
                )}
              </section>
            )}
            {kind === "comments" && (
              <Link
                className="blog-text-button"
                to={
                  row.target_kind === "post"
                    ? "/blog/" + row.target_id
                    : "/detail/content/" + row.target_id
                }
                onClick={onClose}
              >
                查看评论所在文章
                <ArrowUpRight size={14} />
              </Link>
            )}
            {row.review_note && (
              <p className="blog-review-note">上次处理：{row.review_note}</p>
            )}
            {!!actions.length && (
              <label className="blog-review-note-input">
                处理说明
                <textarea
                  maxLength={1000}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="退回、下架或举报结案须填写具体说明"
                />
              </label>
            )}
            <Notices action={action} />
            {action.error && (
              <button
                className="blog-text-button"
                disabled={action.busy}
                onClick={detail.reload}
              >
                重新读取当前记录
              </button>
            )}
            <div className="blog-review-actions">
              {actions.map(([v, n]) => (
                <button
                  key={v}
                  disabled={
                    action.busy ||
                    (!["publish", "approve"].includes(v) && !note.trim())
                  }
                  className={
                    "btn " +
                    ([
                      "reject",
                      "unpublish",
                      "hide",
                      "remove",
                      "dismiss",
                    ].includes(v)
                      ? "secondary"
                      : "")
                  }
                  onClick={() => decide(v)}
                >
                  {n}
                </button>
              ))}
            </div>
            <details className="blog-audit">
              <summary>操作记录（{row.audits?.length || 0}）</summary>
              {row.audits?.map((a) => (
                <p key={a.id}>
                  {formatTime(a.created_at)} · {a.action} ·{" "}
                  {stateNames[a.from_status] || "新建"} →{" "}
                  {stateNames[a.to_status] || a.to_status}
                  {a.note && " · " + a.note}
                </p>
              ))}
            </details>
          </>
        )}
      </State>
    </Modal>
  );
}
