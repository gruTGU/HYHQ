import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Home,
  MapPin,
  Camera,
  BookOpen,
  UserRound,
  ArrowUpRight,
  ShieldCheck,
  Leaf,
  ChevronRight,
} from "lucide-react";
import { Providers, useAuth, useTheme, THEMES } from "./state";
import { api } from "./lib/api";
import AIChat from "./AIChat";
import PrivacyControls from "./PrivacyControls";
import NotificationButton from "./NotificationButton";
import { BlogPostPage, BlogEditorPage, MyBlogPage, BlogModerationPage } from "./pages/BlogPages";
import { State } from "./components";
import { HomePage, WeatherPage, NotificationsPage } from "./pages/HomeWeather";
import {
  ExplorePage,
  LearnPage,
  DetailPage,
  DataCenterPage,
  WaterPage,
} from "./pages/PublicPages";
import {
  ProfilePage,
  RecognizePage,
  RecordsPage,
  FeedbackPage,
  SubmissionsPage,
  ThemesPage,
  LLMHistoryPage,
  LegalPage,
} from "./pages/PersonalPages";
import AdminPage from "./pages/AdminPage";
import "./styles.css";
import "./DarkTheme.css";
const nav = [
  ["/", "首页", Home],
  ["/explore", "生态导览", MapPin],
  ["/recognize", "智慧识别", Camera],
  ["/learn", "科普智游", BookOpen],
  ["/me", "我的", UserRound],
];
class Boundary extends React.Component {
  constructor(p) {
    super(p);
    this.state = { error: false };
  }
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="state card">
        <h2>页面暂时没有打开</h2>
        <p>数据已保留，可刷新页面重试。</p>
        <button className="btn" onClick={() => location.reload()}>
          重新打开
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function WaterIndex() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  useEffect(() => {
    api("water-bodies/", { data: { page_size: 1 } })
      .then((r) => {
        if (r.data[0]) navigate("/water/" + r.data[0].id, { replace: true });
        else setError("当前还没有河湖资料。");
      })
      .catch((e) => setError(e.message));
  }, []);
  return <div className="state card">{error || "正在打开河湖资料…"}</div>;
}
function Shell() {
  const { user, loading } = useAuth(),
    { theme } = useTheme(),
    loc = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);
  const [siteInfo, setSiteInfo] = useState({});
  useEffect(() => { let alive = true; api("web/site-info/").then(r => { if (alive) setSiteInfo(r.data || {}); }).catch(() => {}); return () => { alive = false; }; }, []);
  const current =
    nav.find(([path]) => path !== "/" && loc.pathname.startsWith(path)) ||
    (loc.pathname.startsWith("/detail/place/")
      ? nav[1]
      : (loc.pathname.startsWith("/detail/") || loc.pathname.startsWith("/blog/"))
        ? nav[3]
        : /^\/(login|records|feedback|submissions|themes|conversations|legal|admin|notifications)(\/|$)/.test(
              loc.pathname,
            )
          ? nav[4]
          : nav[0]);
  return (
    <>
      <aside className="sidebar">
        <Link to="/" className="brand">
          <img src="/assets/brand/hyhq-logo.jpg" alt="海晏河清" />
          <span>
            <strong>海晏河清</strong>
            <small>HYHQ · 智慧平台</small>
          </span>
        </Link>
        <div className="sidebar-divider" />
        <nav className="primary-nav" aria-label="主导航">
          {nav.map(([path, name, Icon], i) => (
            <NavLink
              end={path === "/"}
              to={path}
              key={path}
              className={({ isActive }) =>
                (isActive || current[0] === path ? "active " : "") +
                (i === 2 ? "recognition-nav" : "")
              }
            >
              <span className="nav-icon">
                <Icon size={21} strokeWidth={1.6} />
              </span>
              <span>{name}</span>
              <ChevronRight className="nav-chevron" size={14} />
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link to="/themes" className="theme-shortcut">
            <span className="theme-dot" />
            <span>
              {THEMES.find((item) => item.id === theme)?.name || "森系自然"}
            </span>
            <ArrowUpRight size={15} />
          </Link>
          {user?.role === "admin" && (
            <Link className="management-shortcut" to="/admin">
              <ShieldCheck size={16} />
              管理工作台
            </Link>
          )}
          <Link to="/me" className="sidebar-account">
            <span className="account-avatar">
              {user?.avatar_url ? (
                <img src={user.avatar_url} alt="" />
              ) : (
                <UserRound size={21} />
              )}
            </span>
            <span>
              <strong>
                {loading ? "海晏河清" : user?.nickname || "登录 / 注册"}
              </strong>
              <small>{user ? "我的自然记录" : "开启你的自然手记"}</small>
            </span>
          </Link>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar topbar-account-only">
          <div className="topbar-right">
            <NotificationButton desktop />
            <Link className="top-account" to="/me">
              {user?.nickname || "我的主页"}
              <UserRound size={17} />
            </Link>
          </div>
        </header>
        <div className="page-wrap">
          <Boundary key={loc.pathname}>
            {loading &&
            /^\/(me|login|records|feedback|submissions|conversations|admin|notifications|blog\/(write|mine))(\/|$)/.test(
              loc.pathname,
            ) ? (
              <State loading />
            ) : (
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/weather" element={<WeatherPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
                <Route path="/explore" element={<ExplorePage />} />
                <Route path="/learn" element={<LearnPage />} />
                <Route path="/blog/write" element={<BlogEditorPage />} />
                <Route path="/blog/write/:id" element={<BlogEditorPage />} />
                <Route path="/blog/mine" element={<MyBlogPage />} />
                <Route path="/blog/:id" element={<BlogPostPage />} />
                <Route path="/admin/blog" element={<BlogModerationPage />} />
                <Route path="/detail/:kind/:id" element={<DetailPage />} />
                <Route path="/data-center" element={<DataCenterPage />} />
                <Route path="/water" element={<WaterIndex />} />
                <Route path="/water/:id" element={<WaterPage />} />
                <Route path="/recognize" element={<RecognizePage />} />
                <Route path="/me" element={<ProfilePage />} />
                <Route path="/login" element={<ProfilePage />} />
                <Route path="/records/:kind" element={<RecordsPage />} />
                <Route path="/feedback" element={<FeedbackPage />} />
                <Route path="/submissions" element={<SubmissionsPage />} />
                <Route path="/themes" element={<ThemesPage />} />
                <Route path="/conversations" element={<LLMHistoryPage />} />
                <Route path="/legal/:kind" element={<LegalPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route
                  path="*"
                  element={
                    <div className="state card">
                      <Leaf />
                      <h2>这个页面暂时不存在</h2>
                      <Link to="/" className="btn">
                        返回首页
                      </Link>
                    </div>
                  }
                />
              </Routes>
            )}
          </Boundary>
        </div>
        <footer className="site-footer">
          <PrivacyControls />
          <span>海晏河清 · HYHQ</span>
          {siteInfo.icp && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{siteInfo.icp}</a>}
          {siteInfo.contact_email && <a href={"mailto:" + siteInfo.contact_email}>联系运营者</a>}
          <span>
            <Link to="/legal/terms">用户协议</Link>
            <Link to="/legal/privacy">隐私政策</Link>
          </span>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="底部导航">
        {nav.map(([path, name, Icon], i) => (
          <NavLink
            end={path === "/"}
            key={path}
            to={path}
            className={({ isActive }) =>
              (isActive || current[0] === path ? "active " : "") +
              (i === 2 ? "center-nav" : "")
            }
          >
            <span>
              <Icon size={i === 2 ? 27 : 22} strokeWidth={1.7} />
            </span>
            <small>{name}</small>
          </NavLink>
        ))}
      </nav>
      <AIChat />
    </>
  );
}
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <Providers>
      <Shell />
    </Providers>
  </BrowserRouter>,
);
