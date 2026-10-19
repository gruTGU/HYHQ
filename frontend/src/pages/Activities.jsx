import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, CalendarDays, Check, Flower2, MapPin } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../state";
import { Modal, PageHeader, State } from "../components";
import {
  ACTIVITY_NOTE,
  activityRows,
  chinaDay,
  eventEnded,
  eventDateLabel,
  eventInMonth,
  eventLocationLink,
  eventPlace,
  upcomingEvents,
} from "./activity-domain";
import "./Activities.css";

const ActivityContext = createContext(null);
const shownInSession = new Set();

export function ActivityProvider({ children }) {
  const { user } = useAuth();
  const [preferences, setPreferences] = useState(null);
  const [subscriptions, setSubscriptions] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const identity = useRef(user?.id);
  identity.current = user?.id;

  useEffect(() => {
    const controller = new AbortController(),
      owner = user?.id;
    setDialog(null);
    setPreferences(null);
    setSubscriptions([]);
    setError("");
    setBusy(false);
    if (!owner) return () => controller.abort();
    Promise.all([
      api("event-notifications/", { signal: controller.signal }),
      api("event-subscriptions/", { signal: controller.signal }),
    ])
      .then(async ([prefs, subs]) => {
        if (controller.signal.aborted || identity.current !== owner) return;
        setPreferences(prefs.data);
        setSubscriptions(activityRows(subs));
        const key = owner + ":" + chinaDay();
        if (shownInSession.has(key)) return;
        const prompted =
          prefs.data?.prompted ??
          prefs.data?.has_decided ??
          typeof prefs.data?.enabled === "boolean";
        if (!prompted) {
          shownInSession.add(key);
          setDialog("permission");
        } else if (
          prefs.data?.enabled &&
          prefs.data?.last_shown_date !== chinaDay()
        ) {
          const response = await api("event-notifications/claim/", {
            method: "POST",
            data: {},
            signal: controller.signal,
          });
          if (controller.signal.aborted || identity.current !== owner) return;
          const upcoming =
            response.data?.daily_events || response.data?.upcoming || [];
          setPreferences(response.data);
          if (response.data?.should_notify && upcoming.length) {
            shownInSession.add(key);
            setEvents(upcoming);
            setDialog("today");
          }
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && identity.current === owner)
          setError(e.message);
      });
    return () => controller.abort();
  }, [user?.id, revision]);

  async function preference(enabled) {
    if (!user || busy) return false;
    const owner = user.id;
    setBusy(true);
    setError("");
    try {
      const response = await api("event-notifications/", {
        method: "PATCH",
        data: { enabled },
      });
      if (identity.current !== owner) return false;
      setPreferences(response.data);
      setDialog(null);
      if (enabled) {
        const claim = await api("event-notifications/claim/", {
          method: "POST",
          data: {},
        });
        if (identity.current !== owner) return false;
        setPreferences(claim.data);
        const upcoming = claim.data?.daily_events || claim.data?.upcoming || [];
        if (claim.data?.should_notify && upcoming.length) {
          setEvents(upcoming);
          setDialog("today");
        }
      }
      return true;
    } catch (e) {
      if (identity.current === owner) setError(e.message);
      return false;
    } finally {
      if (identity.current === owner) setBusy(false);
    }
  }

  async function subscribe(event) {
    if (!user || busy) return;
    const owner = user.id,
      subscribed = subscriptions.some(
        (s) => (s.event_id || s.event?.id || s.id) === event.id,
      );
    setBusy(true);
    setError("");
    try {
      if (subscribed)
        await api("event-subscriptions/" + encodeURIComponent(event.id) + "/", {
          method: "DELETE",
        });
      else
        await api("event-subscriptions/", {
          method: "POST",
          data: { event_id: event.id },
        });
      const response = await api("event-subscriptions/");
      if (identity.current === owner) setSubscriptions(activityRows(response));
    } catch (e) {
      if (identity.current === owner) setError(e.message);
    } finally {
      if (identity.current === owner) setBusy(false);
    }
  }

  return (
    <ActivityContext.Provider
      value={{
        preferences,
        subscriptions,
        busy,
        error,
        preference,
        subscribe,
        retry: () => setRevision((v) => v + 1),
      }}
    >
      {children}
      {user && dialog === "permission" && (
        <Modal
          title="想收到身边的活动提醒吗？"
          className="activity-dialog"
          onClose={() => {
            if (!busy) preference(false);
          }}
        >
          <div className="activity-dialog-art">
            <Flower2 size={38} strokeWidth={1.4} />
          </div>
          <p>
            把花季漫步、自然观察和河岸守护加入日常。开启后，登录时会显示今日和近期的地方模拟活动，每天最多一次。
          </p>
          <p className="activity-note">
            仅站内提醒，不申请手机或浏览器通知权限。可随时在「我的 →
            地方活动」关闭。
          </p>
          <SimulationNote />
          {error && (
            <p role="alert" className="activity-error">
              {error}
            </p>
          )}
          <div className="activity-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() => preference(true)}
            >
              <Bell size={16} />
              开启站内提醒
            </button>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => preference(false)}
            >
              暂不开启
            </button>
          </div>
        </Modal>
      )}
      {user && dialog === "today" && (
        <Modal
          title="今日与近期 · 地方活动"
          className="activity-dialog"
          onClose={() => setDialog(null)}
        >
          <SimulationNote />
          <div className="activity-list">
            {events.slice(0, 3).map((event) => (
              <EventCard
                key={event.id}
                event={event}
                compact
                onNavigate={() => setDialog(null)}
              />
            ))}
          </div>
          {error && (
            <p role="alert" className="activity-error">
              {error}
            </p>
          )}
          <div className="activity-actions">
            <Link
              className="btn"
              to="/activities"
              onClick={() => setDialog(null)}
            >
              查看全年活动
            </Link>
            <button className="btn secondary" onClick={() => setDialog(null)}>
              知道了
            </button>
          </div>
        </Modal>
      )}
    </ActivityContext.Provider>
  );
}

