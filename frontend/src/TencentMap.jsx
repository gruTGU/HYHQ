import React, { useEffect, useRef, useState } from "react";
import { api } from "./lib/api.js";
import { cityName } from "./pages/public-domain.js";
import { createTencentController, loadTencentMaps, mapConfiguration } from "./lib/tencent-map.js";

export default function TencentMap({ fallback: Fallback, ...props }) {
  const [config, setConfig] = useState(null), [state, setState] = useState("loading"), [attempt, setAttempt] = useState(0), [useFallback, setFallback] = useState(false);
  const element = useRef(null), controller = useRef(null), failure = useRef(null), latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    let alive = true;
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 8000);
    setState("loading");
    api("web/map-config/", { signal: abort.signal }).then(result => {
      if (alive) { const next = mapConfiguration(result.data); setConfig(next); if (next.provider !== "tencent") setFallback(true); }
    }).catch(() => { if (alive) setState("error"); }).finally(() => clearTimeout(timeout));
    return () => { alive = false; abort.abort(); clearTimeout(timeout); };
  }, [attempt]);
  useEffect(() => {
    if (!config || config.provider !== "tencent" || useFallback) return;
    let alive = true, tilesTimer, loaded = false, failed = false, ownedController = null;
    const release = () => {
      const owned = ownedController;
      ownedController = null;
      if (controller.current === owned) controller.current = null;
      try { owned?.destroy(); } catch (_) { /* Keep the error controls available after SDK cleanup failure. */ }
    };
    const fail = () => {
      if (!alive || failed) return;
      failed = true;
      clearTimeout(tilesTimer);
      release();
      setState("error");
    };
    failure.current = fail;
    setState("loading");
    loadTencentMaps(config.js_key).then(TMap => {
      if (!alive || !element.current) return;
      ownedController = createTencentController(TMap, element.current, {
        onSelect: point => latest.current.onSelect?.(point),
        onLoaded: () => { if (alive && !failed) { loaded = true; clearTimeout(tilesTimer); setState("ready"); } },
        onUnavailable: fail,
      });
      if (!alive || failed) { release(); return; }
      controller.current = ownedController;
      ownedController.update(latest.current);
      if (!loaded) tilesTimer = setTimeout(() => { if (alive && !failed) setState("slow"); }, 12000);
    }).catch(fail);
    return () => { alive = false; clearTimeout(tilesTimer); release(); if (failure.current === fail) failure.current = null; };
  }, [config?.provider, config?.js_key, useFallback, attempt]);
  useEffect(() => {
    try { controller.current?.update(props); }
    catch (_) { failure.current?.(); }
  }, [props.region, props.points, props.rivers, props.selected, props.position, props.resetToken]);
  if (useFallback && Fallback) return <Fallback {...props} />;
  const unavailable = state === "error" || state === "slow" || useFallback;
  return (
    <div className="public-map-wrap">
      <div ref={element} className="public-real-map" style={{ touchAction: "none", position: "relative" }} role="region" aria-label={cityName(props.region) + "生态地点地图"} />
      {state === "loading" && !useFallback && <div className="public-map-warning" role="status">正在载入地图…</div>}
      {unavailable && <div className="public-map-warning" role="status">
        <p style={{ margin: "0 0 10px" }}>地图暂时无法显示，可以继续浏览地点列表。</p>
        <button type="button" className="pub-btn outline" onClick={() => { setConfig(null); setFallback(false); setAttempt(n => n + 1); }}>重新加载</button>
        {Fallback && <button type="button" className="pub-btn outline" style={{ marginLeft: 8 }} onClick={() => setFallback(true)}>使用备用地图</button>}
      </div>}
      <div className="public-map-legend">
        <span><i className="water" />河湖</span><span><i />公园 / 地标</span><span><i className="campus" />校园</span>
      </div>
    </div>
  );
}
