import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import L from "leaflet";
import TencentMap from "../TencentMap";
import { preferenceStorage } from "../lib/privacy";
import "leaflet/dist/leaflet.css";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Compass,
  Droplets,
  ExternalLink,
  Star,
  Leaf,
  List,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Play,
  RefreshCw,
  Route,
  Search,
  SlidersHorizontal,
  Volume2,
  X,
} from "lucide-react";
import { api } from "../lib/api.js";
import { useAuth } from "../state.jsx";
import { AIButton, Markdown, Modal } from "../components.jsx";
import {
  CATEGORY_NAMES,
  PLANT_NAMES,
  SOURCE_NAMES,
  TYPES,
  KINDS,
  RANGES,
  cityName,
  numeric,
  formatTime,
  coordinates,
  navigable,
  matchesType,
  safeUrl,
  apiPagePath,
  pageResponse,
  loadAll,
  publicStops,
  rangeQuery,
  validPoint,
  chartGeometry,
  gcjToWgs,
} from "./public-domain.js";
import "./PublicPages.css";
import { BlogLinks, BlogComments } from "./BlogPages.jsx";

const errorText = (e) => e?.message || "暂时无法加载，请稍后重试。";
const savedRegion = () => {
  try {
    return preferenceStorage.getItem("hyhq.region") || "tianjin-nature";
  } catch {
    return "tianjin-nature";
  }
};
const saveRegion = (region) => {
  try {
    preferenceStorage.setItem("hyhq.region", region.slug || region.id);
  } catch {}
};
function useRemote(loader, dependencies = []) {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  const [revision, reload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((s) => ({ ...s, loading: true, error: "" }));
    Promise.resolve()
      .then(() => loader(controller.signal))
      .then((data) => {
        if (active) setState({ loading: false, data, error: "" });
      })
      .catch((e) => {
        if (active && e.name !== "AbortError")
          setState({ loading: false, data: null, error: errorText(e) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [...dependencies, revision]);
  return { ...state, reload: () => reload((v) => v + 1) };
}
function Status({
  loading,
  error,
  empty,
  emptyText = "这里还没有公开资料。",
  onRetry,
  children,
}) {
  if (loading)
    return (
      <div className="public-state" role="status">
        <span className="public-loader" />
        正在读取资料…
      </div>
    );
  if (error)
    return (
      <div className="public-state public-error" role="alert">
        <p>{error}</p>
        {onRetry && (
          <button className="pub-btn outline" onClick={onRetry}>
            <RefreshCw size={16} />
            重新加载
          </button>
        )}
      </div>
    );
  if (empty)
    return (
      <div className="public-state">
        <Leaf size={36} strokeWidth={1} />
        <p>{emptyText}</p>
      </div>
    );
  return children || null;
}
function Heading({ eyebrow, title, description, children }) {
  return (
    <header className="public-heading">
      <div>
        <span className="public-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </header>
  );
}
function Tag({ children, tone = "" }) {
  return <span className={"public-tag " + tone}>{children}</span>;
}
function Field({
  label,
  value,
  onChange,
  options,
  disabled = false,
  empty = "暂无可选项",
}) {
  return (
    <label className="public-field">
      <span>{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || !options.length}
      >
        {options.length ? (
          options.map((o, i) => (
            <option key={o.id ?? o.value ?? i} value={o.id ?? o.value}>
              {o.name || o.label}
            </option>
          ))
        ) : (
          <option value="">{empty}</option>
        )}
      </select>
    </label>
  );
}
function SourceLink({ url, children }) {
  return safeUrl(url) ? (
    <a
      className="public-source-link"
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      {children || "查看资料出处"} <ExternalLink size={13} />
    </a>
  ) : null;
}
function NavigationLinks({ item }) {
  return navigable(item) ? (
    <div className="public-actions">
      <a
        className="pub-btn"
        href={
          "https://uri.amap.com/navigation?to=" +
          item.longitude +
          "," +
          item.latitude +
          "," +
          encodeURIComponent(item.name || "生态地点") +
          "&mode=walk&coordinate=gaode&src=HYHQ&callnative=0"
        }
        target="_blank"
        rel="noreferrer"
      >
        <MapPin size={16} />
        高德地图
      </a>
      <a
        className="pub-btn outline"
        href={
          "https://apis.map.qq.com/uri/v1/routeplan?type=walk&to=" +
          encodeURIComponent(item.name || "生态地点") +
          "&tocoord=" +
          item.latitude +
          "," +
          item.longitude +
          "&policy=1&referer=HYHQ"
        }
        target="_blank"
        rel="noreferrer"
      >
        腾讯地图 <ArrowUpRight size={16} />
      </a>
    </div>
  ) : null;
}
function useRegions(includeDemo = false) {
  return useRemote(
    (signal) =>
      loadAll(api, "regions/", {}, signal).then((r) =>
        r.filter(
          (x) => includeDemo || (!x.is_demo && x.slug !== "demo-campus"),
        ),
      ),
    [includeDemo],
  );
}
function ContentCard({ item, index = 0, route = false }) {
  const Icon = route ? Route : item.category === "water" ? Droplets : Leaf;
  return (
    <Link
      className={"public-content-card " + (route ? "route-content-card" : "")}
      to={
        !route && item.origin === "blog"
          ? "/blog/" + encodeURIComponent(item.id)
          : "/detail/" + (route ? "route" : "content") + "/" + encodeURIComponent(item.id)
      }
    >
      <div
        className={
          "public-card-art category-" +
          (route ? "route" : item.category || "plants")
        }
        aria-hidden="true"
      >
        <Icon size={54} strokeWidth={1.1} />
        <span>{String(index + 1).padStart(2, "0")}</span>
      </div>
      <div className="public-card-body">
        <div className="public-card-meta">
          <span>
            {route
              ? item.region_name || "公开路线"
              : CATEGORY_NAMES[item.category] || "自然见闻"}
          </span>
          {item.is_demo && <Tag>{route ? "科普模拟路线" : "科普示例"}</Tag>}
        </div>
        <h3>{item.title || item.name}</h3>
        <p>
          {item.summary ||
            item.description ||
            (route ? "查看路线节点" : "阅读完整科普内容")}
        </p>
        {item.plant_label && (
          <span className="public-plant-tag">
            # {PLANT_NAMES[item.plant_label] || item.plant_label}
          </span>
        )}
        {item.place_summary && (
          <p className="public-small">
            <MapPin size={12} /> {item.place_summary.name} ·{" "}
            {item.place_summary.region_name}
          </p>
        )}
        <div className="public-card-footer">
          <span>
            {route
              ? Number.isInteger(item.stop_count)
                ? item.stop_count + " 个公开地点"
                : "浏览沿途地点"
              : item.origin === "blog" ? item.author_name : item.source || ""}
          </span>
          <strong>
            {route ? "展开路线" : "阅读手记"} <ArrowUpRight size={16} />
          </strong>
        </div>
        {route && item.source && (
          <small className="public-muted">路线来源：{item.source}</small>
        )}
      </div>
    </Link>
  );
}
function usePaged(endpoint, query) {
  const key = JSON.stringify(query),
    [revision, reload] = useState(0),
    [state, set] = useState({
      loading: true,
      items: [],
      next: "",
      error: "",
      moreError: "",
      moreLoading: false,
    }),
    generation = useRef(0),
    seen = useRef(new Set());
  useEffect(() => {
    const g = ++generation.current,
      c = new AbortController();
    seen.current = new Set();
    set({
      loading: true,
      items: [],
      next: "",
      error: "",
      moreError: "",
      moreLoading: false,
    });
    api(endpoint, { data: query, signal: c.signal })
      .then((r) => {
        if (g !== generation.current) return;
        const page = pageResponse(
          r,
          endpoint + "?" + new URLSearchParams(query).toString(),
          endpoint,
          seen.current,
        );
        seen.current.add(page.key);
        set({
          loading: false,
          items: page.items,
          next: page.next,
          error: "",
          moreError: "",
          moreLoading: false,
        });
      })
      .catch((e) => {
        if (g === generation.current && e.name !== "AbortError")
          set((s) => ({ ...s, loading: false, error: errorText(e) }));
      });
    return () => {
      generation.current++;
      c.abort();
    };
  }, [endpoint, key, revision]);
  async function more() {
    if (state.loading || state.moreLoading || !state.next) return;
    const g = generation.current,
      path = state.next;
    set((s) => ({ ...s, moreLoading: true, moreError: "" }));
    try {
      const r = await api(path);
      if (g !== generation.current) return;
      const page = pageResponse(r, path, endpoint, seen.current);
      seen.current.add(page.key);
      set((s) => ({
        ...s,
        items: [
          ...new Map(
            [...s.items, ...page.items].map((i) => [i.id, i]),
          ).values(),
        ],
        next: page.next,
        moreLoading: false,
      }));
    } catch (e) {
      if (g === generation.current)
        set((s) => ({ ...s, moreLoading: false, moreError: errorText(e) }));
    }
  }
  return { ...state, more, reload: () => reload((v) => v + 1) };
}

export function LearnPage() {
  const [params, setParams] = useSearchParams();
  const regions = useRegions();
  const tab = params.get("tab") === "routes" ? "routes" : "contents";
  const region = params.has("region") ? params.get("region") : savedRegion();
  const category = params.get("category") || "",
    plant = params.get("plant_label") || "",
    place = params.get("place") || "",
    search = params.get("search") || "";
  const [input, setInput] = useState(search),
    [showFilters, setShowFilters] = useState(!!(category || plant));
  useEffect(() => setInput(search), [search]);
  const patch = (values) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
  };
  const tags = useRemote(
    (signal) =>
      tab === "contents"
        ? api("content-tags/", { data: region ? { region } : {}, signal }).then(
            (r) => r.data,
          )
        : null,
    [region, tab],
  );
  const query = {
    page_size: 20,
    ...(region ? { region } : {}),
    ...(tab === "contents"
      ? Object.fromEntries(
          Object.entries({
            category,
            plant_label: plant,
            place,
            search,
          }).filter(([, v]) => v),
        )
      : {}),
  };
  const list = usePaged(tab === "contents" ? "web/blog/posts/" : "routes/", query);
  const selectedRegion =
    regions.data?.find((r) => r.id === region || r.slug === region) ||
    regions.data?.[0];
  const reset = () =>
    patch({ category: null, plant_label: null, place: null, search: null });
  const choices = (items, names, all, selected) => {
    const result = [
      { value: "", name: all },
      ...(items || []).map((i) => ({
        value: i.value,
        name: names[i.value] || i.name || i.value,
      })),
    ];
    if (selected && !result.some((i) => i.value === selected))
      result.push({ value: selected, name: names[selected] || selected });
    return result;
  };
  return (
    <main className="public-page learn-page">
      <Heading eyebrow="NATURE JOURNAL" title="科普智游"><BlogLinks /></Heading>
      <section className="public-filter-card">
        <div className="public-filter-top">
          <label className="public-region-select">
            <Leaf size={19} />
            <select
              aria-label="科普区域"
              value={region}
              onChange={(e) => {
                const r = regions.data?.find(
                  (i) => i.id === e.target.value || i.slug === e.target.value,
                );
                if (r) saveRegion(r);
                patch({ region: e.target.value, place: null });
              }}
            >
              <option value="">全部区域</option>
              {regions.data?.map((r) => (
                <option
                  key={r.id}
                  value={r.id === region ? r.id : r.slug || r.id}
                >
                  {cityName(r)}
                </option>
              ))}
              {region &&
                !regions.data?.some(
                  (r) => r.slug === region || r.id === region,
                ) && (
                  <option value={region}>
                    {region === "tianjin-nature" ? "天津" : "指定区域"}
                  </option>
                )}
            </select>
            <ChevronDown size={15} />
          </label>
          {tab === "contents" && (
            <button
              className={"pub-btn ghost " + (showFilters ? "active" : "")}
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
            >
              <SlidersHorizontal size={16} />
              {showFilters ? "收起筛选" : "分类筛选"}
            </button>
          )}
        </div>
        {regions.error && (
          <div className="public-inline-error">
            区域暂时无法加载：{regions.error}
            <button onClick={regions.reload}>重新加载</button>
          </div>
        )}
        {tab === "contents" ? (
          <>
            <form
              className="public-search"
              onSubmit={(e) => {
                e.preventDefault();
                patch({ search: input.trim() || null });
              }}
            >
              <Search size={20} />
              <input
                aria-label="搜索自然知识"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={100}
                placeholder="搜索自然知识"
              />
              <button className="pub-btn" type="submit">
                搜索
              </button>
            </form>
            {showFilters && (
              <div className="public-filter-grid">
                <Field
                  label="内容分类"
                  value={category}
                  options={choices(
                    Object.keys(CATEGORY_NAMES).map(value => ({ value })),
                    CATEGORY_NAMES,
                    "全部分类",
                    category,
                  )}
                  onChange={(v) => patch({ category: v || null })}
                />
                <Field
                  label="植物标签"
                  value={plant}
                  options={choices(
                    Object.keys(PLANT_NAMES).map(value => ({ value })),
                    PLANT_NAMES,
                    "全部植物标签",
                    plant,
                  )}
                  onChange={(v) => patch({ plant_label: v || null })}
                />
                <p className="public-small public-muted">
                  通用科普会随各区域一起显示。
                </p>
              </div>
            )}
            {tags.error && (
              <div className="public-inline-error">
                标签暂时无法加载：{tags.error}
                <button onClick={tags.reload}>重试标签</button>
              </div>
            )}
            {(category || plant || search || place) && (
              <div className="public-active-filters">
                <span>
                  {[
                    CATEGORY_NAMES[category] || category,
                    PLANT_NAMES[plant] || plant,
                    search && "“" + search + "”",
                    place && "关联地点的科普",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <button className="public-text-button" onClick={reset}>
                  <X size={14} />
                  清除筛选
                </button>
              </div>
            )}
          </>
        ) : (
          region && (
            <button
              className="public-text-button"
              onClick={() => patch({ region: "" })}
            >
              浏览全部区域路线 <ArrowUpRight size={15} />
            </button>
          )
        )}
      </section>
      <div className="public-section-line">
        <div className="public-tabs" role="tablist" aria-label="科普内容类型">
          <button
            role="tab"
            aria-selected={tab === "contents"}
            className={tab === "contents" ? "active" : ""}
            onClick={() => patch({ tab: "contents" })}
          >
            <BookOpen size={17} />
            科普博客
          </button>
          <button
            role="tab"
            aria-selected={tab === "routes"}
            className={tab === "routes" ? "active" : ""}
            onClick={() => patch({ tab: "routes" })}
          >
            <Route size={17} />
            漫步路线
          </button>
        </div>
        <Link className="public-text-link" to="/submissions">
          资料补充与纠错反馈 <ArrowUpRight size={15} />
        </Link>
      </div>
      <Status
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        empty={!list.items.length}
        emptyText={
          tab === "routes"
            ? "这个区域暂时没有公开路线，试试切换区域。"
            : "暂时没有符合条件的手记，试试清除筛选或切换区域。"
        }
      >
        <div className="public-content-grid">
          {list.items.map((item, i) => (
            <ContentCard
              key={item.id}
              item={item}
              index={i}
              route={tab === "routes"}
            />
          ))}
        </div>
        <div className="public-list-footer">
          {list.moreError && (
            <p className="public-inline-error">{list.moreError}</p>
          )}
          {list.next ? (
            <button
              className="pub-btn outline"
              disabled={list.moreLoading}
              onClick={list.more}
            >
              {list.moreLoading
                ? "正在加载…"
                : list.moreError
                  ? "重试加载更多"
                  : "加载更多" + (tab === "routes" ? "路线" : "科普")}
              <ArrowRight size={15} />
            </button>
          ) : (
            <span>
              · 已展示 {list.items.length}{" "}
              {tab === "routes" ? "条公开路线" : "篇手记"} ·
            </span>
          )}
        </div>
      </Status>
      <p className="public-footnote">
        文章与评论审核后公开。科普示例与模拟路线均有标注；路线供阅读参考，不提供实时导航或到访核验。
      </p>
      {selectedRegion && !regions.error && (
        <AIButton
          floating
          context={{
            scope: "learn",
            source_type: "region",
            source_id: selectedRegion.id,
          }}
        />
      )}
    </main>
  );
}

function RealMap({
  region,
  points,
  rivers,
  selected,
  onSelect,
  position,
  resetToken,
}) {
  const el = useRef(null),
    map = useRef(null),
    layer = useRef(null),
    riverLayer = useRef(null),
    locationLayer = useRef(null),
    selectRef = useRef(onSelect),
    [tileError, setTileError] = useState(false),
    [retry, setRetry] = useState(0);
  selectRef.current = onSelect;
  useEffect(() => {
    const instance = L.map(el.current, {
      zoomControl: false,
      scrollWheelZoom: true,
    });
    map.current = instance;
    L.control.zoom({ position: "bottomright" }).addTo(instance);
    const tiles = L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        referrerPolicy: "strict-origin-when-cross-origin",
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      },
    ).addTo(instance);
    let successfulTiles = 0, failedTiles = 0;
    setTileError(false);
    const timeout = window.setTimeout(() => { if (!successfulTiles) setTileError(true); }, 10000);
    tiles.on("loading", () => { successfulTiles = 0; failedTiles = 0; });
    tiles.on("tileload", () => { successfulTiles++; });
    tiles.on("tileerror", () => { failedTiles++; setTileError(true); });
    tiles.on("load", () => { window.clearTimeout(timeout); setTileError(failedTiles > 0 || successfulTiles === 0); });
    layer.current = L.layerGroup().addTo(instance);
    riverLayer.current = L.layerGroup().addTo(instance);
    locationLayer.current = L.layerGroup().addTo(instance);
    const resize = () => instance.invalidateSize({pan: false});
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(el.current);
    window.addEventListener("resize", resize);
    window.addEventListener("pageshow", resize);
    return () => {
      ro?.disconnect();
      window.clearTimeout(timeout);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pageshow", resize);
      instance.remove();
      map.current = null;
    };
  }, [retry]);
  useEffect(() => {
    if (!map.current || !region) return;
    const center = region.real_map;
    const p = center && {
      latitude: center.center_latitude,
      longitude: center.center_longitude,
    };
    if (coordinates(p)) {
      map.current.setView(
        gcjToWgs(p.latitude, p.longitude),
        center.scale || 11,
      );
    } else if (points.length)
      map.current.fitBounds(
        points.map((p) => gcjToWgs(p.latitude, p.longitude)),
        { padding: [35, 35], maxZoom: 12 },
      );
  }, [region?.id, resetToken, retry]);
  useEffect(() => {
    if (!layer.current) return;
    layer.current.clearLayers();
    for (const p of points) {
      const selectedId = selected?.id === p.id;
      const kind = matchesType(p, "water")
        ? "water"
        : matchesType(p, "campus")
          ? "campus"
          : "land";
      const icon = L.divIcon({
        className: "hyhq-leaflet-marker",
        html:
          '<span class="map-dot ' +
          kind +
          (selectedId ? " selected" : "") +
          '"><i></i></span>',
        iconSize: [26, 34],
        iconAnchor: [13, 31],
      });
      const marker = L.marker(gcjToWgs(p.latitude, p.longitude), {
        icon,
        keyboard: true,
        title: p.name,
      }).addTo(layer.current);
      const label = document.createElement("span");
      label.textContent = p.name;
      marker.bindTooltip(label, { direction: "top", offset: [0, -24] });
      marker.on("click", () => selectRef.current(p));
    }
  }, [points, selected?.id, retry]);
  useEffect(() => {
    if (!riverLayer.current) return;
    riverLayer.current.clearLayers();
    for (const r of rivers) {
      if (
        r.geometry_verified === true &&
        String(r.coordinate_system).toUpperCase() === "GCJ02" &&
        Array.isArray(r.path) &&
        r.path.length >= 2 &&
        r.path.length <= 200 &&
        r.path.every(coordinates)
      )
        L.polyline(
          r.path.map((p) => gcjToWgs(p.latitude, p.longitude)),
          { color: "#428bab", weight: 4, opacity: 0.7 },
        ).addTo(riverLayer.current);
    }
  }, [rivers, retry]);
  useEffect(() => {
    if (selected && map.current)
      map.current.flyTo(gcjToWgs(selected.latitude, selected.longitude), 14, {
        duration: 0.45,
      });
  }, [selected?.id, retry]);
  useEffect(() => {
    if (!locationLayer.current) return;
    locationLayer.current.clearLayers();
    if (position && map.current) {
      const p = [position.latitude, position.longitude];
      L.circleMarker(p, {
        radius: 8,
        color: "#fff",
        weight: 3,
        fillColor: "#236fc1",
        fillOpacity: 1,
      })
        .bindTooltip("本次附近位置")
        .addTo(locationLayer.current);
      map.current.flyTo(p, 13, { duration: 0.45 });
    }
  }, [position, retry]);
  return (
    <div className="public-map-wrap">
      <div
        ref={el}
        className="public-real-map"
        role="region"
        aria-label={cityName(region) + "生态地点地图"}
      />
      {tileError && (
        <div className="public-map-warning">
          底图连接暂不可用，地点列表仍可浏览。
          <button className="pub-btn outline" onClick={() => setRetry(n => n + 1)}>重新加载底图</button>
        </div>
      )}
      <div className="public-map-legend">
        <span>
          <i className="water" />
          河湖
        </span>
        <span>
          <i />
          公园 / 地标
        </span>
        <span>
          <i className="campus" />
          校园
        </span>
      </div>
    </div>
  );
}
export function ExplorePage() {
  const [params, setParams] = useSearchParams(),
    regions = useRegions();
  const [city, setCity] = useState(() => params.get("city") || savedRegion()),
    [type, setType] = useState(""),
    [search, setSearch] = useState(""),
    [mode, setMode] = useState("map"),
    [selected, setSelected] = useState(null),
    [position, setPosition] = useState(null),
    [locating, setLocating] = useState(false),
    [locationNotice, setLocationNotice] = useState(""),
    [resetToken, setReset] = useState(0);
  const locationGeneration = useRef(0);
  const references = useRemote(
    (signal) =>
      api("web/map-points/", { signal }).then((r) => ({
        points: Array.isArray(r.data)
          ? r.data
          : r.data?.points || r.data?.locations || [],
        note: r.data?.scope_note || "",
      })),
    [],
  );
  useEffect(() => {
    if (params.get("city")) setCity(params.get("city"));
  }, [params.get("city")]);
  const pendingId = params.get("reference_id");
  const requestedReference = references.data?.points.find(
    (p) => p.id === pendingId,
  );
  const region =
    regions.data?.find(
      (r) =>
        r.slug === (requestedReference?.region_slug || city) ||
        r.slug === city + "-nature" ||
        r.id === city,
    ) ||
    regions.data?.find((r) => r.slug === "tianjin-nature") ||
    regions.data?.[0];
  const catalog = useRemote(
    async (signal) => {
      if (!region)
        return { places: [], rivers: [], placesError: "", riversError: "" };
      const results = await Promise.allSettled([
        loadAll(api, "places/", { region: region.id }, signal),
        loadAll(api, "rivers/", { region: region.id }, signal),
      ]);
      return {
        places:
          results[0].status === "fulfilled"
            ? results[0].value.filter(
                (p) =>
                  p.region === region.id &&
                  p.is_demo === false &&
                  p.is_published === true,
              )
            : [],
        rivers:
          results[1].status === "fulfilled"
            ? results[1].value.filter(
                (r) =>
                  r.region === region.id &&
                  r.is_published === true &&
                  !r.is_demo,
              )
            : [],
        placesError:
          results[0].status === "rejected" ? errorText(results[0].reason) : "",
        riversError:
          results[1].status === "rejected"
            ? "河道资料暂不可用，地图和参考点仍可浏览。"
            : "",
      };
    },
    [region?.id],
  );
  useEffect(() => {
    if (region) saveRegion(region);
    setSelected(null);
    setPosition(null);
    setLocationNotice("");
    setLocating(false);
    locationGeneration.current++;
  }, [region?.id]);
  useEffect(() => {
    if (requestedReference && region?.slug === requestedReference.region_slug) {
      setType("");
      setSearch("");
      setSelected({ ...requestedReference, isReference: true });
    }
  }, [requestedReference?.id, region?.id]);
  useEffect(
    () => () => {
      locationGeneration.current++;
    },
    [],
  );
  const allPoints = useMemo(
    () => [
      ...(catalog.data?.places || []),
      ...(references.data?.points || [])
        .filter(
          (p) =>
            p.region_slug === region?.slug &&
            p.coordinate_system === "GCJ02" &&
            coordinates(p),
        )
        .map((p) => ({ ...p, isReference: true })),
    ],
    [catalog.data, references.data, region?.id],
  );
  const filtered = useMemo(
    () =>
      allPoints.filter(
        (p) =>
          matchesType(p, type) &&
          [p.name, p.district, p.address, p.description]
            .join(" ")
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [allPoints, type, search],
  );
  const mapped = useMemo(
    () => filtered.filter((p) => p.isReference || navigable(p)),
    [filtered],
  );
  const rivers = useMemo(
    () => (!type || type === "water" ? catalog.data?.rivers || [] : []),
    [catalog.data, type],
  );
  function switchCity(value) {
    setCity(value);
    setSelected(null);
    setSearch("");
    setType("");
    setPosition(null);
    setLocationNotice("");
    setLocating(false);
    locationGeneration.current++;
    const next = new URLSearchParams(params);
    next.set("city", value.replace("-nature", ""));
    next.delete("reference_id");
    setParams(next, { replace: true });
  }
  function select(p) {
    setSelected(p);
    setMode("map");
  }
  function locate() {
    if (locating) return;
    const g = ++locationGeneration.current;
    setLocating(true);
    setLocationNotice("");
    if (!navigator.geolocation) {
      setLocating(false);
      setLocationNotice(
        "暂未获得附近位置；仍可手动切换城市、拖动地图和浏览地点。",
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (g !== locationGeneration.current) return;
        setLocating(false);
        setPosition({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
        });
        setSelected(null);
        setLocationNotice(
          "已显示附近位置。位置仅用于本次地图浏览，不提交平台后端或保存到记录。",
        );
      },
      () => {
        if (g !== locationGeneration.current) return;
        setLocating(false);
        setLocationNotice(
          "暂未获得附近位置；仍可手动切换城市、拖动地图和浏览地点。",
        );
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    );
  }
  const aiContext = selected
    ? {
        scope: "explore",
        source_type: selected.isReference ? "map_reference" : "place",
        source_id: selected.id,
      }
    : region
      ? { scope: "explore", source_type: "region", source_id: region.id }
      : null;
  return (
    <main className="public-page explore-page">
      <Heading eyebrow="EXPLORE THE CITY" title="生态导览">
        <div className="public-city-tabs">
          {regions.data?.map((r) => (
            <button
              key={r.id}
              className={region?.id === r.id ? "active" : ""}
              onClick={() => switchCity(r.slug || r.id)}
            >
              {cityName(r)}
            </button>
          ))}
        </div>
      </Heading>
      <Status
        loading={regions.loading}
        error={regions.error}
        onRetry={regions.reload}
        empty={!region}
        emptyText="还没有可浏览的区域，请稍后再来。"
      >
        {region && (
          <>
            <section className="public-map-toolbar">
              <div className="public-type-tabs">
                {TYPES.map((t) => (
                  <button
                    key={t.value}
                    className={type === t.value ? "active" : ""}
                    onClick={() => {
                      setType(t.value);
                      setSelected(null);
                    }}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              <div className="public-view-switch">
                <button
                  aria-label="真实地图"
                  title="真实地图"
                  className={mode === "map" ? "active" : ""}
                  onClick={() => setMode("map")}
                >
                  <MapIcon size={18} />
                </button>
                <button
                  aria-label="地点列表"
                  title="地点列表"
                  className={mode === "list" ? "active" : ""}
                  onClick={() => setMode("list")}
                >
                  <List size={18} />
                </button>
              </div>
            </section>
            <div
              className={
                "public-explore-layout " + (mode === "list" ? "list-mode" : "")
              }
            >
              <aside className="public-map-sidebar">
                <div className="public-side-search">
                  <Search size={18} />
                  <input
                    aria-label="搜索地点"
                    placeholder="搜索地点、河湖或校园"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button aria-label="清除搜索" onClick={() => setSearch("")}>
                      <X size={16} />
                    </button>
                  )}
                </div>
                <div className="public-map-count">
                  <strong>{cityName(region)}</strong>
                  <span>
                    {filtered.length} 处地点{catalog.loading ? " · 更新中" : ""}
                  </span>
                </div>
                {references.error && (
                  <div className="public-inline-error">
                    地图参考点加载失败
                    <button onClick={references.reload}>重试</button>
                  </div>
                )}
                {catalog.data?.placesError && (
                  <div className="public-inline-error">
                    正式地点资料暂不可用：{catalog.data.placesError}
                    <button onClick={catalog.reload}>重试</button>
                  </div>
                )}
                <div className="public-point-list">
                  {filtered.map((p, index) => (
                    <button
                      key={p.id}
                      className={
                        "public-point " +
                        (selected?.id === p.id ? "active" : "")
                      }
                      onClick={() => select(p)}
                    >
                      <span
                        className={
                          "public-point-icon " +
                          (matchesType(p, "water") ? "water" : "")
                        }
                      >
                        {matchesType(p, "water") ? (
                          <Droplets size={18} />
                        ) : p.kind === "campus" ? (
                          <BookOpen size={18} />
                        ) : (
                          <Leaf size={18} />
                        )}
                      </span>
                      <span>
                        <strong>{p.name}</strong>
                        <small>
                          {[p.district, p.address]
                            .filter(Boolean)
                            .join(" · ") ||
                            p.description ||
                            "公开地点资料"}
                        </small>
                        <em>{p.kind === "campus" ? "校园" : p.isReference ? "地图参考点" : "已发布地点"}</em>
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                  {!filtered.length &&
                    !references.loading &&
                    !catalog.loading && (
                      <div className="public-state">暂无符合条件的地点</div>
                    )}
                </div>
              </aside>
              <section className="public-map-main">
                {mode === "map" && (
                  <>
                    <TencentMap fallback={RealMap}
                      region={region}
                      points={mapped}
                      rivers={rivers}
                      selected={
                        selected && coordinates(selected) ? selected : null
                      }
                      onSelect={select}
                      position={position}
                      resetToken={resetToken}
                    />
                    <div className="public-map-controls">
                      <button
                        className="pub-btn surface"
                        onClick={locate}
                        disabled={locating}
                      >
                        <LocateFixed size={17} />
                        {locating ? "正在定位…" : "我的附近"}
                      </button>
                      <button
                        className="pub-btn surface"
                        onClick={() => {
                          locationGeneration.current++;
                          setLocating(false);
                          setPosition(null);
                          setSelected(null);
                          setLocationNotice("");
                          setReset((v) => v + 1);
                        }}
                      >
                        <Compass size={17} />
                        回到{cityName(region)}
                      </button>
                    </div>
                  </>
                )}
                {selected ? (
                  <article className="public-selected-point">
                    <div className="public-section-line">
                      <Tag>
                        {selected.kind === "campus" ? "校园" : selected.isReference ? "地图参考点" : "生态地点"}
                      </Tag>
                      <button
                        className="public-icon-button"
                        aria-label="关闭地点详情"
                        onClick={() => setSelected(null)}
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <h2>{selected.name}</h2>
                    <p>{selected.description}</p>
                    {[selected.district, selected.address].filter(Boolean)
                      .length > 0 && (
                      <p className="public-small">
                        <MapPin size={14} />
                        {[selected.district, selected.address]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                    {selected.access_note && (
                      <p className="public-small">{selected.access_note}</p>
                    )}
                    <div className="public-selected-footer">
                      <div>
                        <p className="public-small public-muted">
                          {selected.source_note || "地图点位资料"}
                          {selected.checked_at
                            ? " · 核对日期 " + selected.checked_at
                            : ""}
                        </p>
                        <SourceLink url={selected.source_url} />
                      </div>
                      {!selected.isReference && (
                        <Link
                          className="pub-btn"
                          to={"/detail/place/" + selected.id}
                        >
                          查看地点详情
                          <ArrowRight size={16} />
                        </Link>
                      )}
                    </div>
                    {selected.isReference ? (
                      <p className="public-reference-note">
                        {references.data?.note ||
                          "参考点，不代表入口、完整河道或导航路线。"}
                      </p>
                    ) : (
                      <NavigationLinks item={selected} />
                    )}
                  </article>
                ) : (
                  <div className="public-map-intro">
                    <MapPin size={23} strokeWidth={1.5} />
                    <div>
                      <strong>在地图上选择一个地点</strong>
                      <p>查看地点介绍与资料来源，继续了解这片自然。</p>
                    </div>
                  </div>
                )}
              </section>
            </div>
            {(locationNotice || catalog.data?.riversError) && (
              <p className="public-notice">
                {locationNotice || catalog.data.riversError}
              </p>
            )}
            <p className="public-footnote">
              {references.data?.note ||
                "地图参考点供浏览定位使用，不代表入口、完整河道或导航路线。"}{" "}
              开放范围以现场公告为准。
            </p>
          </>
        )}
      </Status>
      {aiContext && !regions.error && <AIButton floating context={aiContext} />}
    </main>
  );
}

function Narration({ kind, id }) {
  const metadata = useRemote(
    (signal) =>
      api("narrations/", { data: { [kind]: id }, signal }).then((r) => r.data),
    [kind, id],
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [playing, setPlaying] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [duration, setDuration] = useState(0),
    [withdrawn, setWithdrawn] = useState(false);
  const player = useRef(null),
    revision = useRef(""),
    generation = useRef(0);
  const clock = (v) =>
    Number.isFinite(v) && v > 0
      ? Math.floor(v / 60) + ":" + String(Math.floor(v % 60)).padStart(2, "0")
      : "0:00";
  function release() {
    const a = player.current;
    player.current = null;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    revision.current = "";
  }
  useEffect(() => {
    generation.current++;
    setError("");
    setPlaying(false);
    setBusy(false);
    setElapsed(0);
    setDuration(0);
    setWithdrawn(false);
    return () => {
      generation.current++;
      release();
    };
  }, [id, kind]);
  if (!metadata.data || withdrawn) return null;
  async function toggle() {
    if (busy) return;
    if (playing && player.current) {
      player.current.pause();
      setPlaying(false);
      return;
    }
    const g = generation.current;
    setBusy(true);
    setError("");
    try {
      const { data } = await api("narrations/", { data: { [kind]: id } });
      if (g !== generation.current) return;
      if (!data) {
        release();
        setWithdrawn(true);
        return;
      }
      if (
        !/^[0-9a-f-]{36}$/i.test(data.id) ||
        !/^\/api\/v1\/narrations\/[0-9a-f-]+\/audio\/$/i.test(
          data.audio_path,
        ) ||
        data.audio_path != "/api/v1/narrations/" + data.id + "/audio/" ||
        !["audio/mpeg", "audio/mp4", "audio/wav"].includes(data.mime_type)
      )
        throw new Error("此讲解暂时不可用。");
      const key = data.id + ":" + data.revision;
      if (!player.current || revision.current !== key) {
        release();
        const a = new Audio(
          data.audio_path +
            "?revision=" +
            encodeURIComponent(data.revision || ""),
        );
        player.current = a;
        revision.current = key;
        setElapsed(0);
        setDuration(0);
        a.ontimeupdate = () => {
          if (player.current === a && g === generation.current) {
            setElapsed(a.currentTime);
            setDuration(a.duration);
          }
        };
        a.onended = () => {
          if (player.current === a) {
            setPlaying(false);
            setElapsed(0);
            release();
          }
        };
        a.onerror = () => {
          if (player.current === a) {
            release();
            setPlaying(false);
            setError("暂时无法播放，请检查网络后重试。");
          }
        };
      }
      await player.current.play();
      if (g === generation.current) setPlaying(true);
    } catch (e) {
      if (g === generation.current) {
        release();
        setPlaying(false);
        setError(errorText(e));
      }
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  function stop() {
    generation.current++;
    release();
    setPlaying(false);
    setBusy(false);
    setElapsed(0);
    setDuration(0);
    setError("");
  }
  return (
    <section className="public-narration">
      <span className="public-narration-icon">
        <Volume2 size={21} />
      </span>
      <div>
        <strong>语音讲解</strong>
        <p className="public-small public-muted">
          {clock(elapsed)} / {clock(duration)}
        </p>
      </div>
      <button className="pub-btn outline" disabled={busy} onClick={toggle}>
        <Play size={15} />
        {busy
          ? "准备中…"
          : playing
            ? "暂停讲解"
            : error
              ? "重试播放"
              : "播放讲解"}
      </button>
      {(playing || elapsed > 0) && (
        <button className="public-text-button" onClick={stop}>
          停止
        </button>
      )}
      {error && <span className="public-inline-error">{error}</span>}
    </section>
  );
}

function PlaceObservations({ item }) {
  const [stationId, setStation] = useState("");
  const stations = useRemote(
    (signal) => loadAll(api, "stations/", { place: item.id }, signal),
    [item.id],
  );
  const station =
    stations.data?.find((s) => s.id === stationId) || stations.data?.[0];
  const observations = useRemote(
    (signal) =>
      station
        ? api("observations/", {
            data: {
              station: station.id,
              source_type: "simulation",
              page_size: 12,
            },
            signal,
          }).then((r) => r.data)
        : [],
    [station?.id],
  );
  if (!stations.loading && !stations.error && !stations.data?.length)
    return null;
  return (
    <section className="public-detail-section">
      <div className="public-section-line">
        <h2>科普模拟观测</h2>
        <Tag>模拟数据</Tag>
      </div>
      <Status
        loading={stations.loading}
        error={stations.error}
        onRetry={stations.reload}
      >
        {station && (
          <>
            <Field
              label="监测站"
              value={station.id}
              options={stations.data}
              onChange={setStation}
            />
            <Link
              className="public-text-link"
              to={
                "/data-center?" +
                new URLSearchParams({
                  region: item.region,
                  stationId: station.id,
                  kind: station.kind,
                })
              }
            >
              在数据中心查看此站趋势 <ArrowUpRight size={14} />
            </Link>
            <Status
              loading={observations.loading}
              error={observations.error}
              empty={!observations.data?.length}
              emptyText="该监测站暂无模拟观测。"
              onRetry={observations.reload}
            >
              <div className="public-observation-list">
                {observations.data?.map((o) => (
                  <div key={o.id}>
                    <div>
                      <strong>{o.metric_name}</strong>
                      <small>
                        {formatTime(o.observed_at)} ·{" "}
                        {{ missing: "缺失", suspect: "存疑", valid: "有效" }[
                          o.quality_status
                        ] || "状态未知"}
                      </small>
                    </div>
                    <span>
                      {o.quality_status === "valid" ? numeric(o.value) : "—"}{" "}
                      <small>{o.unit}</small>
                    </span>
                  </div>
                ))}
              </div>
            </Status>
          </>
        )}
      </Status>
      <p className="public-notice">
        这里展示科普模拟观测，不代表真实环境。缺失值保留为空缺，不输出官方水质类别；完整窗口、来源与批次可在数据中心查看。
      </p>
    </section>
  );
}
export function DetailPage() {
  const { kind, id } = useParams(),
    { user } = useAuth(),
    navigate = useNavigate(),
    location = useLocation();
  const path = { content: "contents/", place: "places/", route: "routes/" }[
    kind
  ];
  const resource = useRemote(
    (signal) => {
      if (!path || !id) throw new Error("此资料链接无效");
      return api(path + encodeURIComponent(id) + "/", { signal }).then(
        (r) => r.data,
      );
    },
    [path, id],
  );
  const item = resource.data;
  const related = useRemote(
    (signal) =>
      kind === "place" && item
        ? api("web/blog/posts/", { data: { place: id, page_size: 3 }, signal })
        : null,
    [kind, id, item?.id],
  );
  const [favorite, setFavorite] = useState(""),
    [busy, setBusy] = useState(false),
    [recordError, setRecordError] = useState(""),
    [notice, setNotice] = useState(""),
    [visitOpen, setVisitOpen] = useState(false),
    [stopIndex, setStopIndex] = useState(0);
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const actionScope = useRef("");
  actionScope.current = (user?.id || "") + ":" + kind + ":" + id;
  const target = kind === "place" ? { place_id: id } : { content_id: id };
  useEffect(() => {
    setStopIndex(0);
    setNotice("");
    setRecordError("");
    setVisitOpen(false);
    setFavorite("");
    setBusy(false);
  }, [kind, id]);
  useEffect(() => {
    setFavorite("");
    setRecordError("");
    if (!user?.id || !item || kind === "route") return;
    const c = new AbortController();
    let active = true;
    const uid = user.id;
    loadAll(api, "favorites/", target, c.signal)
      .then(async (favorites) => {
        if (!active || identity.current !== uid) return;
        const found = favorites.find(
          (f) =>
            f[kind + "_id"] === id ||
            (typeof f[kind] === "string" ? f[kind] === id : f[kind]?.id === id),
        );
        setFavorite(found?.id || "");
        if (user.record_history)
          await api("histories/", {
            method: "POST",
            data: target,
            signal: c.signal,
          });
      })
      .catch((e) => {
        if (active && e.name !== "AbortError" && identity.current === uid)
          setRecordError(errorText(e));
      });
    return () => {
      active = false;
      c.abort();
    };
  }, [user?.id, user?.record_history, item?.id, kind, id]);
  function requireUser() {
    if (user) return true;
    navigate("/login?next=" + encodeURIComponent(location.pathname));
    return false;
  }
  async function favoriteAction() {
    if (busy || !requireUser()) return;
    const uid = user.id,
      scope = actionScope.current;
    setBusy(true);
    setRecordError("");
    try {
      let next = "";
      if (favorite)
        await api("favorites/" + favorite + "/", { method: "DELETE" });
      else
        next = (await api("favorites/", { method: "POST", data: target })).data
          .id;
      if (identity.current === uid && actionScope.current === scope) {
        setFavorite(next);
        setNotice(next ? "已收藏" : "已取消收藏");
      }
    } catch (e) {
      if (identity.current === uid && actionScope.current === scope)
        setRecordError(errorText(e));
    } finally {
      if (actionScope.current === scope) setBusy(false);
    }
  }
  async function recordVisit() {
    if (busy || !requireUser()) return;
    const uid = user.id,
      scope = actionScope.current;
    setBusy(true);
    setRecordError("");
    try {
      await api("visits/", { method: "POST", data: { place_id: id } });
      if (identity.current === uid && actionScope.current === scope) {
        setNotice("已记录游览");
        setVisitOpen(false);
      }
    } catch (e) {
      if (identity.current === uid && actionScope.current === scope)
        setRecordError(errorText(e));
    } finally {
      if (actionScope.current === scope) setBusy(false);
    }
  }
  const stops = useMemo(() => publicStops(item), [item]);
  const activeStop = stops[stopIndex] || stops[0];
  return (
    <main className="public-page detail-page">
      <div className="public-breadcrumb">
        <Link
          to={
            kind === "place"
              ? "/explore"
              : "/learn" + (kind === "route" ? "?tab=routes" : "")
          }
        >
          <ArrowLeft size={16} />
          {kind === "place" ? "生态导览" : "科普智游"}
        </Link>
        <span>/</span>
        <span>
          {kind === "content"
            ? "科普手记"
            : kind === "place"
              ? "生态地点"
              : "漫步路线"}
        </span>
      </div>
      <Status
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.reload}
        empty={!item}
      >
        {item && (
          <>
            <div className="public-article-heading">
              <div className="public-section-line">
                <span className="public-eyebrow">
                  {kind === "content"
                    ? "NATURE JOURNAL"
                    : kind === "place"
                      ? "ECO DESTINATION"
                      : "WALKING ROUTE"}
                </span>
                {kind === "content" && (
                  <button
                    className={
                      "pub-btn outline " + (favorite ? "is-favorite" : "")
                    }
                    disabled={busy}
                    onClick={favoriteAction}
                  >
                    <Star size={17} fill={favorite ? "currentColor" : "none"} />
                    {favorite ? "已收藏" : "收藏"}
                  </button>
                )}
              </div>
              <h1>{item.name || item.title}</h1>
              <div className="public-article-meta">
                {item.is_demo && <Tag>科普模拟资料</Tag>}
                {kind === "content" && (
                  <span>{CATEGORY_NAMES[item.category] || "自然见闻"}</span>
                )}
                <span>{item.region_name}</span>
                <span>{formatTime(item.updated_at || item.published_at)}</span>
              </div>
            </div>
            {(kind === "content" || kind === "route") && (
              <Narration kind={kind} id={item.id} />
            )}
            <div
              className={
                "public-detail-layout " +
                (kind === "content" ? "article-layout" : "")
              }
            >
              <article className="public-reading-card">
                <p className="public-article-lede">
                  {item.description || item.summary || "暂无简介"}
                </p>
                {kind === "content" && (
                  <>
                    <div className="public-article-body">
                      <Markdown text={item.body || ""} />
                    </div>
                    <footer className="public-article-source">
                      <p>资料来源：{item.source || "尚未填写出处"}</p>
                      <p>
                        更新：{formatTime(item.updated_at || item.published_at)}
                      </p>
                      {item.source_url && <SourceLink url={item.source_url} />}
                    </footer>
                  </>
                )}
                {kind === "place" && (
                  <div className="public-place-source">
                    <p>所属区域：{item.region_name}</p>
                    <p>资料说明：{item.source_note || "尚未填写资料说明"}</p>
                  </div>
                )}
              </article>
              {kind === "place" && item.is_demo === false && (
                <aside className="public-detail-aside">
                  <MapPin size={25} strokeWidth={1.4} />
                  <h2>实地浏览</h2>
                  {item.access_note && <p>{item.access_note}</p>}
                  <SourceLink url={item.source_url} />
                  <NavigationLinks item={item} />
                  <p className="public-small public-muted">
                    {navigable(item)
                      ? "使用已核验的地点坐标打开地图；开放范围以现场公告为准。"
                      : "地点坐标尚待核验，暂不提供导航。"}
                  </p>
                </aside>
              )}
            </div>
            {kind === "content" && <BlogComments key={id} kind="content" id={id} />}
            {kind === "route" && (
              <section className="public-detail-section">
                <div className="public-section-line">
                  <h2>沿途停留</h2>
                  <span className="public-muted">
                    {stops.length} 个公开节点
                  </span>
                </div>
                <p className="public-small public-muted">
                  所属区域：{item.region_name || "以地点资料为准"} · 路线出处：
                  {item.source || "尚未填写出处"}
                </p>
                {!stops.length ? (
                  <p className="public-notice">
                    此路线暂没有可浏览的公开节点。节点调整或下架后不会继续显示其资料。
                  </p>
                ) : (
                  <div className="public-route-layout">
                    <div className="public-route-stops">
                      {stops.map((stop, i) => (
                        <button
                          key={stop.id}
                          className={
                            "public-route-stop " +
                            (activeStop?.id === stop.id ? "active" : "")
                          }
                          onClick={() => setStopIndex(i)}
                        >
                          <span>{String(stop.position).padStart(2, "0")}</span>
                          <div>
                            <strong>{stop.place.name}</strong>
                            <p>{stop.note || stop.place.description}</p>
                          </div>
                          <ArrowRight size={16} />
                        </button>
                      ))}
                    </div>
                    {activeStop && (
                      <article className="public-stop-detail">
                        <Tag>
                          浏览第 {activeStop.position} / {stops.length} 站
                        </Tag>
                        <h2>{activeStop.place.name}</h2>
                        <p>{activeStop.note || activeStop.place.description}</p>
                        <div className="public-actions">
                          <button
                            className="pub-btn outline"
                            disabled={stopIndex === 0}
                            onClick={() => setStopIndex((i) => i - 1)}
                          >
                            <ArrowLeft size={15} />
                            上一站
                          </button>
                          <button
                            className="pub-btn outline"
                            disabled={stopIndex === stops.length - 1}
                            onClick={() => setStopIndex((i) => i + 1)}
                          >
                            下一站
                            <ArrowRight size={15} />
                          </button>
                        </div>
                        <Link
                          className="pub-btn"
                          to={"/detail/place/" + activeStop.place.id}
                        >
                          查看此地点详情
                          <ArrowUpRight size={15} />
                        </Link>
                        <p className="public-small public-muted">
                          选择节点仅切换浏览内容，不记录到访。
                        </p>
                      </article>
                    )}
                  </div>
                )}
                <Link
                  className="public-text-link"
                  to={
                    "/learn?" +
                    new URLSearchParams({
                      tab: "routes",
                      region: item.region || "",
                    })
                  }
                >
                  返回本区域的路线列表 <ArrowUpRight size={15} />
                </Link>
                <p className="public-notice">
                  路线为管理员预设，不包含实时导航或到访核验；实际出行需自行核实开放范围和天气。
                </p>
              </section>
            )}
            {kind === "content" && (item.place_summary || item.plant_label) && (
              <section className="public-detail-section public-continue">
                <h2>继续探索</h2>
                <div className="public-actions">
                  {item.place_summary && (
                    <Link
                      className="pub-btn outline"
                      to={"/detail/place/" + item.place_summary.id}
                    >
                      <MapPin size={16} />
                      关联地点 · {item.place_summary.name}
                      <ArrowUpRight size={15} />
                    </Link>
                  )}
                  {item.plant_label && (
                    <Link
                      className="pub-btn outline"
                      to={
                        "/learn?region=&plant_label=" +
                        encodeURIComponent(item.plant_label)
                      }
                    >
                      <Leaf size={16} />
                      查看同类植物的科普
                      <ArrowUpRight size={15} />
                    </Link>
                  )}
                </div>
              </section>
            )}
            {kind === "place" && (
              <>
                <section className="public-detail-section">
                  <div className="public-section-line">
                    <h2>与此处相关的科普</h2>
                    {related.data?.meta?.count > 0 && (
                      <span className="public-muted">
                        {related.data.meta.count} 篇
                      </span>
                    )}
                  </div>
                  <Status
                    loading={related.loading}
                    error={related.error}
                    empty={!related.data?.data?.length}
                    emptyText="此地点暂无公开关联文章。"
                    onRetry={related.reload}
                  >
                    <div className="public-content-grid related-content-grid">
                      {related.data?.data?.map((content, i) => (
                        <ContentCard
                          key={content.id}
                          item={content}
                          index={i}
                        />
                      ))}
                    </div>
                    <Link
                      className="public-text-link"
                      to={
                        "/learn?" +
                        new URLSearchParams({
                          region: item.region || "",
                          place: id,
                        })
                      }
                    >
                      在科普页浏览全部关联文章 <ArrowUpRight size={15} />
                    </Link>
                  </Status>
                </section>
                {item.is_demo !== false && item.water_body_id && (
                  <Link
                    className="pub-btn"
                    to={
                      "/water/" +
                      item.water_body_id +
                      "?region=" +
                      encodeURIComponent(item.region)
                    }
                  >
                    查看此水体的指标与趋势 <ArrowRight size={16} />
                  </Link>
                )}
                <div className="public-detail-actions">
                  <button
                    className="pub-btn outline"
                    disabled={busy}
                    onClick={favoriteAction}
                  >
                    <Star size={17} fill={favorite ? "currentColor" : "none"} />
                    {favorite ? "取消收藏" : "收藏资料"}
                  </button>
                  <button
                    className="pub-btn"
                    disabled={busy}
                    onClick={() => {
                      if (requireUser()) setVisitOpen(true);
                    }}
                  >
                    <Check size={17} />
                    记录游览
                  </button>
                </div>
                {item.is_demo !== false && <PlaceObservations item={item} />}
              </>
            )}
            {notice && (
              <p className="public-success" role="status">
                <Check size={17} />
                {notice}
              </p>
            )}
            {recordError && (
              <p className="public-inline-error" role="alert">
                个人记录同步失败：{recordError}
              </p>
            )}
            <AIButton
              floating
              context={{
                scope: kind === "place" ? "explore" : "learn",
                source_type: kind,
                source_id: item.id,
              }}
            />
            {visitOpen && (
              <Modal title="记录这次游览" onClose={() => setVisitOpen(false)}>
                <p>
                  这是一条由你自行添加的游览记录，不使用定位，也不证明真实到访。
                </p>
                <div className="public-actions">
                  <button
                    className="pub-btn outline"
                    onClick={() => setVisitOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    className="pub-btn"
                    disabled={busy}
                    onClick={recordVisit}
                  >
                    {busy ? "正在记录…" : "添加记录"}
                  </button>
                </div>
              </Modal>
            )}
          </>
        )}
      </Status>
    </main>
  );
}

function Trend({ entry, window }) {
  const [table, setTable] = useState(false);
  const geometry = useMemo(
    () => chartGeometry(entry.points, window),
    [entry, window?.start, window?.end],
  );
  return (
    <div className="public-trend">
      <div className="public-quality-line">
        <span className="quality-valid">
          有效 {entry.summary?.valid_count || 0}
        </span>
        <span>缺测 {entry.summary?.missing_count || 0}</span>
        <span>存疑 {entry.summary?.suspect_count || 0}</span>
        <button
          className="public-text-button"
          onClick={() => setTable((v) => !v)}
        >
          {table ? "收起明细" : "查看明细"}
          <ChevronDown size={14} />
        </button>
      </div>
      {geometry ? (
        <svg
          className="public-trend-svg"
          viewBox={"0 0 " + geometry.width + " " + geometry.height}
          role="img"
          aria-label={entry.metric?.name + "的变化趋势，缺测和存疑数据不连线"}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const y =
              geometry.plot.top +
              (geometry.plot.bottom - geometry.plot.top) * f;
            return (
              <g key={f}>
                <line
                  x1={geometry.plot.left}
                  y1={y}
                  x2={geometry.plot.right}
                  y2={y}
                  className="chart-grid"
                />
                <text x={geometry.plot.left - 10} y={y + 4} textAnchor="end">
                  {numeric(geometry.max - (geometry.max - geometry.min) * f)}
                </text>
              </g>
            );
          })}
          {geometry.segments.map((segment, i) => (
            <g key={i}>
              {segment.length > 1 && (
                <polyline
                  className="chart-series"
                  points={segment.map((p) => p.x + "," + p.y).join(" ")}
                />
              )}{" "}
              {segment.map((p, j) => (
                <circle
                  key={j}
                  className="chart-point"
                  cx={p.x}
                  cy={p.y}
                  r={segment.length === 1 ? 3 : 2}
                >
                  <title>
                    {formatTime(p.point.at)}：{numeric(p.point.value)}{" "}
                    {entry.metric?.unit}
                  </title>
                </circle>
              ))}
            </g>
          ))}
          <text x={geometry.plot.left} y={geometry.height - 9}>
            {formatTime(geometry.start)}
          </text>
          <text
            x={geometry.plot.right}
            y={geometry.height - 9}
            textAnchor="end"
          >
            {formatTime(geometry.end)}
          </text>
        </svg>
      ) : (
        <div className="public-state">
          所选范围暂无可绘制的有效观测，数据空缺不会填成 0。
        </div>
      )}
      <p className="public-small public-muted">
        缺测、存疑数据保持断线；图表只连接连续有效观测。
      </p>
      {table && (
        <div className="public-table-wrap">
          <table className="public-data-table">
            <thead>
              <tr>
                <th>观测时间</th>
                <th>数值 · {entry.metric?.unit || "无量纲"}</th>
                <th>最小—最大</th>
                <th>质量状态</th>
              </tr>
            </thead>
            <tbody>
              {(entry.points || []).slice(0, 240).map((p, i) => (
                <tr key={p.at || i}>
                  <td>{formatTime(p.at)}</td>
                  <td>{validPoint(p) ? numeric(p.value) : "—"}</td>
                  <td>
                    {validPoint(p)
                      ? numeric(p.min) + " — " + numeric(p.max)
                      : "—"}
                  </td>
                  <td>
                    {p.quality_status === "suspect"
                      ? "存疑，未连线"
                      : validPoint(p)
                        ? "有效"
                        : "缺测，未连线"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function SeriesPage({ waterMode = false }) {
  const { id: waterId } = useParams(),
    [params] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    region: params.get("region") || (waterMode && waterId ? "" : savedRegion()),
    kind: params.get("kind") || "water",
    water: waterId || "",
    station: params.get("stationId") || "",
    source: "",
    scenario: "",
    run: "",
    hours: 48,
  }));
  const [advanced, setAdvanced] = useState(false),
    [provenance, setProvenance] = useState(false),
    [metric, setMetric] = useState("");
  useEffect(() => {
    if (waterId)
      setFilters((f) => ({ ...f, water: waterId, station: "", run: "" }));
  }, [waterId]);
  const change = (values) => setFilters((f) => ({ ...f, ...values }));
  const dataset = useRemote(
    async (signal) => {
      const [regions, sources] = await Promise.all([
        loadAll(api, "regions/", {}, signal),
        loadAll(api, "data-sources/", {}, signal),
      ]);
      let preferredRegion = filters.region;
      if (waterMode && filters.water && !preferredRegion) {
        const water = (
          await api("water-bodies/" + encodeURIComponent(filters.water) + "/", {
            signal,
          })
        ).data;
        preferredRegion = water?.region;
      }
      const region =
        regions.find(
          (r) => r.id === preferredRegion || r.slug === preferredRegion,
        ) ||
        regions.find((r) => r.slug === "tianjin-nature") ||
        regions[0];
      const source =
        sources.find((s) => s.id === filters.source) ||
        sources.find(
          (s) => s.kind === "simulation" && s.code === "demo-normal",
        ) ||
        sources.find((s) => s.kind === "simulation") ||
        sources[0];
      const state = {
        regions,
        sources,
        region,
        source,
        waterBodies: [],
        stations: [],
        scenarios: [],
        runs: [],
        run: null,
        view: null,
        notice: "",
      };
      if (!region) {
        state.notice = "暂无示范区域，请管理员初始化数据。";
        return state;
      }
      if (waterMode) {
        state.waterBodies = await loadAll(
          api,
          "water-bodies/",
          { region: region.id },
          signal,
        );
        state.water =
          state.waterBodies.find((w) => w.id === filters.water) ||
          state.waterBodies[0];
        if (!state.water) {
          state.notice = "该区域暂无已公开水体。";
          return state;
        }
      }
      const stationQuery = {
        region: region.id,
        kind: waterMode ? "water" : filters.kind,
      };
      if (waterMode) stationQuery.water_body = state.water.id;
      state.stations = await loadAll(api, "stations/", stationQuery, signal);
      state.station =
        state.stations.find((s) => s.id === filters.station) ||
        state.stations[0];
      if (!state.station) {
        state.notice = "当前选择暂无公开监测站。";
        return state;
      }
      if (!source) {
        state.notice = "暂无已启用数据源。";
        return state;
      }
      if (source.kind === "simulation") {
        const allRuns = await loadAll(
          api,
          "simulation-runs/",
          { region: region.id, station: state.station.id, source: source.id },
          signal,
        );
        state.scenarios = [
          ...new Map(
            allRuns
              .filter((r) => r.scenario?.code)
              .map((r) => [
                r.scenario.code,
                { id: r.scenario.code, name: r.scenario.name },
              ]),
          ).values(),
        ];
        state.scenario =
          state.scenarios.find((s) => s.id === filters.scenario) ||
          state.scenarios.find((s) => s.id === "normal") ||
          state.scenarios[0];
        state.runs = allRuns.filter(
          (r) => r.scenario?.code === state.scenario?.id,
        );
        state.run =
          state.runs.find((r) => r.id === filters.run) || state.runs[0];
        if (!state.run) {
          state.notice = "该监测站与来源暂无成功模拟批次，请管理员生成后刷新。";
          return state;
        }
      }
      const window = rangeQuery(state.run, Number(filters.hours));
      const maxPoints = Math.min(
        240,
        Math.max(
          1,
          Math.ceil(
            (Date.parse(window.end) - Date.parse(window.start)) / 3600000,
          ),
        ),
      );
      const query = {
        region: region.id,
        station: state.station.id,
        source_type: source.kind,
        source: source.id,
        max_points: maxPoints,
        ...window,
      };
      if (state.run) query.simulation_run = state.run.id;
      if (waterMode)
        query.metrics = "water_temperature,ph,turbidity,dissolved_oxygen";
      state.view = (
        await api("observation-series/", { data: query, signal })
      ).data;
      return state;
    },
    [JSON.stringify(filters), waterMode],
  );
  const data = dataset.data;
  const entry =
    data?.view?.series?.find((e) => e.metric?.code === metric) ||
    data?.view?.series?.[0];
  useEffect(() => {
    if (data?.region) saveRegion(data.region);
  }, [data?.region?.id]);
  return (
    <main className="public-page measurement-page">
      <Heading
        eyebrow={waterMode ? "WATER OBSERVATORY" : "ECO OBSERVATORY"}
        title={waterMode ? "智慧河湖" : "数据中心"}
      />
      <div className="public-learning-note">
        <span>
          <Droplets size={18} />
          科普模拟体验
        </span>
        <p>
          模拟数据帮助理解指标变化；缺测、存疑数据保持断线，不用于认定水质等级或官方
          AQI。
        </p>
      </div>
      <section className="public-filter-card measurement-filters">
        <div className="public-section-line">
          <h2>选择观测范围</h2>
          <span className="public-small public-muted">按需切换</span>
        </div>
        <div className="public-filter-grid four">
          <Field
            label="区域"
            value={data?.region?.id || filters.region}
            options={(data?.regions || []).map((r) => ({
              ...r,
              name: cityName(r),
            }))}
            disabled={dataset.loading}
            onChange={(region) =>
              change({ region, station: "", water: "", run: "", scenario: "" })
            }
          />
          {waterMode ? (
            <Field
              label="河流 / 湖泊"
              value={data?.water?.id || ""}
              options={data?.waterBodies || []}
              disabled={dataset.loading}
              onChange={(water) =>
                change({ water, station: "", run: "", scenario: "" })
              }
              empty="暂无公开水体"
            />
          ) : (
            <Field
              label="指标类别"
              value={filters.kind}
              options={KINDS}
              disabled={dataset.loading}
              onChange={(kind) =>
                change({ kind, station: "", run: "", scenario: "" })
              }
            />
          )}
          <Field
            label="监测站"
            value={data?.station?.id || ""}
            options={data?.stations || []}
            disabled={dataset.loading}
            onChange={(station) => change({ station, run: "", scenario: "" })}
            empty="暂无监测站"
          />
          <Field
            label="时间范围"
            value={filters.hours}
            options={RANGES}
            disabled={dataset.loading}
            onChange={(hours) => change({ hours: Number(hours) })}
          />
        </div>
        <button
          className="public-expand-row"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
        >
          <span>数据来源与批次</span>
          <span>{advanced ? "收起 −" : "更多筛选 ＋"}</span>
        </button>
        {!advanced && (
          <p className="public-small public-muted">
            {data?.source
              ? data.source.name +
                " · " +
                (SOURCE_NAMES[data.source.kind] || "未知来源")
              : "暂无数据来源"}
            {data?.run?.scenario ? " · " + data.run.scenario.name : ""}
          </p>
        )}
        {advanced && (
          <>
            <div className="public-filter-grid three">
              <Field
                label="数据来源"
                value={data?.source?.id || ""}
                options={(data?.sources || []).map((s) => ({
                  ...s,
                  name: s.name + " · " + (SOURCE_NAMES[s.kind] || "未知来源"),
                }))}
                disabled={dataset.loading}
                onChange={(source) => change({ source, run: "", scenario: "" })}
              />
              {data?.source?.kind === "simulation" && (
                <>
                  <Field
                    label="模拟场景"
                    value={data?.scenario?.id || ""}
                    options={data?.scenarios || []}
                    disabled={dataset.loading}
                    onChange={(scenario) => change({ scenario, run: "" })}
                  />
                  <Field
                    label="观测批次 · 生成时间与编号"
                    value={data?.run?.id || ""}
                    options={(data?.runs || []).map((r) => ({
                      ...r,
                      name:
                        formatTime(r.created_at || r.end) +
                        " · " +
                        r.id.slice(0, 8),
                    }))}
                    disabled={dataset.loading}
                    onChange={(run) => change({ run })}
                  />
                </>
              )}
            </div>
            <p className="public-small public-muted">
              模拟数据按所选批次结束时间回看，其他来源按当前时间回看。统计范围包含起始时刻，不包含结束时刻。
            </p>
          </>
        )}
      </section>
      <Status
        loading={dataset.loading}
        error={dataset.error}
        onRetry={dataset.reload}
        empty={!data?.view}
        emptyText={data?.notice || "当前选择暂无数据，试试其他站点或时间范围。"}
      >
        {data?.view && (
          <>
            <div className="public-section-line observation-heading">
              <div>
                <h2>这一刻的观测</h2>
                <p className="public-small public-muted">
                  {data.station?.name} · 点击指标卡切换趋势
                </p>
              </div>
              <Tag>{SOURCE_NAMES[data.view.source_type] || "来源待确认"}</Tag>
            </div>
            {data.view.status === "unavailable" && (
              <p className="public-notice">
                这个站点在所选范围内还没有观测记录，可调整筛选；数据空缺不会填成
                0。
              </p>
            )}
            <div className="public-metric-grid">
              {data.view.series?.map((s, i) => (
                <button
                  key={s.metric?.code || i}
                  className={"public-metric " + (s === entry ? "active" : "")}
                  onClick={() => setMetric(s.metric.code)}
                >
                  <span>
                    {s.metric?.name}
                    <i />
                  </span>
                  <strong>
                    {s.latest?.quality_status === "valid"
                      ? numeric(s.latest.value)
                      : "—"}
                    <small>{s.metric?.unit}</small>
                  </strong>
                  <span className="public-small">
                    最新观测 ·{" "}
                    {{ valid: "有效", missing: "缺测", suspect: "存疑" }[
                      s.latest?.quality_status
                    ] || "暂无观测"}
                  </span>
                  <time>{formatTime(s.latest?.observed_at)}</time>
                </button>
              ))}
            </div>
            {entry && (
              <section className="public-trend-card">
                <div className="public-section-line">
                  <h2>变化趋势</h2>
                  <span className="public-small public-muted">
                    {entry.metric?.unit || "无量纲"}
                  </span>
                </div>
                <Field
                  label="观测指标"
                  value={entry.metric?.code || ""}
                  options={(data.view.series || []).map((s) => ({
                    id: s.metric.code,
                    name: s.metric.name,
                  }))}
                  onChange={setMetric}
                />
                <div className="public-stats">
                  {[
                    ["最低", entry.summary?.min],
                    ["最高", entry.summary?.max],
                    ["均值", entry.summary?.mean],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <strong>{numeric(value)}</strong>
                    </div>
                  ))}
                </div>
                <Trend entry={entry} window={data.view.window} />
              </section>
            )}
            <section className="public-provenance">
              <button
                className="public-expand-row"
                onClick={() => setProvenance((v) => !v)}
                aria-expanded={provenance}
              >
                <h2>数据从哪里来</h2>
                <span>{provenance ? "收起 −" : "查看 ＋"}</span>
              </button>
              <p>{data.view.source?.name || "该范围暂无来源记录"}</p>
              <p className="public-small public-muted">
                {formatTime(data.view.window?.start)} 至{" "}
                {formatTime(data.view.window?.end)}
              </p>
              {provenance && (
                <dl>
                  <dt>汇总粒度</dt>
                  <dd>
                    {typeof data.view.bucket_seconds === "number"
                      ? numeric(data.view.bucket_seconds / 60) + " 分钟 / 桶"
                      : "时间桶未提供"}
                  </dd>
                  {data.run && (
                    <>
                      <dt>场景</dt>
                      <dd>{data.run.scenario?.name}</dd>
                      <dt>批次</dt>
                      <dd>{data.view.simulation_run_id}</dd>
                      <dt>生成时间</dt>
                      <dd>{formatTime(data.run.created_at)}</dd>
                      <dt>批次范围</dt>
                      <dd>
                        {formatTime(data.run.start)} 至{" "}
                        {formatTime(data.run.end)}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </section>
            {data.view.notice && (
              <p className="public-notice">{data.view.notice}</p>
            )}
          </>
        )}
      </Status>
      <p className="public-footnote">HYHQ · 让每一次观察有迹可循</p>
      {data?.region &&
        !dataset.loading &&
        !dataset.error &&
        (waterMode ? data.water : true) && (
          <AIButton
            floating
            context={{
              scope: "explore",
              source_type: waterMode ? "water" : "region",
              source_id: waterMode ? data.water.id : data.region.id,
            }}
          />
        )}
    </main>
  );
}
export function DataCenterPage() {
  return <SeriesPage />;
}
export function WaterPage() {
  return <SeriesPage waterMode />;
}
