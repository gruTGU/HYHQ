import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowRight,
  LocateFixed,
  CloudSun,
  Sun,
  CloudRain,
  Moon,
  Cloud,
  CloudMoon,
  CloudMoonRain,
  CloudSnow,
  CloudLightning,
  CloudFog,
  Wind,
  Droplets,
  Bell,
  ChevronDown,
  Flower2,
  Compass,
  BookOpen,
  Waves,
  BarChart3,
  Leaf,
  AlertTriangle,
  Sparkles,
  X,
  Check,
} from "lucide-react";
import { api } from "../lib/api";
import {
  createWeatherCache,
  summaryView,
  weatherSection,
  validDailyDays,
  validBookingDraft,
  celsius,
  nearestWeatherCity,
} from "./weather-domain.js";
import { loadAll } from "./public-domain.js";
import { useAuth, useTheme, useToast } from "../state";
import { Markdown, Modal, PageHeader, State, AIButton } from "../components";
import SimulationJournal from "./SimulationJournal";
import NotificationButton, { notifyNotificationsChanged } from "../NotificationButton";
import "./HomePage.css";
import { weatherAppearance } from "./weather-appearance";
import { preferenceStorage } from "../lib/privacy";
const CITIES = [
  ["tianjin", "天津", 39.09, 117.2],
  ["beijing", "北京", 39.9, 116.41],
];
const WEATHER_ICONS = {
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  "cloud-sun": CloudSun,
  "cloud-moon": CloudMoon,
  "cloud-rain": CloudRain,
  "cloud-moon-rain": CloudMoonRain,
  "cloud-snow": CloudSnow,
  "cloud-lightning": CloudLightning,
  "cloud-fog": CloudFog,
};
const int = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : "—";
const day = (v) =>
  new Date((v || Date.now()) + 8 * 3600000).toISOString().slice(0, 10);
const windMap = {
  N: "北风",
  NNE: "东北偏北风",
  NE: "东北风",
  ENE: "东北偏东风",
  E: "东风",
  ESE: "东南偏东风",
  SE: "东南风",
  SSE: "东南偏南风",
  S: "南风",
  SSW: "西南偏南风",
  SW: "西南风",
  WSW: "西南偏西风",
  W: "西风",
  WNW: "西北偏西风",
  NW: "西北风",
  NNW: "西北偏北风",
  CALM: "静风",
};
const wind = (v) => windMap[String(v || "").toUpperCase()] || v || "";
const formatDate = (s) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(s + "T12:00:00+08:00"));
const formatTime = (s) =>
  Number.isFinite(Date.parse(s))
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(s))
    : "—";
