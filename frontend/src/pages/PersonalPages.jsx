import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  Camera,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  FilePenLine,
  Flower2,
  Footprints,
  Heart,
  ImagePlus,
  Leaf,
  LockKeyhole,
  LogOut,
  MapPin,
  MessageCircle,
  Palette,
  Pencil,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  Waves,
  X,
} from "lucide-react";
import { api, uploadFile, assetURL } from "../lib/api.js";
import { useAuth, useTheme } from "../state.jsx";
import { PageHeader, Markdown, Modal, AIButton } from "../components.jsx";
import AltchaField from "../AltchaField.jsx";
import NotificationButton from "../NotificationButton.jsx";
import {
  time,
  pending,
  statusLabel,
  errorText,
  flowerCapability,
  flowerResult,
  riverCapability,
  riverResult,
  summaryView,
  submissionStatuses,
  categories,
  themes,
  listData,
  safeNext,
} from "./PersonalHelpers.js";
import "./PersonalPages.css";
import siteLegal from "../../../backend/data/site-legal.json";

const AGREEMENT = { accepted: true, version: "2026-10-07" };
const recordTypes = {
  favorites: {
    title: "我的收藏",
    endpoint: "favorites/",
    Icon: Heart,
    heading: "喜欢的风景，值得收藏",
    copy: "浏览地点或科普文章，点击收藏后就能在这里找到。",
    to: "/explore",
    action: "去发现",
  },
  histories: {
    title: "浏览记录",
    endpoint: "histories/",
    Icon: Clock3,
    heading: "从一次好奇开始",
    copy: "阅读文章或打开地点详情后，可以在这里回看。浏览记录需在“我的”中开启。",
    to: "/explore",
    action: "去浏览",
  },
  recognition: {
    title: "识别记录",
    endpoint: "recognition-jobs/",
    Icon: Flower2,
    heading: "留下一次植物发现",
    copy: "拍摄或选择一张花卉照片，认识身边的绿色。",
    to: "/recognize",
    action: "去识别",
  },
  assessment: {
    title: "河道观察",
    endpoint: "assessment-jobs/",
    Icon: Waves,
    heading: "从一张河道照片开始",
    copy: "上传照片进行河道图像观察，结果会保存在这里。",
    to: "/recognize?mode=river",
    action: "去观察",
  },
  visits: {
    title: "游览足迹",
    endpoint: "visits/",
    Icon: Footprints,
    heading: "记录你走过的绿意",
    copy: "在地点详情主动添加游览记录，留下自己的足迹。",
    to: "/explore",
    action: "去看地点",
  },
};
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
const checkImage = (file) => {
  if (!file || !imageTypes.includes(file.type))
    throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (file.size > 5 * 1024 * 1024)
    throw new Error("图片不能超过 5MB，请压缩后重试。");
};
const emptyDraft = () => ({
  id: "",
  version: 0,
  title: "",
  body: "",
  source: "",
  category: "green",
  status: "draft",
});
const isEditableDraft = (item) =>
  item && ["draft", "rejected", "withdrawn"].includes(item.status);