export function SimulationNote() {
  return (
    <p className="activity-simulation">
      <span>模拟演示</span>
      {ACTIVITY_NOTE}
    </p>
  );
}

export function ActivityPreference() {
  const state = useContext(ActivityContext),
    { user } = useAuth();
  if (!user || !state) return null;
  return (
    <section className="card activity-settings">
      <div>
        <h2>
          <Bell size={19} />
          站内活动提醒
        </h2>
        <p>
          登录后每天最多展示一次。活动订阅保存在账号中，关闭提醒不会删除订阅。
        </p>
      </div>
      <label className="activity-switch">
        <input
          type="checkbox"
          checked={!!state.preferences?.enabled}
          onChange={(e) => state.preference(e.target.checked)}
          disabled={state.busy || !state.preferences}
        />
        <span>{state.preferences?.enabled ? "已开启" : "已关闭"}</span>
      </label>
      {state.error && (
        <div className="activity-error" role="alert">
          {state.error}{" "}
          <button className="activity-link" onClick={state.retry}>
            重新加载
          </button>
        </div>
      )}
    </section>
  );
}

function EventCard({ event, compact = false, onNavigate }) {
  const state = useContext(ActivityContext),
    { user } = useAuth(),
    navigate = useNavigate();
  const subscribed = state?.subscriptions.some(
    (s) => (s.event_id || s.event?.id || s.id) === event.id,
  );
  const ended = eventEnded(event);
  return (
    <article className={"activity-card" + (compact ? " compact" : "")}>
      <div className="activity-card-top">
        <span className="activity-badge">模拟活动</span>
        <span>
          {{
            flower_season: "花季观察",
            environment: "环境守护",
            nature: "自然观察",
          }[event.kind] || "自然活动"}
        </span>
      </div>
      <h3>{event.title || event.name}</h3>
      <p className="activity-meta">
        <CalendarDays size={15} />
        {eventDateLabel(event)}
      </p>
      <p className="activity-meta">
        <MapPin size={15} />
        {eventPlace(event)}
      </p>
      {!compact && <p>{event.description || event.summary}</p>}
      <div className="activity-actions">
        <Link
          className="activity-link"
          to={eventLocationLink(event)}
          onClick={onNavigate}
        >
          查看地点
        </Link>
        <button
          className={"btn " + (subscribed ? "secondary" : "")}
          disabled={state?.busy || (ended && !subscribed)}
          onClick={() => (user ? state?.subscribe(event) : navigate("/login"))}
        >
          {subscribed ? <Check size={15} /> : <Bell size={15} />}
          {subscribed
            ? "取消订阅"
            : ended
              ? "活动已结束"
              : user
                ? "订阅此活动"
                : "登录后订阅"}
        </button>
      </div>
    </article>
  );
}

export function ActivityHomeLink() {
  return (
    <Link to="/activities" className="card activity-home-link">
      <CalendarDays size={28} strokeWidth={1.5} />
      <span>
        <strong>一年花事 · 地方活动</strong>
        <small>全年花季日历与近期自然活动 · 模拟演示</small>
      </span>
      <span aria-hidden="true">→</span>
    </Link>
  );
}