const browserStorage = {
  getItem(key) {
    try {
      return key === "hyhq.weather.city" ? preferenceStorage.getItem(key) : localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      if (key === "hyhq.weather.city") preferenceStorage.setItem(key, value);
      else localStorage.setItem(key, value);
    } catch {}
  },
};
function selectedCity() {
  const v = browserStorage.getItem("hyhq.weather.city");
  return CITIES.some((c) => c[0] === v) ? v : "tianjin";
}
const weatherCache = createWeatherCache({
  storage: browserStorage,
  scope: window.location.origin + "/api/v1",
  fetcher: async (mode, city) =>
    (
      await api(
        mode === "forecast"
          ? "weather-data/" + encodeURIComponent(city) + "/forecast/"
          : "weather-data/summary/?location=" + encodeURIComponent(city),
      )
    ).data,
});
function useMinuteClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => {
      if (!document.hidden) setNow(Date.now());
    };
    const timer = setInterval(update, 60000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, []);
  return now;
}
function useIdentityScope(id) {
  const state = useRef({ id: id || null, version: 0, alive: true });
  if (state.current.id !== (id || null))
    state.current = {
      id: id || null,
      version: state.current.version + 1,
      alive: true,
    };
  useEffect(() => {
    state.current.alive = true;
    return () => {
      state.current = {
        ...state.current,
        alive: false,
        version: state.current.version + 1,
      };
    };
  }, []);
  return {
    capture: () => ({ ...state.current }),
    valid: (ticket) =>
      state.current.alive &&
      ticket.id === state.current.id &&
      ticket.version === state.current.version,
  };
}
export function Source({ data }) {
  const [expanded, setExpanded] = useState(false);
  const attributions = [
    ...new Set(
      Object.values(data || {})
        .flatMap((x) => (Array.isArray(x?.attributions) ? x.attributions : []))
        .filter((x) => typeof x === "string"),
    ),
  ];
  return (
    <div className="weather-source">
      <a href="https://www.qweather.com/" target="_blank" rel="noreferrer">
        和风天气 · 数据来源
      </a>
      <button onClick={() => setExpanded(!expanded)}>
        来源说明 <ChevronDown size={11} />
      </button>
      {expanded && (
        <div className="source-details">
          {attributions.length ? (
            attributions.map((s, i) => <Markdown key={i} text={s} />)
          ) : (
            <a
              href="https://developer.qweather.com/attribution.html"
              target="_blank"
              rel="noreferrer"
            >
              查看数据来源与署名说明
            </a>
          )}
        </div>
      )}
    </div>
  );
}
function CitySelect({ value, onChange, locating, setLocating, setNote }) {
  const gen = useRef(0);
  useEffect(
    () => () => {
      gen.current++;
    },
    [],
  );
  useEffect(() => {
    gen.current++;
    setLocating(false);
  }, [value]);
  function locate() {
    const id = ++gen.current;
    setLocating(true);
    setNote("");
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        if (gen.current !== id) return;
        const nearest = nearestWeatherCity(p.coords, CITIES);
        if (nearest) onChange(nearest[0]);
        else setNote("当前位置附近暂无支持的天气城市，可手动选择城市。");
        setLocating(false);
      },
      () => {
        if (gen.current !== id) return;
        setLocating(false);
        setNote("暂时无法获得位置，可手动选择城市。");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 3600000 },
    );
    if (!navigator.geolocation) {
      setLocating(false);
      setNote("此浏览器不支持定位，可手动选择城市。");
    }
  }
  return (
    <div className="city-select">
      <label>
        <span className="sr-only">天气城市</span>
        <select
          value={value}
          onChange={(e) => {
            gen.current++;
            setLocating(false);
            setNote("");
            onChange(e.target.value);
          }}
        >
          {CITIES.map(([slug, name]) => (
            <option key={slug} value={slug}>
              {name}
            </option>
          ))}
        </select>
        <ChevronDown size={16} />
      </label>
      <button className="weather-location" onClick={locate} disabled={locating}>
        <LocateFixed size={15} />
        {locating ? "定位中" : "我的位置"}
      </button>
    </div>
  );
}
export function WeatherCard() {
  const [city, setCity] = useState(selectedCity),
    [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [locating, setLocating] = useState(false),
    [note, setNote] = useState(""),
    [airExpanded, setAirExpanded] = useState(false),
    [alertOpen, setAlertOpen] = useState(false),
    [tick, setTick] = useState(0);
  const now = useMinuteClock(),
    retry = useRef(false);
  useEffect(() => {
    let live = true;
    const cached = weatherCache.read("summary", city),
      force = retry.current;
    retry.current = false;
    setData(cached?.data || null);
    setLoading(!cached);
    setError("");
    browserStorage.setItem("hyhq.weather.city", city);
    weatherCache
      .request("summary", city, { force })
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [city, tick, now]);
  useEffect(() => {
    setAlertOpen(false);
    setAirExpanded(false);
  }, [city]);
  const raw = data?.location?.slug === city ? data : null,
    view = summaryView(raw, now),
    w = view.weather.data,
    air = view.air.data,
    today = view.today,
    tomorrow = view.tomorrow,
    alerts = view.currentAlerts,
    appearance = weatherAppearance(w?.condition, now),
    Icon = WEATHER_ICONS[appearance.icon] || Cloud;
  return (
    <>
    <section
      className={
        "weather-card " + (appearance.night ? "night " : "") +
        (/雨|雪|雷/.test(w?.condition || "") ? "rainy" : "")
      }
    >
      <div className="weather-top">
        <CitySelect
          value={city}
          onChange={setCity}
          {...{ locating, setLocating, setNote }}
        />
        {alerts.length > 0 && (
          <button className="alert-badge" onClick={() => setAlertOpen(true)}>
            <AlertTriangle size={16} />
            {alerts.length}
            {" 条预警"}
          </button>
        )}
      </div>
      <time className="weather-date" dateTime={day(now)}>
        {new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai",
          month: "long",
          day: "numeric",
          weekday: "short",
        }).format(new Date(now))}
      </time>
      {note && <p className="weather-note">{note}</p>}
      <div className="weather-main">
        <div>
          <div className="weather-current">
            <span className="temperature">
              {loading && !w
                ? "—"
                : celsius(w?.temperature_unit)
                  ? int(w?.temperature)
                  : "—"}
              <sup>°</sup>
            </span>
            <div>
              <strong>
                {loading && !w ? "读取天气" : appearance.label}
              </strong>
              <span className="weather-conditions">
                {w?.humidity_percent != null && (
                  <span>湿度 {int(w.humidity_percent)}%</span>
                )}
                {w?.wind_direction && <span>{wind(w.wind_direction)}</span>}
              </span>
            </div>
          </div>
          {error && (
            <button
              className="text-btn"
              onClick={() => {
                retry.current = true;
                setTick((t) => t + 1);
              }}
            >
              {error} · 重试
            </button>
          )}
          <div className="temperature-range">
            <div>
              <span>今日</span>
              <strong>
                {int(today?.temperature_min)}° <i>/</i>{" "}
                {int(today?.temperature_max)}°
              </strong>
            </div>
            <div>
              <span>明日</span>
              <strong>
                {int(tomorrow?.temperature_min)}° <i>/</i>{" "}
                {int(tomorrow?.temperature_max)}°
              </strong>
            </div>
          </div>
        </div>
        <Icon className="weather-art" strokeWidth={1.3} aria-hidden="true" />
      </div>
      <div className="weather-bottom">
        <button
          className="air-summary"
          onClick={() => setAirExpanded((v) => !v)}
          aria-expanded={airExpanded}
        >
          <span className="air-dot" />
          {air
            ? `空气 ${air.category || ""} · ${air.aqi_display || int(air.aqi)}`
            : "空气质量暂不可用"}
          <ChevronDown size={18} />
        </button>
        <Link to={"/weather?location=" + city} className="weather-book-link">
          订阅天气推送提醒 <ArrowUpRight size={17} />
        </Link>
      </div>
      {airExpanded && air && (
        <div className="air-details">
          {air.pollutants?.map((p) => (
            <div key={p.code}>
              <span>{p.name || p.code}</span>
              <strong>
                {p.value ?? "—"} <small>{p.unit}</small>
              </strong>
            </div>
          ))}
          {air.advice && <p>{air.advice}</p>}
        </div>
      )}
      <Source data={raw} />
    </section>
      {alertOpen && (
        <Modal title="气象预警" onClose={() => setAlertOpen(false)}>
          <div className="modal-body">
            {!alerts.length && <p>暂无生效中的预警。</p>}
            {alerts.map((a, i) => (
              <article className="alert-item" key={a.id || i}>
                <h3>{a.headline || a.title || a.event || "气象预警"}</h3>
                <p>{a.description || a.text}</p>
                {a.instruction && <p>{a.instruction}</p>}
                <small>{a.sender_name || a.sender || ""}</small>
              </article>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
const entries = [
  {
    title: "生态导览",
    subtitle: "天津与北京的河湖绿地",
    to: "/explore",
    icon: Compass,
    image: "entry-explore.jpg",
  },
  {
    title: "识别一片绿意",
    subtitle: "认识身边的五类花卉",
    to: "/recognize",
    icon: Flower2,
    image: "entry-flower.jpg",
  },
  {
    title: "科普智游",
    subtitle: "自然手记与漫步路线",
    to: "/learn",
    icon: BookOpen,
    image: "entry-learn.jpg",
  },
  {
    title: "河道照片观察",
    subtitle: "观察水面漂浮物",
    to: "/recognize?mode=river",
    icon: Waves,
    image: "entry-river.jpg",
  },
];
export function HomePage() {
  const [articles, setArticles] = useState([]);
  useEffect(() => {
    const c = new AbortController();
    api("contents/", {
      data: { page_size: 1, region: "tianjin-nature" },
      signal: c.signal,
    })
      .then((r) => setArticles(r.data))
      .catch(() => {});
    return () => c.abort();
  }, []);
  return (
    <main className="home-page">
      <div className="home-heading">
        <div className="home-brand">
          <img src="/assets/brand/hyhq-sketch.jpg" alt="" width="76" height="76" />
          <h1>海晏河清</h1>
        </div>
        <NotificationButton />
      </div>
      <WeatherCard />
      <div className="section-title">
        <h2>与自然相遇</h2>
        <Leaf size={22} strokeWidth={1.3} />
      </div>
      <div className="home-entry-grid">
        {entries.map(({ icon: Icon, ...e }, i) => (
          <Link key={e.title} to={e.to} className={"home-entry entry-" + i}>
            <div className="entry-art">
              <img src={"/assets/themes/editorial/" + e.image} alt="" />
              <Icon size={47} strokeWidth={1.2} />
            </div>
            <div className="entry-copy">
              <span className="eyebrow">0{i + 1}</span>
              <h3>{e.title}</h3>
              <p>{e.subtitle}</p>
              <ArrowUpRight className="entry-arrow" size={23} />
            </div>
          </Link>
        ))}
      </div>
      <div className="section-title">
        <h2>自然手记</h2>
        <Link to="/learn" className="text-link">
          全部手记
          <ArrowRight size={16} />
        </Link>
      </div>
      <div className="home-journal-grid home-journal-preview">
        {articles.slice(0, 1).map((a, i) => (
          <Link
            to={"/detail/content/" + a.id}
            className="home-journal card"
            key={a.id}
          >
            <span className="journal-no">0{i + 1}</span>
            <div className="journal-preview-copy">
              <small>
                {{
                  plants: "植物知识",
                  water: "水资源保护",
                  green: "绿色生活",
                  travel: "生态智游",
                }[a.category] || "自然见闻"}
              </small>
              <h3>{a.title}</h3>
              <div className="journal-preview-excerpt"><p>{a.summary}</p></div>
              <span className="journal-read-more">阅读全文 <ArrowRight size={14} /></span>
            </div>
            <ArrowUpRight size={20} />
          </Link>
        ))}
      </div>
      <SimulationJournal />
      <AIButton floating context={() => ({scope: "home", weather_location: selectedCity()})} />
    </main>
  );
}
export function WeatherPage() {
  const [params, setParams] = useSearchParams(),
    city = CITIES.some((c) => c[0] === params.get("location"))
      ? params.get("location")
      : selectedCity(),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [locating, setLocating] = useState(false),
    [note, setNote] = useState(""),
    [reminders, setReminders] = useState(null),
    [when, setWhen] = useState(""),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState(null),
    [aiText, setAIText] = useState(""),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useState(0);
  const { user, loading: authLoading } = useAuth(),
    toast = useToast(),
    scope = useIdentityScope(user?.id),
    now = useMinuteClock(),
    retry = useRef(false),
    reminderRequest = useRef(0),
    mutation = useRef(false),
    interpretRequest = useRef(null),
    currentCity = useRef(city);
  currentCity.current = city;
  const changeCity = (v) => {
    setParams({ location: v });
    browserStorage.setItem("hyhq.weather.city", v);
  };
  async function loadReminders(signal) {
    const ticket = scope.capture(),
      request = ++reminderRequest.current;
    if (!ticket.id) {
      setReminders(null);
      return null;
    }
    const r = await api("weather-data/reminders/", { signal });
    if (scope.valid(ticket) && request === reminderRequest.current) {
      if (!Array.isArray(r.data?.items))
        throw new Error("预约记录返回格式不正确，请重试。");
      setReminders({ ...r.data, owner: ticket.id });
    }
    return r.data;
  }
  useEffect(() => {
    let live = true;
    const cached = weatherCache.read("forecast", city),
      force = retry.current;
    retry.current = false;
    setData(cached?.data || null);
    setLoading(!cached);
    setError("");
    weatherCache
      .request("forecast", city, { force })
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [city, revision, now]);
  useEffect(() => {
    const controller = new AbortController(),
      ticket = scope.capture();
    setReminders(null);
    setDraft(null);
    setWhen("");
    setAIText("");
    setNotice("");
    mutation.current = false;
    interpretRequest.current = null;
    setBusy(false);
    loadReminders(controller.signal).catch((e) => {
      if (scope.valid(ticket) && e.name !== "AbortError") setNotice(e.message);
    });
    return () => {
      controller.abort();
      reminderRequest.current++;
    };
  }, [user?.id]);
  function begin() {
    if (!user || mutation.current) return null;
    mutation.current = true;
    setBusy(true);
    setNotice("");
    return scope.capture();
  }
  function finish(ticket) {
    if (scope.valid(ticket)) {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function prepare(e) {
    e.preventDefault();
    if (!user || mutation.current) return;
    setNotice("");
    const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when)
      ? Date.parse(when + ":00+08:00")
      : NaN;
    if (
      !Number.isFinite(ms) ||
      new Date(ms + 8 * 3600000).toISOString().slice(0, 16) !== when
    ) {
      setNotice("请选择有效的提醒日期和时间。");
      return;
    }
    if (ms < Date.now() + 300000 || ms > Date.now() + 48 * 3600000) {
      setNotice("请选择北京时间 5 分钟后至 48 小时内的时间。");
      return;
    }
    setDraft({
      location: city,
      scheduled_for: new Date(ms).toISOString(),
      owner: user.id,
    });
  }
  async function confirm() {
    if (!draft || draft.owner !== user?.id) return;
    const ticket = begin();
    if (!ticket) return;
    try {
      const { owner, ...payload } = draft;
      const r = await api("weather-data/reminders/intents/", {
        method: "POST",
        data: payload,
      });
      if (!scope.valid(ticket)) return;
      await api(
        "weather-data/reminders/intents/" +
          encodeURIComponent(r.data.id) +
          "/confirm/",
        {
          method: "POST",
          data: { template_id: "local-in-app-v1", decision: "accept" },
        },
      );
      if (!scope.valid(ticket)) return;
      setDraft(null);
      setWhen("");
      await loadReminders();
      if (scope.valid(ticket)) toast("已预约本次站内天气提醒。");
    } catch (e) {
      if (scope.valid(ticket)) {
        setNotice(e.message);
        setDraft(null);
        await loadReminders().catch(() => {});
      }
    } finally {
      finish(ticket);
    }
  }
  async function interpret() {
    if (!aiText.trim()) return;
    const ticket = begin();
    if (!ticket) return;
    const selectedCity = city,
      key = JSON.stringify([ticket.id, city, aiText.trim()]);
    if (interpretRequest.current?.key !== key)
      interpretRequest.current = { key, id: crypto.randomUUID() };
    const requestId = interpretRequest.current.id;
    try {
      const r = await api("weather-data/reminders/interpret/", {
        method: "POST",
        data: { text: aiText, location: city, request_key: requestId },
      });
      if (!scope.valid(ticket) || currentCity.current !== selectedCity) return;
      interpretRequest.current = null;
      setNotice(r.data.message || "");
      if (r.data.draft) {
        const d = validBookingDraft(
          r.data.draft,
          CITIES.map((c) => c[0]),
        );
        if (!d) {
          setNotice("草稿日期、时区或地点无效，请重新描述预约时间。");
          return;
        }
        changeCity(d.location);
        setWhen(
          new Date(Date.parse(d.scheduled_for) + 8 * 3600000)
            .toISOString()
            .slice(0, 16),
        );
        setNotice("草稿已填入，请核对城市与北京时间，再确认预约。");
      }
    } catch (e) {
      if (scope.valid(ticket) && currentCity.current === selectedCity) {
        if (e.status >= 400 && e.status < 500 && ![408, 499].includes(e.status))
          interpretRequest.current = null;
        setNotice(e.message);
      }
    } finally {
      finish(ticket);
    }
  }
  async function cancel(id) {
    const ticket = begin();
    if (!ticket) return;
    try {
      await api(
        "weather-data/reminders/" + encodeURIComponent(id) + "/cancel/",
        { method: "POST", data: {} },
      );
      if (!scope.valid(ticket)) return;
      await loadReminders();
      if (scope.valid(ticket)) toast("预约已取消，可以重新选择时间。");
    } catch (e) {
      if (scope.valid(ticket)) setNotice(e.message);
    } finally {
      finish(ticket);
    }
  }
  const forecast =
      data?.location?.slug === city
        ? weatherSection(data.forecast, now, "daily")
        : weatherSection(null, now, "daily"),
    visibleReminders =
      user && reminders?.owner === user.id ? reminders.items : [];
  const days = validDailyDays(forecast, now),
    min = new Date(Date.now() + 6 * 60000 + 8 * 3600000)
      .toISOString()
      .slice(0, 16),
    max = new Date(Date.now() + 48 * 3600000 + 8 * 3600000)
      .toISOString()
      .slice(0, 16);
  return (
    <main className="weather-page">
      <PageHeader eyebrow="WEATHER & PLANS" title="天气预报与预约">
        <Link className="btn secondary" to="/">
          返回首页
        </Link>
      </PageHeader>
      <div className="weather-page-city">
        <CitySelect
          value={city}
          onChange={changeCity}
          {...{ locating, setLocating, setNote }}
        />
        {note && <small>{note}</small>}
      </div>
      <State
        loading={loading}
        error={days.length ? null : error}
        onRetry={() => {
          retry.current = true;
          setRevision((v) => v + 1);
        }}
      >
        {forecast.stale && (
          <p className="inline-warning">当前显示历史预报，实时更新暂不可用。</p>
        )}
        {error && days.length > 0 && <p className="inline-warning">{error}</p>}
        {days.length ? (
          <div className="forecast-grid">
            {days.map((d, i) => (
              <article className="forecast-day card" key={d.date}>
                <span className="eyebrow">
                  {d.date === day()
                    ? "今日"
                    : d.date === day(Date.now() + 86400000)
                      ? "明日"
                      : d.date === day(Date.now() + 2 * 86400000)
                        ? "后天"
                        : formatDate(d.date)}
                </span>
                <small>{formatDate(d.date)}</small>
                <CloudSun size={45} strokeWidth={1} />
                <h2>
                  {int(d.temperature_min)}° <span>/</span>{" "}
                  {int(d.temperature_max)}°
                </h2>
                <p>
                  {d.daytime?.condition || "—"}
                  {d.nighttime?.condition &&
                  d.nighttime.condition !== d.daytime?.condition
                    ? " 转 " + d.nighttime.condition
                    : ""}
                </p>
                <div className="forecast-detail">
                  <Wind size={15} />
                  {wind(d.daytime?.wind_direction)}
                  {d.daytime?.wind_scale != null
                    ? " " + d.daytime.wind_scale + " 级"
                    : ""}
                </div>
                {d.daytime?.precipitation_probability_percent != null && (
                  <div className="forecast-detail">
                    <Droplets size={14} />
                    降水概率 {d.daytime.precipitation_probability_percent}%
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="state card">
            <CloudSun />
            <p>当前预报暂不可用，请稍后再试。</p>
            <button
              className="btn secondary"
              onClick={() => {
                retry.current = true;
                setRevision((v) => v + 1);
              }}
            >
              重新加载
            </button>
          </div>
        )}
        <Source data={{ forecast: data?.forecast }} />
      </State>
      <div className="booking-layout">
        <section className="card booking-form">
          <div className="section-title">
            <h2>
              <Bell size={21} /> 订阅天气推送提醒
            </h2>
            <span className="tag">站内提醒</span>
          </div>
          <p className="muted">
            北京时间 ·
            单次预约。到期后在本机网页的通知中心查看，服务需保持运行。
          </p>
          {authLoading ? (
            <p className="muted">正在读取预约账号…</p>
          ) : !user ? (
            <Link className="btn" to="/login?next=/weather">
              登录后预约
            </Link>
          ) : (
            <>
              <div className="booking-ai">
                <label htmlFor="booking-ai">
                  用一句话安排{" "}
                  <span className="model-tag">DeepSeek · Flash</span>
                </label>
                <div>
                  <input
                    id="booking-ai"
                    value={aiText}
                    onChange={(e) => setAIText(e.target.value)}
                    maxLength={500}
                    placeholder="如：明天早上 8 点提醒我看天津天气"
                  />
                  <button
                    className="btn secondary"
                    onClick={interpret}
                    disabled={busy || !aiText.trim()}
                  >
                    <Sparkles size={16} />
                    生成草稿
                  </button>
                </div>
              </div>
              <form onSubmit={prepare}>
                <label>
                  提醒时间 · 北京时间
                  <input
                    type="datetime-local"
                    required
                    min={min}
                    max={max}
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    onInput={(e) => setWhen(e.currentTarget.value)}
                    onBlur={(e) => setWhen(e.currentTarget.value)}
                  />
                </label>
                <button className="btn full" disabled={busy || !when}>
                  核对预约
                </button>
              </form>
            </>
          )}
          {notice && (
            <p role="status" className="inline-warning">
              {notice}
            </p>
          )}
        </section>
        <section className="card booking-list">
          <h2>我的预约</h2>
          {visibleReminders.length ? (
            visibleReminders.map((r) => (
              <article key={r.id}>
                <div>
                  <strong>{r.location_name}</strong>
                  <span>{formatTime(r.scheduled_for)}</span>
                  <small>
                    {{
                      prepared: "待确认",
                      pending: "等待提醒",
                      sent: "站内提醒已生成",
                      cancelled: "已取消",
                      failed: "未完成",
                      expired: "已过期",
                    }[r.state] || r.state}
                  </small>
                </div>
                {r.can_cancel && (
                  <button
                    className="btn secondary small"
                    onClick={() => cancel(r.id)}
                    disabled={busy}
                  >
                    取消预约
                  </button>
                )}
              </article>
            ))
          ) : (
            <div className="state">
              <Bell size={27} />
              <p>暂无预约</p>
            </div>
          )}
        </section>
      </div>
      {draft && user && draft.owner === user.id && (
        <Modal title="确认天气预约" onClose={() => !busy && setDraft(null)}>
          <div className="modal-body">
            <p className="booking-confirm-city">
              {CITIES.find((c) => c[0] === draft.location)?.[1]}
            </p>
            <h2>{formatTime(draft.scheduled_for)}</h2>
            <p className="muted">北京时间 · 一次站内天气提醒</p>
            <div className="button-row">
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                修改预约
              </button>
              <button className="btn" disabled={busy} onClick={confirm}>
                {busy ? "正在预约" : "确认本次提醒"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
export function NotificationsPage() {
  const { user } = useAuth(),
    scope = useIdentityScope(user?.id);
  const [result, setResult] = useState({ owner: null, rows: [] }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    request = useRef(0);
  async function load(signal) {
    const ticket = scope.capture(),
      generation = ++request.current;
    setError("");
    if (!ticket.id) {
      setResult({ owner: null, rows: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await loadAll(api, "web/notifications/", {}, signal);
      if (scope.valid(ticket) && generation === request.current)
        setResult({ owner: ticket.id, rows });
    } catch (e) {
      if (
        scope.valid(ticket) &&
        generation === request.current &&
        e.name !== "AbortError"
      )
        setError(e.message);
    } finally {
      if (scope.valid(ticket) && generation === request.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setResult({ owner: null, rows: [] });
    load(controller.signal);
    return () => {
      controller.abort();
      request.current++;
    };
  }, [user?.id]);
  const rows = user && result.owner === user.id ? result.rows : [];
  return (
    <main>
      <PageHeader title="通知中心" eyebrow="NOTIFICATIONS" />
      <State loading={loading} error={error} onRetry={() => load()}>
        {!user ? (
          <Link className="btn" to="/login?next=/notifications">
            登录后查看
          </Link>
        ) : rows.length ? (
          rows.map((r) => (
            <article className="card notification" key={r.id}>
              <Bell />
              <div>
                <h3>{r.title}</h3>
                <p>{r.body}</p>
                <small>{formatTime(r.created_at)}</small>
              </div>
              <Link
                className="btn secondary"
                to={
                  /^\/weather\?location=[a-z0-9-]+$/.test(r.href || "")
                    ? r.href
                    : "/weather"
                }
                onClick={() => {
                  if (user?.id === result.owner)
                    api(
                      "web/notifications/" +
                        encodeURIComponent(r.id) +
                        "/read/",
                      { method: "POST", data: {} },
                    ).then(() => notifyNotificationsChanged()).catch(() => {});
                }}
              >
                查看天气
              </Link>
            </article>
          ))
        ) : (
          <div className="state card">
            <Bell />
            <p>暂时没有通知</p>
          </div>
        )}
      </State>
    </main>
  );
}