function Notice({ children, error = false }) {
  return children ? (
    <div
      className={`p-notice ${error ? "p-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  ) : null;
}
function Loading() {
  return (
    <div className="p-loading" role="status">
      <RefreshCw size={20} className="p-spin" />
      正在读取记录…
    </div>
  );
}
function PrivateTag() {
  return (
    <span className="p-private">
      <LockKeyhole size={13} />
      仅当前账号可见
    </span>
  );
}
function SectionTitle({ title, children }) {
  return (
    <div className="p-section-title">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
function Empty({ Icon = Leaf, title, copy, to, action }) {
  return (
    <div className="card p-empty">
      <div className="p-empty-mark">
        <Icon size={42} strokeWidth={1.4} />
      </div>
      <h2>{title}</h2>
      <p>{copy}</p>
      {to && (
        <Link className="btn" to={to}>
          {action}
          <ArrowRight size={16} />
        </Link>
      )}
    </div>
  );
}
function AuthGate({ children = "登录后查看和管理自己的记录。" }) {
  return (
    <Empty
      Icon={LockKeyhole}
      title="开启你的绿色记录"
      copy={children}
      to="/me"
      action="前往登录"
    />
  );
}
function Confirm({
  title,
  text,
  onClose,
  onConfirm,
  busy,
  error,
  confirmLabel = "确认删除",
}) {
  return (
    <Modal title={title} onClose={busy ? () => {} : onClose}>
      <p className="p-confirm-copy">{text}</p>
      <Notice error>{error}</Notice>
      <div className="p-actions">
        <button className="btn secondary" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="btn p-danger-button"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "正在处理…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
function useIdentity(allowGuest = false) {
  const auth = useAuth();
  const user = auth.user || (allowGuest ? auth.visitor : null);
  const current = useRef(user?.id);
  current.current = user?.id;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return {
    user,
    valid: (id) => alive.current && !!id && current.current === id,
  };
}
function usePrivateImage(asset, rawURL = "", allowGuest = false) {
  const auth = useAuth();
  const user = auth.user || (allowGuest ? auth.visitor : null);
  const [state, setState] = useState({ src: "", error: "", owner: "" });
  useEffect(() => {
    setState({ src: "", error: "", owner: user?.id || "" });
    if (!user || (!asset && !rawURL)) return;
    let alive = true,
      objectURL = "";
    const controller = new AbortController();
    (async () => {
      try {
        const url = asset ? assetURL(asset, "thumbnail") : rawURL;
        const check = new URL(url, window.location.origin);
        if (check.origin !== window.location.origin)
          throw new Error("图片地址无效");
        const res = await fetch(check.href, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok)
          throw new Error("照片已过期、删除或暂不可访问，记录仍可查看。");
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) throw new Error("图片暂时不可用");
        objectURL = URL.createObjectURL(blob);
        if (alive) setState({ src: objectURL, error: "", owner: user.id });
        else URL.revokeObjectURL(objectURL);
      } catch (error) {
        if (alive && error.name !== "AbortError")
          setState({ src: "", error: errorText(error), owner: user.id });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [asset, rawURL, user?.id]);
  return state.owner === user?.id ? state : { src: "", error: "" };
}
function useCollection(endpoint, enabled = true, allowGuest = false) {
  const { user, valid } = useIdentity(allowGuest);
  const [state, setState] = useState({
    owner: "",
    rows: [],
    next: "",
    loading: false,
    error: "",
  });
  const generation = useRef(0);
  const seen = useRef(new Set());
  const load = useCallback(
    async (next = "") => {
      const id = user?.id,
        request = ++generation.current;
      if (!id || !enabled) {
        setState({ owner: "", rows: [], next: "", loading: false, error: "" });
        return;
      }
      setState((s) => ({
        ...s,
        owner: id,
        rows: next ? s.rows : [],
        loading: true,
        error: "",
      }));
      try {
        const path = next ? safeNext(next, endpoint) : endpoint;
        if (next && seen.current.has(path))
          throw new Error("分页重复，请刷新记录。");
        const result = await api(path);
        const rows = listData(result),
          further = safeNext(result.meta?.next, endpoint);
        if (!valid(id) || request !== generation.current) return;
        if (!next) seen.current = new Set();
        seen.current.add(path);
        if (further && seen.current.has(further))
          throw new Error("分页重复，请刷新记录。");
        setState((s) => ({
          owner: id,
          rows: [
            ...new Map(
              [...(next ? s.rows : []), ...rows].map((row) => [row.id, row]),
            ).values(),
          ],
          next: further,
          loading: false,
          error: "",
        }));
      } catch (error) {
        if (valid(id) && request === generation.current)
          setState((s) => ({ ...s, loading: false, error: errorText(error) }));
      }
    },
    [endpoint, enabled, user?.id],
  );
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return {
    ...(state.owner === user?.id
      ? state
      : { rows: [], next: "", loading: false, error: "" }),
    load,
    user,
  };
}
function CollectionStatus({ collection, empty }) {
  return (
    <>
      {collection.loading && !collection.rows.length && <Loading />}
      <Notice error>{collection.error}</Notice>
      {!collection.loading &&
        !collection.error &&
        !collection.rows.length &&
        empty}
      {collection.error && (
        <button className="btn secondary" onClick={() => collection.load()}>
          <RefreshCw size={16} />
          重新加载
        </button>
      )}
      {collection.next && (
        <button
          className="btn secondary p-load-more"
          disabled={collection.loading}
          onClick={() => collection.load(collection.next)}
        >
          {collection.loading ? "正在加载…" : "加载更多"}
        </button>
      )}
    </>
  );
}

function LoginForm() {
  const { login, register } = useAuth();
  const navigate = useNavigate(), [loginParams] = useSearchParams();
  const afterLogin = loginParams.get("next") || "";
  const [mode, setMode] = useState("login"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [nickname, setNickname] = useState(""),
    [agreed, setAgreed] = useState(false),
    [altcha, setAltcha] = useState(""),
    [captchaVersion, setCaptchaVersion] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (!agreed) {
      setError("请先阅读并勾选同意用户协议与隐私说明。");
      return;
    }
    if (!altcha) {
      setError("请先完成防刷验证。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "register")
        await register({
          email: email.trim(),
          password,
          nickname: nickname.trim(),
          agreement: AGREEMENT,
          altcha,
        });
      else await login(email.trim(), password, AGREEMENT, altcha);
      if (/^\/blog\/(?:write(?:\/[A-Za-z0-9_-]+)?|mine)\/?$/.test(afterLogin)) navigate(afterLogin, { replace: true });
    } catch (e) {
      setError(errorText(e));
      // Every submitted proof is single-use, including a wrong-password attempt.
      setAltcha("");
      setCaptchaVersion(value => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card p-login">
      <div className="p-login-heading">
        <div className="p-icon-tile">
          <Leaf size={26} />
        </div>
        <div>
          <h2>开启你的绿色记录</h2>
          <p>登录后管理自己的收藏、足迹和观察记录。</p>
        </div>
      </div>
      <div className="p-tabs" aria-label="账号操作">
        <button
          aria-pressed={mode === "login"}
          onClick={() => {
            setMode("login");
            setCaptchaVersion(value => value + 1);
            setError("");
            setAltcha("");
            setAgreed(false);
          }}
          disabled={busy}
          className={mode === "login" ? "active" : ""}
        >
          登录
        </button>
        <button
          aria-pressed={mode === "register"}
          onClick={() => {
            setMode("register");
            setCaptchaVersion(value => value + 1);
            setError("");
            setAltcha("");
            setAgreed(false);
          }}
          disabled={busy}
          className={mode === "register" ? "active" : ""}
        >
          创建账号
        </button>
      </div>
      <form onSubmit={submit} className="p-form">
        <label>
          {mode === "register" ? "邮箱" : "邮箱 / 用户名"}
          <input
            className="input"
            type={mode === "register" ? "email" : "text"}
            autoComplete={mode === "register" ? "email" : "username"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={busy}
            placeholder={
              mode === "register" ? "输入你的邮箱" : "输入邮箱或用户名"
            }
          />
        </label>
        {mode === "register" && (
          <label>
            昵称
            <input
              className="input"
              maxLength={32}
              autoComplete="nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              required
              disabled={busy}
              placeholder="如何称呼你"
            />
          </label>
        )}
        <label>
          密码
          <input
            className="input"
            type="password"
            autoComplete={
              mode === "register" ? "new-password" : "current-password"
            }
            maxLength={128}
            minLength={1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={busy}
            placeholder={mode === "register" ? "至少 1 个字符" : "输入密码"}
          />
        </label>
        <div className="p-agreement">
          <label>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={busy}
            />
            我已阅读并同意
          </label>
          <Link to="/legal/terms">《用户协议》</Link>
          <span>与</span>
          <Link to="/legal/privacy">《隐私说明》</Link>
        </div>
        <AltchaField key={`${mode}:${captchaVersion}`} purpose={mode} onChange={setAltcha} disabled={busy} />
        <Notice error>{error}</Notice>
        <button className="btn" disabled={busy}>
          {busy ? "正在处理…" : mode === "register" ? "创建账号" : "登录"}
        </button>
        <p className="p-muted p-small">
          此网页使用独立账号，个人记录与微信小程序分别保存。
        </p>
      </form>
    </section>
  );
}
function MenuLink({ to, Icon, children, value }) {
  return (
    <Link className="p-menu-row" to={to}>
      {Icon && <Icon size={20} />}
      <span>{children}</span>
      {value && <small>{value}</small>}
      <ChevronRight size={17} />
    </Link>
  );
}
export function ProfilePage() {
  const { user, refresh, logout } = useAuth();
  const { theme } = useTheme();
  const { valid } = useIdentity();
  const [editing, setEditing] = useState(false),
    [nickname, setNickname] = useState(""),
    [avatar, setAvatar] = useState(null),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState(false);
  const photo = usePrivateImage(user?.avatar_asset_id, user?.avatar_url || "");
  useEffect(() => {
    setEditing(false);
    setNickname(user?.nickname || "");
    setAvatar(null);
    setError("");
    setNotice("");
    setConfirm(false);
  }, [user?.id]);
  useEffect(() => {
    const url = avatar ? URL.createObjectURL(avatar) : "";
    setPreview(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [avatar]);
  async function save(event) {
    event.preventDefault();
    const id = user.id;
    setBusy(true);
    setError("");
    try {
      const data = { nickname: nickname.trim() };
      if (!data.nickname || [...data.nickname].length > 32)
        throw new Error("请输入 1 至 32 字的昵称。");
      if (avatar) {
        const asset = await uploadFile(avatar, "avatar");
        if (!valid(id)) return;
        data.avatar_asset_id = (asset.data || asset).id;
      }
      await api("me/", { method: "PATCH", data });
      if (!valid(id)) return;
      await refresh();
      setEditing(false);
      setAvatar(null);
      setNotice("个人资料已保存。");
    } catch (e) {
      if (valid(id)) setError(errorText(e));
    } finally {
      if (valid(id)) setBusy(false);
    }
  }
  async function privacy(value) {
    const id = user.id;
    setBusy(true);
    setError("");
    try {
      await api("me/", { method: "PATCH", data: { record_history: value } });
      if (valid(id)) {
        await refresh();
        setNotice(
          value
            ? "已开启浏览记录。"
            : "已停止新增浏览记录，已有记录可自行删除。",
        );
      }
    } catch (e) {
      if (valid(id)) setError(errorText(e));
    } finally {
      if (valid(id)) setBusy(false);
    }
  }
  async function deleteAccount() {
    const id = user.id;
    setBusy(true);
    setError("");
    try {
      await api("me/", { method: "DELETE" });
      if (valid(id)) {
        await refresh();
        setConfirm(false);
      }
    } catch (e) {
      if (valid(id)) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="personal-page p-profile">
      <PageHeader eyebrow="MY GREEN JOURNAL / 绿色手记" title="我的">
        <NotificationButton />
      </PageHeader>
      {user ? (
        <>
          <div className="p-profile-identity">
            <div className="p-avatar">
              {photo.src ? (
                <img src={photo.src} alt="个人头像" />
              ) : (
                <UserRound size={40} strokeWidth={1.5} />
              )}
            </div>
            <div className="p-grow">
              <h2>{user.nickname || "绿色生活体验者"}</h2>
              <p>{user.email}</p>
              <button
                className="p-link-button"
                onClick={() => {
                  setEditing(!editing);
                  setNickname(user.nickname || "");
                  setAvatar(null);
                }}
                disabled={busy}
              >
                <Pencil size={14} />
                {editing ? "收起编辑" : "编辑资料"}
              </button>
            </div>
            <div className="p-profile-leaf">
              <Leaf size={64} strokeWidth={1} />
            </div>
          </div>
          <Notice error>{error}</Notice>
          <Notice>{notice}</Notice>
          {editing && (
            <form className="card p-form p-profile-editor" onSubmit={save}>
              <h3>编辑资料</h3>
              <label className="p-avatar-edit">
                <span className="p-avatar p-avatar-small">
                  {preview || photo.src ? (
                    <img src={preview || photo.src} alt="头像预览" />
                  ) : (
                    <UserRound size={25} />
                  )}
                </span>
                <span>
                  选择头像<small>JPG、PNG、WebP，最大 5MB</small>
                </span>
                <input
                  aria-label="选择头像"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy}
                  onChange={(e) => {
                    try {
                      checkImage(e.target.files[0]);
                      setAvatar(e.target.files[0]);
                      setError("");
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                />
              </label>
              <label>
                昵称
                <input
                  className="input"
                  required
                  maxLength={32}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="p-actions">
                <button className="btn" disabled={busy}>
                  {busy ? "正在保存…" : "保存个人资料"}
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setAvatar(null);
                  }}
                >
                  取消
                </button>
              </div>
            </form>
          )}
          <SectionTitle title="我的记录">
            <PrivateTag />
          </SectionTitle>
          <div className="p-record-grid">
            {Object.entries(recordTypes).map(([kind, item]) => (
              <Link key={kind} to={"/records/" + kind}>
                <div className="p-record-icon">
                  <item.Icon size={25} strokeWidth={1.7} />
                </div>
                <span>{item.title}</span>
              </Link>
            ))}
            <Link to="/conversations">
              <div className="p-record-icon">
                <MessageCircle size={25} strokeWidth={1.7} />
              </div>
              <span>AI 对话</span>
            </Link>
          </div>
        </>
      ) : (
        <LoginForm />
      )}
      <SectionTitle title="偏好与服务" />
      <div className="card p-menu">
        {user && (
          <MenuLink to="/submissions" Icon={FilePenLine}>
            我的资料反馈
          </MenuLink>
        )}
        <MenuLink
          to="/themes"
          Icon={Palette}
          value={themes.find((t) => t.id === (theme?.id || theme))?.name}
        >
          外观与主题
        </MenuLink>
        <MenuLink to="/feedback" Icon={MessageCircle}>
          意见与反馈
        </MenuLink>
        {user?.role === "admin" && (
          <MenuLink to="/admin" Icon={ShieldCheck}>
            平台管理
          </MenuLink>
        )}
      </div>
      <SectionTitle title={user ? "隐私与账号" : "协议与隐私"} />
      <div className="card p-menu">
        {user && (
          <div className="p-setting">
            <div>
              <span>保存浏览记录</span>
              <p>关闭后不再新增，已有记录可自行删除</p>
            </div>
            <label className="p-switch">
              <input
                aria-label="保存浏览记录"
                type="checkbox"
                checked={!!user.record_history}
                onChange={(e) => privacy(e.target.checked)}
                disabled={busy}
              />
              <span />
            </label>
          </div>
        )}
        <MenuLink to="/legal/privacy" Icon={ShieldCheck}>
          隐私说明
        </MenuLink>
        <MenuLink to="/legal/terms" Icon={BookOpen}>
          用户协议
        </MenuLink>
        {user && (
          <button
            className="p-menu-row p-danger-text"
            onClick={() => setConfirm(true)}
            disabled={busy}
          >
            <Trash2 size={20} />
            <span>注销账号</span>
            <ChevronRight size={17} />
          </button>
        )}
      </div>
      {user && (
        <button
          className="btn secondary p-logout"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await logout();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <LogOut size={17} />
          退出登录
        </button>
      )}
      {confirm && (
        <Confirm
          error={error}
          title="注销账号"
          text="注销将删除本网页账号、所有个人记录、反馈、AI 会话和上传图片，并使现有会话失效。此操作无法恢复。已发送给外部服务的请求不会因此撤回。"
          busy={busy}
          onClose={() => setConfirm(false)}
          onConfirm={deleteAccount}
        />
      )}
    </div>
  );
}

export function ThemesPage() {
  const { theme, setTheme } = useTheme();
  const active = theme?.id || theme;
  const [notice, setNotice] = useState("");
  return (
    <div className="personal-page">
      <PageHeader eyebrow="APPEARANCE / 界面外观" title="外观与主题" />
      <div className="p-theme-grid">
        {themes.map((item) => (
          <article
            key={item.id}
            className={`card p-theme-card ${active === item.id ? "is-selected" : ""}`}
          >
            <div
              className={`p-theme-preview p-preview-${item.id}`}
              style={{
                "--preview-bg": item.colors[0],
                "--preview-primary": item.colors[1],
                "--preview-accent": item.colors[2],
              }}
            >
              <span>{item.tag}</span>
              <h3>{item.headline}</h3>
              <div className="p-theme-landscape">
                {item.illustration === "leaf" ? (
                  <Leaf size={88} strokeWidth={0.9} />
                ) : item.illustration === "photo" ? (
                  <img
                    src="/assets/themes/editorial/entry-explore.jpg"
                    alt=""
                  />
                ) : (
                  <Waves size={96} strokeWidth={0.7} />
                )}
              </div>
              <div className="p-preview-tiles">
                <i />
                <i />
                <i />
              </div>
            </div>
            <div className="p-theme-info">
              <div>
                <h2>{item.name}</h2>
                <p>{item.description}</p>
              </div>
              {active === item.id && (
                <span className="p-chip">
                  <Check size={13} />
                  使用中
                </span>
              )}
            </div>
            <button
              className="btn secondary"
              aria-label={`${active === item.id ? "当前主题" : "使用主题"}：${item.name}`}
              disabled={active === item.id}
              onClick={() => {
                try {
                  setTheme(item.id);
                  setNotice("已应用「" + item.name + "」。");
                } catch (e) {
                  setNotice(errorText(e));
                }
              }}
            >
              {active === item.id ? "当前主题" : "使用这个主题"}
            </button>
          </article>
        ))}
      </div>
      <Notice>{notice}</Notice>
    </div>
  );
}

function PointPicker({ places, onSelect, onClose }) {
  const container = useRef(null),
    mapRef = useRef(null),
    marker = useRef(null);
  const [point, setPoint] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const imported = await import("leaflet");
        await import("leaflet/dist/leaflet.css");
        if (!alive || !container.current) return;
        const L = imported.default || imported;
        const map = L.map(container.current).setView([39.12, 117.2], 11);
        mapRef.current = map;
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap contributors",
          maxZoom: 19,
          referrerPolicy: "strict-origin-when-cross-origin",
        }).addTo(map);
        map.on("click", (event) => {
          const latlng = event.latlng;
          if (marker.current) marker.current.remove();
          marker.current = L.circleMarker(latlng, {
            radius: 8,
            color: "#3a7d5c",
            fillOpacity: 0.6,
          }).addTo(map);
          setPoint({
            latitude: Number(latlng.lat.toFixed(6)),
            longitude: Number(latlng.lng.toFixed(6)),
            coordinate_system: "WGS84",
          });
        });
      } catch (e) {
        if (alive) setError("地图暂不可用，可从下方地点中选择。");
      }
    })();
    return () => {
      alive = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);
  const validPlaces = places.filter(
    (p) =>
      p.is_demo === false &&
      p.coordinates_verified === true &&
      Number.isFinite(p.latitude) &&
      Number.isFinite(p.longitude) &&
      ["WGS84", "GCJ02"].includes(p.coordinate_system),
  );
  return (
    <Modal title="选择本次观察位置" onClose={onClose}>
      <p className="p-muted">
        点击地图选择具体点位，或从已核验的地点列表选择。提交观察时才保存。
      </p>
      <div ref={container} className="p-point-map" />
      <Notice error>{error}</Notice>
      {point && (
        <div className="p-location-selected">
          <MapPin size={16} />
          已选：{point.latitude}, {point.longitude} · {point.coordinate_system}
          <button className="btn" onClick={() => onSelect(point, "地图选点")}>
            使用此位置
          </button>
        </div>
      )}
      <label className="p-field">
        从地点列表选择
        <select
          className="input"
          defaultValue=""
          onChange={(e) => {
            const place = validPlaces.find((p) => p.id === e.target.value);
            if (place)
              onSelect(
                {
                  latitude: place.latitude,
                  longitude: place.longitude,
                  coordinate_system: place.coordinate_system,
                },
                place.name,
              );
          }}
        >
          <option value="">选择具体地点</option>
          {validPlaces.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {!validPlaces.length && (
        <p className="p-muted p-small">
          暂时没有可选的已核验地点，仍可在地图选点或不附位置。
        </p>
      )}
    </Modal>
  );
}
function FlowerResult({ result }) {
  return (
    <div className="card p-result">
      <span className="p-eyebrow">
        {result.recognized
          ? "MODEL RESULT / 模型结果"
          : "NEEDS A CLOSER LOOK / 需要再看一眼"}
      </span>
      <h2>{result.heading}</h2>
      <p>{result.explanation}</p>
      {!!result.candidates.length && <h3>候选类别 · 最多 3 项</h3>}
      {result.candidates.map((candidate) => (
        <div className="p-candidate" key={candidate.label || candidate.rank}>
          <div>
            <span className="p-candidate-rank">0{candidate.rank}</span>
            <strong>{candidate.name}</strong>
            <small>分数 {candidate.score_label}</small>
          </div>
          <div className="p-score-track">
            <i style={{ width: candidate.bar_width + "%" }} />
          </div>
          {candidate.content_id && (
            <Link
              to={"/detail/content/" + candidate.content_id}
              className="p-link-button"
            >
              阅读相关科普
              <ChevronRight size={15} />
            </Link>
          )}
        </div>
      ))}
      {!!result.candidates.length && (
        <p className="p-muted p-small">
          以上为模型输出分数，未经校准，不是正确率。
        </p>
      )}
      <details className="p-details">
        <summary>本次识别信息</summary>
        <p>
          模型：{result.model_name}
          <br />
          版本：{result.model_version} · 分类分数阈值：{result.threshold_label}
        </p>
        <p>{result.threshold_note}</p>
      </details>
      <Notice>{result.disclaimer}</Notice>
    </div>
  );
}
function RiverResult({ task, result }) {
  const summary = summaryView(task);
  return (
    <>
      <div className="p-result-banner">
        <span className="p-eyebrow">RIVER OBSERVATION / 河道观察</span>
        <h2>{result.heading}</h2>
        {result.has_score && (
          <div className="p-rule-score">
            {result.score_label}
            <small> / 100</small>
            <span>图像教学规则分</span>
          </div>
        )}
        <p>
          {task.reason === "LOW_IMAGE_QUALITY"
            ? "照片质量不足，暂不能生成观察结论。可以在安全位置补拍清晰照片。"
            : result.explanation}
        </p>
      </div>
      <div className="p-result-columns">
        <div className="card">
          <SectionTitle title="检测候选">
            <span className="p-chip">{result.detections.length} 个</span>
          </SectionTitle>
          {result.detections.map((item, i) => (
            <div key={item.id} className="p-detection-row">
              <span>
                {i + 1} · {item.label}
              </span>
              <small>置信分数 {item.confidence_label}</small>
            </div>
          ))}
          {!result.detections.length && (
            <p className="p-muted">暂时没有可展示的漂浮物候选。</p>
          )}
          {!!result.detections.length && (
            <p className="p-muted p-small">
              编号对应照片中的候选框。框按原图相对位置展示，不代表人工核实。
            </p>
          )}
        </div>
        <div className="card">
          <h3>画面观察摘要</h3>
          {summary?.ready ? (
            <>
              <div className="p-observation-metrics">
                <div>
                  <strong>{summary.count}</strong>
                  <span>有效候选框</span>
                </div>
                <div>
                  <strong>{summary.area}</strong>
                  <span>框并集占整图</span>
                </div>
              </div>
              <p className="p-small p-muted">
                重叠框的面积只算一次。这是图片中的框面积，不是水面覆盖率；框数也不代表实际物体数或密度。
              </p>
              <h4>候选框位于画面哪里</h4>
              <div className="p-observation-grid">
                {summary.grid.map((cell) => (
                  <div className={cell.active ? "active" : ""} key={cell.key}>
                    <span>{cell.label}</span>
                    <strong>{cell.count}</strong>
                  </div>
                ))}
              </div>
              <p className="p-small p-muted">
                按框中心在原图九宫格中计数，跨格框只记一次。上、下、左、右是照片方向，不是地图方位或污染分布。
              </p>
              <p className="p-small p-muted">
                置信分数范围 {summary.confidence}，不是正确概率。
                {summary.excluded > 0 &&
                  `另有 ${summary.excluded} 条候选未计入本摘要。`}
              </p>
            </>
          ) : (
            <p className="p-muted">
              {summary?.message ||
                "这条记录暂不能生成观察摘要。未检出或资料不完整，都不能说明水体清洁。"}
            </p>
          )}
        </div>
      </div>
      <div className="card">
        <h3>规则解释与观察建议</h3>
        {result.causes.map((item, i) => (
          <p key={i}>· {item}</p>
        ))}
        {result.suggestions.map((item, i) => (
          <p key={i}>· {item}</p>
        ))}
      </div>
      <details className="card p-details">
        <summary>本次观察信息</summary>
        <p>
          当前仅支持 IWHR
          数据训练的水面漂浮物观察，不区分塑料瓶、排污口或其他生态类别。
        </p>
        <p>
          模型：{result.model_name} · {result.model_version}
          <br />
          规则版本：{result.rule_version}
          <br />
          提交时间：{time(task.created_at)}
          <br />
          关联水体：{task.water_body?.name || "未关联"}
          {task.coordinate_system && (
            <>
              <br />
              本记录包含用户主动提供的位置 · {task.coordinate_system}
            </>
          )}
        </p>
      </details>
      <Notice>{result.disclaimer}</Notice>
    </>
  );
}
function ObservationPanel({ river, requestedId, onBusy }) {
  const { user, valid } = useIdentity(true);
  const { user: account, ensureVisitor } = useAuth();
  const endpoint = river ? "assessment-jobs/" : "recognition-jobs/";
  const records = useCollection(endpoint, true, true);
  const [health, setHealth] = useState(null),
    [healthError, setHealthError] = useState(""),
    [healthTick, setHealthTick] = useState(0),
    [task, setTask] = useState(null),
    [file, setFile] = useState(null),
    [preview, setPreview] = useState(""),
    [origin, setOrigin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [pollTick, setPollTick] = useState(0),
    [confirm, setConfirm] = useState(false),
    [waterBodies, setWaterBodies] = useState([]),
    [waterId, setWaterId] = useState(""),
    [places, setPlaces] = useState([]),
    [location, setLocation] = useState(null),
    [locationLabel, setLocationLabel] = useState(""),
    [locationNotice, setLocationNotice] = useState(""),
    [nearby, setNearby] = useState(null),
    [locating, setLocating] = useState(false),
    [picker, setPicker] = useState(false);
  const input = useRef(null),
    camera = useRef(null),
    selection = useRef(0),
    locationVersion = useRef(0),
    uploaded = useRef(null);
  const active = useRef(true);
  const privateImage = usePrivateImage(
    origin === "history" ? task?.asset_id : "", "", true,
  );
  useEffect(() => {
    if (!account) ensureVisitor().catch((e) => setError(errorText(e)));
  }, [account?.id, ensureVisitor]);
  const cap = river ? riverCapability(health) : flowerCapability(health);
  const view =
    task?.status === "succeeded"
      ? river
        ? riverResult(task)
        : flowerResult(task.result)
      : null;
  const picture = origin === "history" ? privateImage.src : preview;
  const Icon = river ? Waves : Flower2;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      selection.current++;
      locationVersion.current++;
    };
  }, []);
  useEffect(() => {
    onBusy(busy || locating);
    return () => onBusy(false);
  }, [busy, locating, onBusy]);
  useEffect(() => {
    let alive = true;
    setHealthError("");
    api("health/")
      .then((r) => {
        if (alive) setHealth(r.data);
      })
      .catch((e) => {
        if (alive) setHealthError("暂时无法确认模型状态：" + errorText(e));
      });
    if (river)
      Promise.allSettled([
        api("water-bodies/?page_size=100"),
        api("places/?page_size=100"),
      ]).then((results) => {
        if (!alive) return;
        if (results[0].status === "fulfilled")
          setWaterBodies(listData(results[0].value));
        else setLocationNotice("水体列表暂不可用，仍可不关联水体上传。");
        if (results[1].status === "fulfilled")
          setPlaces(listData(results[1].value));
      });
    return () => {
      alive = false;
    };
  }, [river, healthTick]);
  useEffect(() => {
    const url = file ? URL.createObjectURL(file) : "";
    setPreview(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  async function openJob(id) {
    if (!user || busy) return;
    const owner = user.id,
      version = ++selection.current;
    setError("");
    setFile(null);
    uploaded.current = null;
    setTask(null);
    setOrigin("history");
    setBusy(true);
    try {
      const r = await api(endpoint + encodeURIComponent(id) + "/");
      if (valid(owner) && version === selection.current) setTask(r.data);
    } catch (e) {
      if (valid(owner) && version === selection.current) {
        setError(errorText(e));
        setOrigin("");
      }
    } finally {
      if (valid(owner) && version === selection.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (requestedId && user) openJob(requestedId);
  }, [requestedId, user?.id]);
  useEffect(() => {
    if (!pending(task) || !user) return;
    let alive = true,
      timer;
    const owner = user.id,
      selected = selection.current,
      controller = new AbortController();
    let count = 0;
    async function poll() {
      try {
        const response = await api(
          endpoint + encodeURIComponent(task.id) + "/",
          { signal: controller.signal },
        );
        if (!alive || !valid(owner) || selected !== selection.current) return;
        setTask(response.data);
        if (pending(response.data)) {
          count++;
          if (count < 20) timer = setTimeout(poll, 3000);
          else setError("任务仍在处理中，可以稍后刷新结果，无需重复上传。");
        } else records.load();
      } catch (e) {
        if (alive && valid(owner) && e.name !== "AbortError") {
          setError(errorText(e));
          if (e.status === 404) {
            setTask(null);
            setOrigin("");
          }
        }
      }
    }
    poll();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [task?.id, !!pending(task), user?.id, endpoint, pollTick]);
  function selectFile(event) {
    const value = event.target.files[0];
    event.target.value = "";
    if (!value || !user || busy) return;
    try {
      checkImage(value);
      selection.current++;
      setTask(null);
      setOrigin("selected");
      setFile(value);
      uploaded.current = null;
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function submit() {
    if (!user || !file || busy || pending(task) || !cap.enabled || !health)
      return;
    const owner = user.id,
      version = selection.current;
    setBusy(true);
    setError("");
    try {
      let asset = uploaded.current;
      if (!asset) {
        const upload = await uploadFile(file, "recognition");
        asset = upload.data || upload;
        if (!valid(owner) || version !== selection.current) return;
        uploaded.current = asset;
      }
      const data = { asset_id: asset.id };
      if (river && waterId) data.water_body_id = waterId;
      if (river && location) Object.assign(data, location);
      const response = await api(endpoint, { method: "POST", data });
      if (valid(owner) && version === selection.current) {
        setTask(response.data);
        records.load();
      }
    } catch (e) {
      if (valid(owner) && version === selection.current)
        setError(errorText(e) + " 可先刷新最近记录核对，再重试。");
    } finally {
      if (valid(owner) && version === selection.current) setBusy(false);
    }
  }
  async function remove() {
    const owner = user.id;
    setBusy(true);
    setError("");
    try {
      await api(endpoint + task.id + "/", { method: "DELETE" });
      if (!valid(owner)) return;
      selection.current++;
      setTask(null);
      setOrigin("");
      setFile(null);
      setConfirm(false);
      uploaded.current = null;
      records.load();
    } catch (e) {
      if (valid(owner)) setError(errorText(e));
    } finally {
      if (valid(owner)) setBusy(false);
    }
  }
  async function findNearby(point, fuzzy = false, label = "") {
    const owner = user?.id,
      version = ++locationVersion.current;
    setLocating(true);
    setNearby(null);
    if (!fuzzy) {
      setLocation(point);
      setLocationLabel(label);
    }
    try {
      const result = await api("nearby-water-bodies/", { data: point });
      if (!valid(owner) || version !== locationVersion.current) return;
      setNearby(result.data?.match || null);
      setLocationNotice(
        (fuzzy
          ? "模糊位置仅用于查找候选，不保存为观察位置。"
          : "已选择本次位置，提交观察时才保存。") +
          (result.data?.match
            ? "请自行确认候选水体，不代表到访认证。"
            : "没有同坐标系的附近候选，仍可手选水体或直接上传。"),
      );
    } catch (e) {
      if (valid(owner) && version === locationVersion.current)
        setLocationNotice("附近水体查询暂不可用，仍可手选水体或直接上传。");
    } finally {
      if (valid(owner) && version === locationVersion.current)
        setLocating(false);
    }
  }
  function locate() {
    if (!navigator.geolocation) {
      setLocationNotice("当前浏览器不支持定位，仍可手动选点。");
      return;
    }
    const version = ++locationVersion.current;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!active.current || version !== locationVersion.current) return;
        findNearby(
          {
            latitude: Number(position.coords.latitude.toFixed(2)),
            longitude: Number(position.coords.longitude.toFixed(2)),
            coordinate_system: "WGS84",
          },
          true,
        );
      },
      () => {
        if (!active.current || version !== locationVersion.current) return;
        setLocating(false);
        setLocationNotice("未获取定位授权或定位超时，仍可手选水体或直接上传。");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }
  return (
    <div className="p-observation">
      <div className="p-flow-steps">
        {[
          "选择照片",
          river ? "开始观察" : "开始识别",
          river ? "查看结果" : "认识花卉",
        ].map((label, index) => (
          <div
            key={label}
            className={(view ? 2 : picture ? 1 : 0) === index ? "current" : ""}
          >
            <span>{index + 1}</span>
            {label}
          </div>
        ))}
      </div>
      {health && !cap.enabled && (
        <Notice>
          {river
            ? "河道观察模型当前未启用，暂不能提交新任务；已保存的观察记录仍可查看。"
            : "花卉识别暂未开放，已保存的识别记录仍可查看。"}
        </Notice>
      )}
      <Notice error>{healthError}</Notice>
      {healthError && (
        <button
          className="btn secondary"
          onClick={() => setHealthTick((x) => x + 1)}
        >
          重新检查模型状态
        </button>
      )}
      <div className={`p-upload-panel ${picture ? "has-image" : ""}`}>
        {picture ? (
          <>
            <div className="p-image-stage">
              <img
                src={picture}
                alt={river ? "本次河道观察照片" : "本次花卉识别照片"}
              />
              {river &&
                view?.boxes.map((box) => (
                  <span
                    key={box.id}
                    className="p-detection-box"
                    style={Object.fromEntries(
                      box.box_style
                        .split(";")
                        .filter(Boolean)
                        .map((pair) => pair.split(":")),
                    )}
                  >
                    <b>{box.id + 1}</b>
                  </span>
                ))}
            </div>
            <div className="p-image-actions">
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                <ImagePlus size={17} />
                重新选择照片
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              className="p-camera"
              onClick={() =>
                user
                  ? input.current?.click()
                  : document
                      .getElementById("observation-login")
                      ?.scrollIntoView({ behavior: "smooth" })
              }
              disabled={busy}
              aria-label={river ? "拍照或选择河道照片" : "拍照或选择花卉照片"}
            >
              <Camera size={38} strokeWidth={1.4} />
              <span>拍照 / 选图</span>
            </button>
          </>
        )}
        {user && (
          <>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={selectFile}
              className="p-visually-hidden"
              aria-label="从相册选择照片"
            />
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={selectFile}
              className="p-visually-hidden"
              aria-label="使用相机拍照"
            />
            <button
              className="p-link-button p-camera-link"
              onClick={() => camera.current?.click()}
              disabled={busy}
            >
              <Camera size={15} />
              使用相机
            </button>
          </>
        )}
      </div>
      <Notice>{privateImage.error}</Notice>
      {!user ? (
        <div id="observation-login">
          <Notice>正在准备访客体验…</Notice>
          <button className="btn secondary" onClick={() => ensureVisitor().catch((e) => setError(errorText(e)))}>重试连接</button>
        </div>
      ) : (
        <>
          {river && origin !== "history" && !task && (
            <details className="card p-association p-details">
              <summary>
                这次观察，发生在哪里
                <span>
                  {waterBodies.find((w) => w.id === waterId)?.name ||
                    "可选关联水体，不填写也能继续"}
                </span>
              </summary>
              <div className="p-form">
                <label>
                  关联水体
                  <select
                    className="input"
                    value={waterId}
                    onChange={(e) => setWaterId(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">不关联水体（可直接上传）</option>
                    {waterBodies.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="p-muted p-small">
                  请核对水体资料和实际位置。示范水体关联仅作个人标签，不核验真实到访。
                </p>
                <p className="p-muted p-small">
                  主动使用模糊位置查找附近候选，不把模糊坐标保存为观察点。需要记录具体位置时，请在地图或地点列表自行选点。
                </p>
                <div className="p-actions">
                  <button
                    className="btn secondary"
                    disabled={busy || locating}
                    onClick={locate}
                  >
                    <MapPin size={16} />
                    {locating ? "正在查找…" : "模糊定位查找候选"}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy || locating}
                    onClick={() => setPicker(true)}
                  >
                    地图 / 地点选点
                  </button>
                </div>
                {location && (
                  <p>
                    本次位置：{locationLabel} · {location.latitude},{" "}
                    {location.longitude}
                  </p>
                )}
                <Notice>{locationNotice}</Notice>
                {nearby && (
                  <div className="p-nearby">
                    <strong>候选：{nearby.water_body_name}</strong>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        if (
                          !waterBodies.some(
                            (w) => w.id === nearby.water_body_id,
                          )
                        )
                          setWaterBodies((ws) => [
                            ...ws,
                            {
                              id: nearby.water_body_id,
                              name: nearby.water_body_name,
                            },
                          ]);
                        setWaterId(nearby.water_body_id);
                        setNearby(null);
                      }}
                    >
                      关联这个候选水体
                    </button>
                  </div>
                )}
                {(location || locationNotice) && (
                  <button
                    className="p-link-button"
                    onClick={() => {
                      locationVersion.current++;
                      setLocation(null);
                      setLocationLabel("");
                      setNearby(null);
                      setLocating(false);
                      setLocationNotice(
                        "本次不保存位置；手选水体关联仍可独立修改。",
                      );
                    }}
                  >
                    本次不保存位置
                  </button>
                )}
              </div>
            </details>
          )}
          {origin !== "history" && !view && (
            <button
              className="btn p-submit-observation"
              onClick={submit}
              disabled={
                busy ||
                locating ||
                !health ||
                !cap.enabled ||
                !file ||
                pending(task)
              }
            >
              <Icon size={19} />
              {busy
                ? "正在上传照片…"
                : pending(task)
                  ? "正在处理这张照片…"
                  : river
                    ? "上传并观察漂浮物"
                    : "开始识别"}
            </button>
          )}
          <Link className="p-privacy-link" to="/legal/privacy">
            <ShieldCheck size={13} />
            隐私与图片保留声明
          </Link>
        </>
      )}
      {!river && (
        <div className="card p-scope-card">
          <h2>当前支持五类花卉，结果供观察参考</h2>
          <p>
            目前只支持以下五类常见花卉的识别。这是一项轻量的图片分类功能，帮你初步认识身边的花草，并非专业植物鉴定。如果拍到五类之外的植物，系统仍可能给出一个“最像”的候选——这属于正常现象，请把结果当作初步参考，并与实物对比确认。
          </p>
          <div className="p-flower-labels">
            {["雏菊类", "郁金香类", "蒲公英类", "蔷薇属", "向日葵类"].map(
              (label) => (
                <span key={label}>
                  <Flower2 size={17} />
                  {label}
                </span>
              ),
            )}
          </div>
          <p className="p-small p-muted">
            识别模型为 {cap.modelName || "flowers-efficientnet-b0"} ·{" "}
            {cap.modelVersion || "v1"}
          </p>
        </div>
      )}
      <Notice error>{error}</Notice>
      {!account && /次数|额度/.test(error) && <Link className="btn secondary" to="/login">登录后继续</Link>}
      {task && !view && (
        <div className="card p-task-status">
          <div>
            <h2>{statusLabel(task.status)}</h2>
            {pending(task) && <RefreshCw className="p-spin" size={20} />}
          </div>
          <p>
            {task.message ||
              task.error_message ||
              (task.status === "queued"
                ? "照片已收到，正在等候处理。"
                : task.status === "running"
                  ? "正在分析图片，请稍候。"
                  : "本次未获得可展示的结果。")}
          </p>
          <small>{time(task.created_at)}</small>
          <button
            className="btn secondary"
            onClick={async () => {
              setError("");
              if (pending(task)) setPollTick((t) => t + 1);
              else await openJob(task.id);
            }}
          >
            <RefreshCw size={15} />
            刷新结果
          </button>
        </div>
      )}
      {view &&
        (river ? (
          <RiverResult task={task} result={view} />
        ) : (
          <FlowerResult result={view} />
        ))}
      {task &&
        (view || (river && ["succeeded", "failed"].includes(task.status))) && (
          <div className="card p-ai-next">
            <div>
              <span className="p-eyebrow">✦ DeepSeek Flash</span>
              <h2>{river ? "一起看看这段河流" : "听听这朵花的故事"}</h2>
              <p>
                {river
                  ? "主动发送问题后，AI 可结合你选择的原图观察可见细节。"
                  : "核对候选特征，了解更多植物知识。原图可由你主动选择附带。"}
              </p>
            </div>
            <div className="p-actions">
              {river && (
                <AIButton
                  context={{
                    scope: "recognition",
                    assessment_job_id: task.id,
                    interpretation_mode: "image",
                    include_image: true,
                  }}
                  label="AI 看图"
                />
              )}
              {view && (
                <AIButton
                  context={{
                    scope: "recognition",
                    ...(river
                      ? { assessment_job_id: task.id }
                      : { recognition_job_id: task.id }),
                    include_image: false,
                  }}
                  label={river ? "解读检测结果" : "问问 AI"}
                />
              )}
            </div>
          </div>
        )}
      {task && (
        <button
          className="p-link-button p-danger-text"
          disabled={busy}
          onClick={() => setConfirm(true)}
        >
          <Trash2 size={15} />
          删除此记录和图片
        </button>
      )}
      {user && (
        <section>
          <SectionTitle title={river ? "最近的河道观察" : "最近的发现"}>
            <Link
              to={account ? "/records/" + (river ? "assessment" : "recognition") : "/login"}
              className="p-link-button"
            >
              {account ? "全部记录" : "登录保存更多记录"}
              <ChevronRight size={16} />
            </Link>
          </SectionTitle>
          {records.rows.slice(0, 5).map((item) => {
            const result =
              item.status === "succeeded"
                ? river
                  ? riverResult(item)
                  : flowerResult(item.result)
                : null;
            return (
              <button
                className="card p-recent-job"
                key={item.id}
                disabled={busy}
                onClick={() => openJob(item.id)}
              >
                <span className="p-record-icon">
                  <Icon size={23} />
                </span>
                <div className="p-grow">
                  <strong>{result?.heading || statusLabel(item.status)}</strong>
                  {item.message && <p>{item.message}</p>}
                  <small>{time(item.created_at)}</small>
                </div>
                <ChevronRight size={18} />
              </button>
            );
          })}
          <CollectionStatus
            collection={{ ...records, next: "" }}
            empty={
              <p className="p-muted">
                {river ? "还没有河道图像观察记录。" : "还没有花卉识别记录。"}
              </p>
            }
          />
        </section>
      )}
      {river && (
        <div className="card p-annotation-example">
          <h2>标注示例</h2>
          <img
            src="/assets/examples/river-annotations.jpg"
            alt="河道标注拼图示例，紫色框标出水面和岸边物体"
            loading="lazy"
          />
          <p>
            紫色框展示水面、岸边物体的标注位置，可见塑料瓶、包装物与植物等。示例仅用于理解框选方式，不能据此判断真实水质。
          </p>
        </div>
      )}
      {confirm && (
        <Confirm
          error={error}
          title="删除观察记录"
          text="删除这条个人记录、关联图片、可选位置和关联的 AI 解读会话，无法恢复。"
          busy={busy}
          onConfirm={remove}
          onClose={() => setConfirm(false)}
        />
      )}
      {picker && (
        <PointPicker
          places={places}
          onClose={() => setPicker(false)}
          onSelect={(point, label) => {
            setPicker(false);
            findNearby(point, false, label);
          }}
        />
      )}
    </div>
  );
}
export function RecognizePage() {
  const [params, setParams] = useSearchParams();
  const river =
    params.get("mode") === "river" || params.get("mode") === "assessment";
  const { user, visitor } = useAuth();
  const [busy, setBusy] = useState(false);
  const onBusy = useCallback((value) => setBusy(value), []);
  return (
    <div className="personal-page p-recognize">
      <PageHeader eyebrow="NATURE OBSERVATION / 自然观察" title="智慧识别" />
      <AIButton floating context={{scope: "recognition"}} />
      <div className="p-observe-tabs">
        <button
          className={!river ? "active" : ""}
          aria-pressed={!river}
          disabled={busy}
          onClick={() => setParams({ mode: "flower" })}
        >
          <Flower2 size={22} />
          花卉识别
        </button>
        <button
          className={river ? "active" : ""}
          aria-pressed={river}
          disabled={busy}
          onClick={() => setParams({ mode: "river" })}
        >
          <Waves size={22} />
          河道观察
        </button>
      </div>
      <ObservationPanel
        key={(river ? "river" : "flower") + (user?.id || visitor?.id || "visitor")}
        river={river}
        requestedId={params.get("jobId") || params.get("job")}
        onBusy={onBusy}
      />
    </div>
  );
}

function recordInfo(record, kind) {
  if (kind === "recognition" || kind === "assessment") {
    const result =
      record.status === "succeeded"
        ? kind === "assessment"
          ? riverResult(record)
          : flowerResult(record.result)
        : null;
    return {
      title:
        result?.heading ||
        (kind === "assessment" ? "河道图像观察" : "花卉识别任务"),
      subtitle: record.message || statusLabel(record.status),
      to:
        "/recognize?mode=" +
        (kind === "assessment" ? "river" : "flower") +
        "&jobId=" +
        encodeURIComponent(record.id),
      date: record.created_at,
    };
  }
  const content = !!(record.content || record.content_id),
    item = content ? record.content : record.place;
  const id =
    (typeof item === "string" ? item : item?.id) ||
    record[content ? "content_id" : "place_id"];
  const unavailable = item === null || !id;
  return {
    title: unavailable
      ? "原资料已删除或下架"
      : item?.title || item?.name || "已保存的资料",
    subtitle: unavailable
      ? "资料已下架，可删除这条记录。"
      : content
        ? "科普文章"
        : "生态地点",
    to: unavailable
      ? ""
      : "/detail/" +
        (content ? "content" : "place") +
        "/" +
        encodeURIComponent(id),
    date: record.visited_at || record.viewed_at || record.created_at,
  };
}
export function RecordsPage() {
  const { kind: rawKind } = useParams();
  const kind =
    { "recognition-jobs": "recognition", "assessment-jobs": "assessment" }[
      rawKind
    ] || rawKind;
  const config = recordTypes[kind];
  return config ? (
    <RecordsContent key={kind} kind={kind} config={config} />
  ) : (
    <div className="personal-page">
      <Empty
        title="记录类型不存在"
        copy="请从个人中心选择需要查看的记录。"
        to="/me"
        action="返回我的"
      />
    </div>
  );
}
function RecordsContent({ kind, config }) {
  const collection = useCollection(config.endpoint);
  const { user, valid } = useIdentity();
  const [selected, setSelected] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setSelected(null);
    setBusy(false);
    setError("");
  }, [user?.id]);
  async function remove() {
    const owner = user.id;
    setBusy(true);
    setError("");
    try {
      await api(config.endpoint + encodeURIComponent(selected.id) + "/", {
        method: "DELETE",
      });
      if (valid(owner)) {
        setSelected(null);
        await collection.load();
      }
    } catch (e) {
      if (valid(owner)) setError(errorText(e));
    } finally {
      if (valid(owner)) setBusy(false);
    }
  }
  return (
    <div className="personal-page">
      <PageHeader eyebrow="PRIVATE JOURNAL / 我的手记" title={config.title}>
        <PrivateTag />
      </PageHeader>
      {!user ? (
        <AuthGate />
      ) : (
        <>
          <div className="p-list-toolbar">
            <span>
              {collection.rows.length
                ? `已加载 ${collection.rows.length} 条记录`
                : "收藏与发现，都在这里"}
            </span>
            <button
              className="p-link-button"
              disabled={busy || collection.loading}
              onClick={() => collection.load()}
            >
              <RefreshCw size={16} />
              刷新
            </button>
          </div>
          <Notice error>{error}</Notice>
          <div className="p-records-list">
            {collection.rows.map((record) => {
              const info = recordInfo(record, kind);
              return (
                <article key={record.id} className="card p-record-card">
                  <div className="p-record-main">
                    <span className="p-record-icon">
                      <config.Icon size={23} />
                    </span>
                    <div className="p-grow">
                      {info.to ? (
                        <Link to={info.to}>
                          <h2>{info.title}</h2>
                          <p>{info.subtitle}</p>
                        </Link>
                      ) : (
                        <>
                          <h2>{info.title}</h2>
                          <p>{info.subtitle}</p>
                        </>
                      )}
                    </div>
                    {info.to && (
                      <Link to={info.to} aria-label={"查看" + info.title}>
                        <ChevronRight size={20} />
                      </Link>
                    )}
                  </div>
                  <footer>
                    <small>{time(info.date)}</small>
                    <button
                      className="p-link-button p-danger-text"
                      onClick={() => setSelected(record)}
                      disabled={busy}
                    >
                      <Trash2 size={14} />
                      {kind === "favorites" ? "取消收藏" : "删除"}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
          <CollectionStatus
            collection={collection}
            empty={
              <Empty
                Icon={config.Icon}
                title={config.heading}
                copy={config.copy}
                to={config.to}
                action={config.action}
              />
            }
          />
          {kind === "visits" && (
            <Notice>
              游览记录由你主动添加，不代表经过定位核验的真实到访。
            </Notice>
          )}
          {kind === "histories" && (
            <p className="p-muted p-small">
              可在<Link to="/me">隐私与账号设置</Link>中关闭新增浏览记录。
            </p>
          )}
        </>
      )}
      {selected && (
        <Confirm
          error={error}
          title={kind === "favorites" ? "取消这条收藏" : "删除这条记录"}
          text={
            ["recognition", "assessment"].includes(kind)
              ? "删除任务、关联图片、可选位置及关联的 AI 解读会话，无法恢复。"
              : "删除后，这条个人记录将不再显示。"
          }
          onClose={() => setSelected(null)}
          onConfirm={remove}
          busy={busy}
        />
      )}
    </div>
  );
}
export function FeedbackPage() {
  const { user } = useAuth();
  return (
    <div className="personal-page">
      <PageHeader eyebrow="FEEDBACK / 意见与反馈" title="意见与反馈" />
      {user ? (
        <FeedbackContent key={user.id} />
      ) : (
        <AuthGate>登录后可提交反馈，并查看属于自己的处理进度与答复。</AuthGate>
      )}
    </div>
  );
}
function FeedbackContent() {
  const collection = useCollection("feedback/");
  const { user, valid } = useIdentity();
  const [body, setBody] = useState(""),
    [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState(null);
  const textarea = useRef(null);
  async function save(event) {
    event.preventDefault();
    const text = body.trim(),
      owner = user.id;
    if (!text || [...text].length > 1000) {
      setError("请填写 1 至 1000 字的反馈内容。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("feedback/" + (editing ? editing.id + "/" : ""), {
        method: editing ? "PATCH" : "POST",
        data: { body: text },
      });
      if (valid(owner)) {
        setBody("");
        setEditing(null);
        setNotice(
          editing
            ? "反馈已更新，可在下方查看。"
            : "反馈已提交，可在下方查看处理进度与答复。",
        );
        await collection.load();
      }
    } catch (e) {
      if (valid(owner))
        setError(errorText(e) + " 如提交结果未确认，请先刷新记录核对。");
    } finally {
      if (valid(owner)) setBusy(false);
    }
  }
  async function remove() {
    const owner = user.id;
    setBusy(true);
    try {
      await api("feedback/" + selected.id + "/", { method: "DELETE" });
      if (valid(owner)) {
        if (editing?.id === selected.id) {
          setEditing(null);
          setBody("");
        }
        setSelected(null);
        setNotice("反馈及答复已删除。");
        await collection.load();
      }
    } catch (e) {
      if (valid(owner)) setError(errorText(e));
    } finally {
      if (valid(owner)) setBusy(false);
    }
  }
  return (
    <>
      <form onSubmit={save} className="card p-form p-feedback-form">
        <div className="p-section-title">
          <h2>{editing ? "编辑反馈" : "写下你的反馈"}</h2>
          <PrivateTag />
        </div>
        <label>
          反馈内容
          <textarea
            ref={textarea}
            className="input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            rows={6}
            placeholder="描述发生的问题、所在页面或你的建议…"
            required
            disabled={busy}
          />
        </label>
        <div className="p-form-footer">
          <span>{[...body].length} / 1000</span>
          <p>请勿填写密码、身份证件、住址等敏感资料。</p>
        </div>
        <Notice error>{error}</Notice>
        <Notice>{notice}</Notice>
        <div className="p-actions">
          <button className="btn" disabled={busy}>
            <Send size={16} />
            {busy ? "正在保存…" : editing ? "保存修改" : "提交反馈"}
          </button>
          {editing && (
            <button
              className="btn secondary"
              type="button"
              onClick={() => {
                setEditing(null);
                setBody("");
              }}
              disabled={busy}
            >
              取消编辑
            </button>
          )}
        </div>
      </form>
      <SectionTitle title="我的反馈">
        <button
          className="p-link-button"
          onClick={() => collection.load()}
          disabled={busy || collection.loading}
        >
          <RefreshCw size={16} />
          刷新记录
        </button>
      </SectionTitle>
      <div className="p-feedback-list">
        {collection.rows.map((row) => (
          <article className="card" key={row.id}>
            <div className="p-section-title">
              <span className="p-chip">
                {row.status === "resolved" ? "已处理" : "待处理"}
              </span>
              <small>{time(row.created_at)}</small>
            </div>
            <p className="p-preserve">{row.body}</p>
            {row.status === "resolved" && (
              <div className="p-reply">
                <strong>平台答复</strong>
                <p className="p-preserve">{row.reply || "这条反馈已处理。"}</p>
                {row.resolved_at && <small>{time(row.resolved_at)}</small>}
              </div>
            )}
            <div className="p-actions p-right">
              {row.status !== "resolved" && (
                <button
                  className="p-link-button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(row);
                    setBody(row.body);
                    setError("");
                    setNotice("");
                    textarea.current?.focus();
                    textarea.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    });
                  }}
                >
                  <Pencil size={14} />
                  编辑
                </button>
              )}
              <button
                className="p-link-button p-danger-text"
                disabled={busy}
                onClick={() => setSelected(row)}
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      <CollectionStatus
        collection={collection}
        empty={
          <Empty
            Icon={MessageCircle}
            title="还没有反馈"
            copy="你提交的意见、处理进度和答复会保存在这里。"
          />
        }
      />
      {selected && (
        <Confirm
          error={error}
          title="删除这条反馈"
          text="反馈内容及对应答复将删除，无法恢复。"
          onClose={() => setSelected(null)}
          onConfirm={remove}
          busy={busy}
        />
      )}
    </>
  );
}
export function SubmissionsPage() {
  const { user } = useAuth();
  return (
    <div className="personal-page">
      <PageHeader eyebrow="FIELD NOTES / 资料反馈" title="我的资料反馈">
        <p>原始反馈保持私密。公开科普由编辑核实整理，文章不开放评论。</p>
      </PageHeader>
      {user ? (
        <SubmissionsContent key={user.id} />
      ) : (
        <AuthGate>登录后保存私人草稿、向编辑反馈资料并查看处理进度。</AuthGate>
      )}
    </div>
  );
}
function SubmissionsContent() {
  const collection = useCollection("community/submissions/");
  const { user, valid } = useIdentity();
  const [status, setStatus] = useState(null),
    [statusError, setStatusError] = useState(""),
    [editor, setEditor] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState("");
  const saveRequest = useRef(null),
    submitRequest = useRef(null),
    editorRef = useRef(null);
  const enabled = status?.submissions_enabled === true,
    editable = isEditableDraft(editor);
  const loadStatus = useCallback(async () => {
    const owner = user.id;
    try {
      const result = await api("community/status/");
      if (valid(owner)) {
        setStatus(result.data);
        setStatusError("");
      }
    } catch (e) {
      if (valid(owner)) setStatusError(errorText(e));
    }
  }, [user.id]);
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);
  async function operation(work) {
    if (busy) return;
    const owner = user.id;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      return valid(owner) ? result : null;
    } catch (e) {
      if (valid(owner)) {
        setError(errorText(e));
        if (e.code === "COMMUNITY_DISABLED")
          setStatus((s) => ({ ...s, submissions_enabled: false }));
      }
      return null;
    } finally {
      if (valid(owner)) setBusy(false);
    }
  }
  function update(row, message) {
    setEditor(row);
    setNotice(message);
    collection.load();
  }
  async function save(event) {
    event?.preventDefault();
    if (!editable) return;
    const payload = {
      title: editor.title.trim(),
      body: editor.body.trim(),
      source: editor.source.trim(),
      category: editor.category,
    };
    if (
      [...payload.title].length > 80 ||
      [...payload.body].length > 2000 ||
      [...payload.source].length > 300
    ) {
      setError("标题最多80字，正文最多2000字，来源最多300字。");
      return;
    }
    const fingerprint = JSON.stringify(payload);
    if (!editor.id && saveRequest.current?.fingerprint !== fingerprint)
      saveRequest.current = { fingerprint, id: crypto.randomUUID() };
    const response = await operation(() =>
      api("community/submissions/" + (editor.id ? editor.id + "/" : ""), {
        method: editor.id ? "PATCH" : "POST",
        data: {
          ...payload,
          ...(editor.id
            ? { expected_version: editor.version }
            : { request_id: saveRequest.current.id }),
        },
      }),
    );
    if (response) {
      update(response.data, "私人草稿已保存。");
      saveRequest.current = null;
      submitRequest.current = null;
    }
  }
  async function submit() {
    if (!enabled || !editor?.id || !editable) return;
    const saved = collection.rows.find((r) => r.id === editor.id);
    if (
      !saved ||
      ["title", "body", "source", "category"].some(
        (key) => editor[key] !== saved[key],
      )
    ) {
      setError("请先保存当前修改，再提交给编辑。");
      return;
    }
    if (!editor.title.trim() || !editor.body.trim()) {
      setError("请填写标题和正文并先保存草稿。");
      return;
    }
    const fingerprint = editor.id + ":" + editor.version;
    if (submitRequest.current?.fingerprint !== fingerprint)
      submitRequest.current = { fingerprint, id: crypto.randomUUID() };
    const response = await operation(() =>
      api("community/submissions/" + editor.id + "/submit/", {
        method: "POST",
        data: {
          expected_version: editor.version,
          request_id: submitRequest.current.id,
        },
      }),
    );
    if (response) {
      update(
        response.data,
        response.data.status === "pending"
          ? "已提交给编辑核实；原始反馈不会公开。"
          : ["checking", "reviewing"].includes(response.data.status)
            ? "内容检查中，请稍后刷新核对。"
            : response.data.review_reason || "内容检查未通过。",
      );
      submitRequest.current = null;
    }
  }
  async function open(row) {
    const response = await operation(() =>
      api("community/submissions/" + row.id + "/"),
    );
    if (response) {
      setEditor(response.data);
      saveRequest.current = null;
      submitRequest.current = null;
      setTimeout(
        () =>
          editorRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          }),
        0,
      );
    }
  }
  async function action() {
    const remove = confirm === "delete";
    const response = await operation(() =>
      api(
        "community/submissions/" +
          editor.id +
          "/" +
          (remove ? "" : "withdraw/"),
        {
          method: remove ? "DELETE" : "POST",
          data: { expected_version: editor.version },
        },
      ),
    );
    if (response) {
      setConfirm("");
      setEditor(null);
      collection.load();
      setNotice(remove ? "资料反馈已删除。" : "资料反馈已撤回。");
    }
  }
  return (
    <>
      {!enabled && (
        <Notice>
          {status?.reason || "资料反馈尚未开放，私人草稿可以保存。"}
        </Notice>
      )}
      <Notice error>{statusError}</Notice>
      <div className="p-actions p-list-toolbar">
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setEditor(emptyDraft());
            setError("");
            setNotice("");
            saveRequest.current = null;
            submitRequest.current = null;
          }}
        >
          <FilePenLine size={17} />
          写资料反馈
        </button>
        <button
          className="btn secondary"
          disabled={busy}
          onClick={() => {
            collection.load();
            loadStatus();
          }}
        >
          <RefreshCw size={16} />
          刷新记录
        </button>
      </div>
      <Notice error>{error}</Notice>
      <Notice>{notice}</Notice>
      {editor && (
        <section className="card p-draft-editor" ref={editorRef}>
          <div className="p-section-title">
            <span className="p-chip">
              {submissionStatuses[editor.status] || "私人草稿"}
            </span>
            <button
              className="p-link-button"
              onClick={() => setEditor(null)}
              disabled={busy}
            >
              <X size={16} />
              收起
            </button>
          </div>
          {editable ? (
            <form className="p-form" onSubmit={save}>
              <label>
                标题
                <input
                  className="input"
                  value={editor.title}
                  maxLength={80}
                  placeholder="标题（80字以内）"
                  disabled={busy}
                  onChange={(e) =>
                    setEditor((s) => ({ ...s, title: e.target.value }))
                  }
                />
              </label>
              <label>
                分类
                <select
                  className="input"
                  disabled={busy}
                  value={editor.category}
                  onChange={(e) =>
                    setEditor((s) => ({ ...s, category: e.target.value }))
                  }
                >
                  {categories.map((c) => (
                    <option value={c.value} key={c.value}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                资料正文
                <textarea
                  className="input"
                  value={editor.body}
                  maxLength={2000}
                  rows={9}
                  placeholder="补充线索、纠错或自然观察（2000字以内）"
                  disabled={busy}
                  onChange={(e) =>
                    setEditor((s) => ({ ...s, body: e.target.value }))
                  }
                />
                <small>{[...editor.body].length} / 2000</small>
              </label>
              <label>
                参考来源（选填）
                <textarea
                  className="input"
                  value={editor.source}
                  maxLength={300}
                  rows={2}
                  placeholder="资料出处、链接或观察时间（300字以内）"
                  disabled={busy}
                  onChange={(e) =>
                    setEditor((s) => ({ ...s, source: e.target.value }))
                  }
                />
              </label>
              <div className="p-actions">
                <button className="btn" disabled={busy}>
                  {busy ? "正在保存…" : "保存私人草稿"}
                </button>
                {enabled && editor.id && (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy || collection.loading}
                    onClick={submit}
                  >
                    提交给编辑
                  </button>
                )}
              </div>
            </form>
          ) : (
            <>
              <h2>{editor.title}</h2>
              <p className="p-preserve">{editor.body}</p>
              {editor.source && (
                <p className="p-preserve p-muted">来源：{editor.source}</p>
              )}
            </>
          )}
          <Notice>{editor.review_reason}</Notice>
          <p className="p-small p-muted">
            原始反馈仅你和获授权编辑可见，永不直接公开。只有完成内容安全检查与编辑核实后，才可能整理成官方文章；尚未开放时仅保存私人草稿。请勿填写姓名、联系方式等隐私。
          </p>
          {editor.id && (
            <div className="p-actions">
              {["pending", "checking", "reviewing", "approved"].includes(
                editor.status,
              ) && (
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => setConfirm("withdraw")}
                >
                  撤回反馈
                </button>
              )}
              <button
                className="p-link-button p-danger-text"
                disabled={busy}
                onClick={() => setConfirm("delete")}
              >
                <Trash2 size={14} />
                删除反馈
              </button>
            </div>
          )}
        </section>
      )}
      <SectionTitle title="我的资料反馈">
        <PrivateTag />
      </SectionTitle>
      <div className="p-drafts-list">
        {collection.rows.map((row) => (
          <button
            className="card p-draft-row"
            key={row.id}
            onClick={() => open(row)}
            disabled={busy}
          >
            <div className="p-record-icon">
              <FilePenLine size={24} />
            </div>
            <div className="p-grow">
              <h3>{row.title || "未命名草稿"}</h3>
              <span className="p-chip">
                {submissionStatuses[row.status] || row.status}
              </span>
            </div>
            <small>{time(row.updated_at || row.created_at)}</small>
            <ChevronRight size={18} />
          </button>
        ))}
      </div>
      <CollectionStatus
        collection={collection}
        empty={
          <Empty
            Icon={FilePenLine}
            title="见闻，从一份草稿开始"
            copy="还没有资料反馈，可以先保存一份私人草稿。"
          />
        }
      />
      {confirm && (
        <Confirm
          error={error}
          confirmLabel={confirm === "delete" ? "确认删除" : "确认撤回"}
          title={confirm === "delete" ? "删除这份反馈？" : "撤回这份反馈？"}
          text={
            confirm === "delete"
              ? "删除后无法恢复；由这份反馈形成的官方文章会一并撤下。"
              : "撤回后可修改并重新提交；关联官方文章会撤下。"
          }
          onClose={() => setConfirm("")}
          onConfirm={action}
          busy={busy}
        />
      )}
    </>
  );
}
export function LLMHistoryPage() {
  const { user } = useAuth();
  return (
    <div className="personal-page">
      <PageHeader eyebrow="CONVERSATION NOTES / 对话手记" title="AI 对话记录">
        <PrivateTag />
      </PageHeader>
      {user ? (
        <ConversationsContent key={user.id} />
      ) : (
        <AuthGate>
          登录后查看自己的 AI 对话。记录仅本人可见，可随时删除。
        </AuthGate>
      )}
    </div>
  );
}
function ConversationsContent() {
  const collection = useCollection("llm/sessions/");
  const { user, valid } = useIdentity();
  const [status, setStatus] = useState(null),
    [statusError, setStatusError] = useState(""),
    [selected, setSelected] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api("llm/status/")
      .then((r) => {
        if (alive) setStatus(r.data);
      })
      .catch((e) => {
        if (alive) setStatusError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  async function remove() {
    const owner = user.id;
    setBusy(true);
    setError("");
    try {
      await api("llm/sessions/" + selected.id + "/", { method: "DELETE" });
      if (valid(owner)) {
        setSelected(null);
        await collection.load();
      }
    } catch (e) {
      if (valid(owner)) setError(errorText(e));
    } finally {
      if (valid(owner)) setBusy(false);
    }
  }
  const labels = {
    recognition: "花卉识别",
    assessment: "河道观察",
    explore: "生态导览",
    learn: "科普智游",
  };
  return (
    <>
      {status && !status.enabled && (
        <Notice>AI 暂未开放。当前不能发送新问题，已有会话仍可查看。</Notice>
      )}
      <Notice error>{statusError && "服务状态暂不可用：" + statusError}</Notice>
      <Notice error>{error}</Notice>
      <div className="p-list-toolbar">
        <span>AI 对话记录</span>
        <button
          className="p-link-button"
          disabled={collection.loading || busy}
          onClick={() => collection.load()}
        >
          <RefreshCw size={16} />
          刷新记录
        </button>
      </div>
      <div className="p-conversation-list">
        {collection.rows.map((session) => (
          <article className="card p-session-card" key={session.id}>
            <div className="p-record-main">
              <span className="p-record-icon">
                <MessageCircle size={24} />
              </span>
              <div className="p-grow">
                <span className="p-chip">
                  {session.interpretation_mode === "image"
                    ? "河道 AI 看图"
                    : labels[session.kind] || "AI 对话"}
                </span>
                <h2>{session.title}</h2>
                <small>{time(session.updated_at || session.created_at)}</small>
              </div>
              <AIButton context={{ sessionId: session.id }} label="查看对话" />
            </div>
            {["recognition", "assessment"].includes(session.kind) && (
              <p className="p-small p-muted">
                {session.interpretation_mode === "image"
                  ? session.image_available
                    ? "河道原图看图"
                    : "原图已不可用，已有对话可查看"
                  : session.include_image
                    ? session.image_available
                      ? "附图解读"
                      : "原图已不可用，可继续文字对话"
                    : "文字结果解读"}
              </p>
            )}
            <footer>
              <small>保留至 {time(session.expires_at)}</small>
              <button
                className="p-link-button p-danger-text"
                disabled={busy}
                onClick={() => setSelected(session)}
              >
                <Trash2 size={14} />
                删除
              </button>
            </footer>
          </article>
        ))}
      </div>
      <CollectionStatus
        collection={collection}
        empty={
          <Empty
            Icon={MessageCircle}
            title="还没有 AI 对话"
            copy="去识别一朵花，或从喜欢的科普文章开始。"
            to="/recognize"
            action="开启一次发现"
          />
        }
      />
      {selected && (
        <Confirm
          error={error}
          title="删除 AI 对话"
          text="删除平台保存的这段对话，不影响原始资料或识别任务。已提交给 DeepSeek 的请求不会因此撤回。"
          busy={busy}
          onClose={() => setSelected(null)}
          onConfirm={remove}
        />
      )}
    </>
  );
}

const privacySections = siteLegal.privacy, termsSections = siteLegal.terms;
export function LegalPage() {
  const { kind } = useParams();
  const [site, setSite] = useState(null);
  useEffect(() => { api("web/site-info/").then(r => setSite(r.data)).catch(() => {}); }, []);
  const privacy = !["terms", "agreement"].includes(kind);
  return (
    <div className="personal-page p-legal">
      <PageHeader
        eyebrow="YOUR INFORMATION, YOUR CHOICE / 由你选择"
        title={privacy ? "隐私说明" : "用户协议"}
      >
        <p>网页版本 · 更新日期：2026 年 10 月 8 日</p>
      </PageHeader>
      {site && (site.operator || site.contact_email || site.icp) && <div className="card"><strong>{site.operator}</strong>{site.contact_email && <p>联系邮箱：<a href={"mailto:" + site.contact_email}>{site.contact_email}</a></p>}{site.icp && <p>{site.icp}</p>}</div>}
      <div className="p-tabs p-legal-tabs">
        <Link className={privacy ? "active" : ""} to="/legal/privacy">
          隐私说明
        </Link>
        <Link className={!privacy ? "active" : ""} to="/legal/terms">
          用户协议
        </Link>
      </div>
      <div className="p-legal-summary">
        <ShieldCheck size={31} strokeWidth={1.4} />
        <div>
          <h2>{privacy ? "你的信息，由你选择" : "一起认识身边的自然"}</h2>
          <p>
            {privacy
              ? "公开资料可直接浏览。上传图片、设置资料和使用定位，都由你主动操作；个人记录可在“我的”管理。"
              : "从一份公开资料，到一次自己的观察。请在了解服务范围后，选择适合你的使用方式。"}
          </p>
        </div>
      </div>
      <div className="p-legal-sections">
        {(privacy ? privacySections : termsSections).map(
          ([title, paragraphs], index) => (
            <section className="card" key={title}>
              <span className="p-legal-number">0{index + 1}</span>
              <div>
                <h2>{title}</h2>
                {paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </section>
          ),
        )}
      </div>
      <div className="card p-legal-help">
        <h2>有疑问或个人信息相关需求？</h2>
        <p>可通过反馈说明你的问题，登录后查看处理进度与答复。</p>
        <Link className="btn secondary" to="/feedback">
          前往我的反馈
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}