export function PlaceActivities({ place }) {
  const [rows, setRows] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRows([]);
    setError("");
    const from = chinaDay(),
      to = chinaDay(Date.now() + 30 * 86400000),
      years = [...new Set([from.slice(0, 4), to.slice(0, 4)])];
    Promise.all(
      years.map((year) =>
        api("events/", {
          data: {
            [place.isReference ? "map_reference_id" : "place_id"]: place.id,
            year,
            from,
            to,
          },
          signal: controller.signal,
        }),
      ),
    )
      .then((responses) => {
        if (!controller.signal.aborted)
          setRows(upcomingEvents(responses.flatMap(activityRows)));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [place.id, place.isReference, revision]);
  return (
    <section className="place-activities" aria-label="所选地点的近期活动">
      <h3>
        <CalendarDays size={18} />
        近期活动 <span className="activity-badge">模拟</span>
      </h3>
      <State
        loading={loading}
        error={error}
        onRetry={() => setRevision((v) => v + 1)}
      >
        {rows.length ? (
          <div className="activity-list">
            {rows.slice(0, 3).map((event) => (
              <EventCard key={event.id} event={event} compact />
            ))}
          </div>
        ) : (
          <p className="activity-note">
            此地点近期无活动（未来 30 天）。可在全年日历中查看其他时间和地点。
          </p>
        )}
        <Link className="activity-link" to="/activities">
          查看全年模拟活动 →
        </Link>
      </State>
    </section>
  );
}

export function ActivitiesPage() {
  const now = chinaDay(),
    [year, setYear] = useState(Number(now.slice(0, 4))),
    [month, setMonth] = useState(Number(now.slice(5, 7)));
  const [events, setEvents] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [subscribedOnly, setSubscribedOnly] = useState(false);
  const state = useContext(ActivityContext),
    { user } = useAuth();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api("events/", { data: { year }, signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) setEvents(activityRows(r));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [year, revision]);
  const visible = useMemo(
    () =>
      events.filter(
        (event) =>
          eventInMonth(event, year, month) &&
          (!subscribedOnly ||
            state?.subscriptions.some(
              (s) => (s.event_id || s.event?.id || s.id) === event.id,
            )),
      ),
    [events, year, month, subscribedOnly, state?.subscriptions],
  );
  return (
    <main className="activities-page">
      <PageHeader
        eyebrow="SEASONS / 模拟地方活动"
        title="一年花事 · 地方活动"
      />
      <section className="card activity-calendar-intro">
        <Flower2 size={33} strokeWidth={1.4} />
        <div>
          <h2>随季节，发现身边的自然</h2>
          <p>
            从春日赏花到冬季护绿，按月份查看地方活动。订阅你感兴趣的活动，登录后查看站内提醒。
          </p>
        </div>
      </section>
      <SimulationNote />
      <ActivityPreference />
      <section className="card activity-calendar">
        <div className="activity-calendar-heading">
          <h2>全年花季日历</h2>
          <label>
            年份{" "}
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {[
                Number(now.slice(0, 4)) - 1,
                Number(now.slice(0, 4)),
                Number(now.slice(0, 4)) + 1,
              ].map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="activity-months" aria-label="选择月份">
          {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
            <button
              key={value}
              aria-pressed={month === value}
              className={month === value ? "active" : ""}
              onClick={() => setMonth(value)}
            >
              <strong>{value} 月</strong>
              <small>
                {events.filter((e) => eventInMonth(e, year, value)).length}{" "}
                项活动
              </small>
            </button>
          ))}
        </div>
      </section>
      <div className="activity-calendar-heading">
        <h2>
          {year} 年 {month} 月
        </h2>
        {user && (
          <label className="activity-filter">
            <input
              type="checkbox"
              checked={subscribedOnly}
              onChange={(e) => setSubscribedOnly(e.target.checked)}
            />
            只看我的订阅
          </label>
        )}
      </div>
      {state?.error && (
        <p className="activity-error" role="alert">
          {state.error}
        </p>
      )}
      <State
        loading={loading}
        error={error}
        onRetry={() => setRevision((v) => v + 1)}
      >
        {visible.length ? (
          <div className="activity-grid">
            {visible.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <div className="card activity-empty">
            <Flower2 size={30} />
            <p>
              {subscribedOnly
                ? "这个月还没有订阅活动。取消筛选后可浏览全部模拟活动。"
                : "这个月暂时没有模拟活动，试试其他月份。"}
            </p>
          </div>
        )}
      </State>
    </main>
  );
}
