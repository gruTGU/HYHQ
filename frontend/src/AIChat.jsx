import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Send, Sparkles, ArrowUpRight, ImagePlus } from "lucide-react";
import { api, allPages } from "./lib/api";
import { useAI, useAuth } from "./state";
import { Markdown, Modal } from "./components";
const active = (turn) => ["queued", "running"].includes(turn.status);
const normalizeScope = (scope) =>
  ({ recognize: "recognition", water: "recognition", data: "explore" })[
    scope
  ] ||
  scope ||
  "home";
// Only an opaque session ID is retained in memory. Keys include both the owner
// and exact page context; changing account or module cannot reuse private text.
const rememberedSessions = new Map();
export default function AIChat() {
  const { context, close } = useAI(),
    { user, visitor } = useAuth();
  const owner = user?.id || visitor?.id || "preparing-guest";
  return context ? (
    <Chat
      key={JSON.stringify(context) + ":" + owner}
      context={context}
      owner={owner}
      onClose={close}
    />
  ) : null;
}
function citationPath(c) {
  const kind = c.source_type || c.kind || c.type,
    id = c.source_id || c.id;
  if (!id) return null;
  if (kind === "blog_post") return "/blog/" + encodeURIComponent(id);
  if (["content", "route", "place"].includes(kind))
    return "/detail/" + kind + "/" + encodeURIComponent(id);
  if (kind === "map_reference")
    return "/explore?reference_id=" + encodeURIComponent(id);
  if (kind === "water") return "/water/" + encodeURIComponent(id);
  if (kind === "region") return "/explore?city=" + encodeURIComponent(id);
  return null;
}
function Chat({ context, owner, onClose }) {
  const { user, visitor, ensureVisitor, loading: authLoading } = useAuth();
  const actor = user || visitor,
    scope = normalizeScope(context.scope);
  const memoryKey = owner + ":" + JSON.stringify(context);
  const [sessionId, setSessionId] = useState(
    context.sessionId || rememberedSessions.get(memoryKey) || null,
  );
  const [session, setSession] = useState(null),
    [turns, setTurns] = useState([]),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [errorCode, setErrorCode] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!sessionId),
    [pending, setPending] = useState(null),
    [recoverTurn, setRecoverTurn] = useState(null),
    [loadTick, setLoadTick] = useState(0),
    [loadFailed, setLoadFailed] = useState(false),
    [sendUncertain, setSendUncertain] = useState(false),
    [weatherCity, setWeatherCity] = useState(context.weather_location || ""),
    [includeImage, setIncludeImage] = useState(context.include_image === true);
  const bottom = useRef(),
    live = useRef(true),
    requestRef = useRef(null),
    submitted = useRef(false),
    creationRef = useRef(null);
  const recognition =
    scope === "recognition" ||
    !!(context.recognition_job_id || context.assessment_job_id);
  const hasJob = !!(context.recognition_job_id || context.assessment_job_id);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (authLoading || actor) return;
    let mounted = true;
    ensureVisitor().catch((e) => {
      if (mounted) {
        setError(e.message);
        setErrorCode(e.code || "");
      }
    });
    return () => {
      mounted = false;
    };
  }, [actor?.id, authLoading, ensureVisitor]);
  useEffect(() => {
    if (!actor || !sessionId || session?.id === sessionId) return;
    let mounted = true;
    const controller = new AbortController();
    setLoading(true);
    setLoadFailed(false);
    setError("");
    Promise.all([
      api("llm/sessions/" + sessionId + "/", { signal: controller.signal }),
      allPages("llm/sessions/" + sessionId + "/turns/", {
        signal: controller.signal,
      }),
    ])
      .then(([s, rows]) => {
        if (!mounted) return;
        setSession(s.data);
        setTurns([...rows].reverse());
        const waiting = rows.find(active);
        if (waiting) {
          setBusy(true);
          setPending(waiting.id);
        }
      })
      .catch((e) => {
        if (!mounted || e.name === "AbortError") return;
        setError(e.message);
        setErrorCode(e.code || "");
        setLoadFailed(true);
        if ([404, 409, 410].includes(e.status))
          rememberedSessions.delete(memoryKey);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [sessionId, actor?.id, loadTick]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, busy]);
  useEffect(() => {
    if (!pending) return;
    let cancelled = false,
      timer;
    const deadline = Date.now() + 120000,
      controller = new AbortController();
    async function poll() {
      try {
        const r = await api("llm/turns/" + pending + "/", {
          signal: controller.signal,
        });
        if (cancelled) return;
        setTurns((rows) =>
          rows.some((t) => t.id === r.data.id)
            ? rows.map((t) => (t.id === r.data.id ? r.data : t))
            : [...rows, r.data],
        );
        if (!active(r.data)) {
          setPending(null);
          setRecoverTurn(null);
          setBusy(false);
          if (r.data.status !== "succeeded") {
            setError(r.data.message || "本次回复未完成，可以重新提问。");
            setErrorCode(r.data.error_code || "");
          }
          return;
        }
        if (Date.now() > deadline) {
          setRecoverTurn(pending);
          setBusy(false);
          setPending(null);
          setError("回答仍在处理。可刷新这条回答，无需重复提交问题。");
          return;
        }
        timer = setTimeout(poll, 1500);
      } catch (e) {
        if (cancelled) return;
        setError(e.message);
        setErrorCode(e.code || "");
        setBusy(false);
        setPending(null);
        if (![401, 404, 410].includes(e.status)) setRecoverTurn(pending);
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [pending]);
  async function submit(e) {
    e.preventDefault();
    if (
      !actor ||
      !text.trim() ||
      busy ||
      loading ||
      loadFailed ||
      recoverTurn ||
      submitted.current
    )
      return;
    const question = text.trim();
    submitted.current = true;
    setBusy(true);
    setError("");
    setErrorCode("");
    let stage = "identity";
    try {
      if (!user) {
        const current = await ensureVisitor();
        if (!live.current || current.id !== actor.id) return;
      }
      let s = session;
      if (!s) {
        stage = "session";
        if (!creationRef.current) {
          const payload = {
            scope,
            request_id: crypto.randomUUID(),
            consent_version: "deepseek-v1",
          };
          for (const key of [
            "source_type",
            "source_id",
            "recognition_job_id",
            "assessment_job_id",
            "interpretation_mode",
          ])
            if (context[key] !== undefined) payload[key] = context[key];
          if (recognition && hasJob) payload.include_image = includeImage;
          else if (!recognition && weatherCity)
            payload.weather_location = weatherCity;
          creationRef.current = payload;
        }
        s = (
          await api("llm/sessions/", {
            method: "POST",
            data: creationRef.current,
          })
        ).data;
        if (!live.current) return;
        setSession(s);
        setSessionId(s.id);
        rememberedSessions.set(memoryKey, s.id);
        // Bound memory to opaque IDs from this browser tab only.
        if (rememberedSessions.size > 100)
          rememberedSessions.delete(rememberedSessions.keys().next().value);
      }
      stage = "turn";
      if (
        !requestRef.current ||
        requestRef.current.question !== question ||
        requestRef.current.session !== s.id
      )
        requestRef.current = {
          question,
          session: s.id,
          id: crypto.randomUUID(),
        };
      const r = await api("llm/sessions/" + s.id + "/turns/", {
        method: "POST",
        data: { request_id: requestRef.current.id, question },
      });
      if (!live.current) return;
      setText("");
      setSendUncertain(false);
      requestRef.current = null;
      setTurns((rows) => [...rows.filter((x) => x.id !== r.data.id), r.data]);
      if (active(r.data)) setPending(r.data.id);
      else {
        setBusy(false);
        if (r.data.status !== "succeeded") {
          setError(r.data.message || "本次回复未完成，可以重新提问。");
          setErrorCode(r.data.error_code || "");
        }
      }
    } catch (e) {
      if (!live.current) return;
      const uncertain =
        !e.status || e.status >= 500 || e.code === "INVALID_RESPONSE";
      setErrorCode(e.code || "");
      if (uncertain && ["session", "turn"].includes(stage)) {
        setSendUncertain(true);
        setError(
          "暂时无法确认请求结果。点击重试会核对同一条问题，不会重复扣除次数。",
        );
      } else {
        setSendUncertain(false);
        setError(e.message);
        if (stage === "session") creationRef.current = null;
      }
      setBusy(false);
    } finally {
      submitted.current = false;
    }
  }
  function newConversation() {
    rememberedSessions.delete(memoryKey);
    creationRef.current = null;
    requestRef.current = null;
    setSessionId(null);
    setSession(null);
    setTurns([]);
    setLoadFailed(false);
    setError("");
    setErrorCode("");
    setSendUncertain(false);
  }
  const quotaError = /LIMIT|BUDGET/.test(errorCode);
  return (
    <Modal
      title={
        session?.title ||
        {
          home: "首页助手",
          explore: "生态导览助手",
          learn: "科普智游助手",
          recognition: "识别观察助手",
        }[scope] ||
        "问问 AI"
      }
      onClose={onClose}
      className="chat-modal"
    >
      <div className="chat-model">
        <Sparkles size={15} /> DeepSeek · Flash{" "}
        <span>{recognition && !hasJob ? "通用观察问答" : "结合公开资料"}</span>
      </div>
      {!session && !sessionId && (
        <div className="chat-options">
          {recognition && hasJob ? (
            <button
              className={"chat-attachment " + (includeImage ? "selected" : "")}
              disabled={
                busy ||
                !!creationRef.current ||
                context.interpretation_mode === "image"
              }
              onClick={() => setIncludeImage((v) => !v)}
              aria-pressed={includeImage}
            >
              <ImagePlus size={14} />
              {includeImage ? "已附识别照片" : "附上识别照片"}
            </button>
          ) : (
            !recognition && (
              <label>
                天气参考
                <select
                  aria-label="AI 天气参考城市"
                  value={weatherCity}
                  onChange={(e) => setWeatherCity(e.target.value)}
                  disabled={busy || !!creationRef.current}
                >
                  <option value="">不附加天气</option>
                  {[
                    ["tianjin", "天津"],
                    ["beijing", "北京"],
                  ].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )
          )}
        </div>
      )}
      <div className="chat-messages">
        {loading ? (
          <div className="state">正在加载对话</div>
        ) : (
          <>
            {!turns.length && (
              <div className="chat-welcome">
                <div className="chat-orb">
                  <Sparkles size={30} strokeWidth={1.3} />
                </div>
                <h3>想从哪里开始了解？</h3>
                <p>
                  {recognition && !hasJob
                    ? "可以直接询问拍摄和观察方法；当前没有附带照片或识别结果。"
                    : "直接输入问题即可，无需先选择文章或地点。"}
                </p>
              </div>
            )}
            {turns.map((t) => (
              <div className="chat-turn" key={t.id}>
                <div className="chat-question">{t.question}</div>
                <div className="chat-answer">
                  <div className="answer-label">
                    <Sparkles size={15} /> DeepSeek
                  </div>
                  {t.answer ? (
                    <Markdown text={t.answer} />
                  ) : active(t) ? (
                    <span className="thinking">
                      正在整理资料<span>···</span>
                    </span>
                  ) : (
                    <>
                      <p>{t.message || "本次回复未完成"}</p>
                      <button
                        className="btn secondary"
                        disabled={busy || !!recoverTurn || sendUncertain}
                        onClick={() => setText(t.question)}
                      >
                        重新提问
                      </button>
                    </>
                  )}
                  {t.citations?.length > 0 && (
                    <div className="chat-citations">
                      {t.citations.map((c, i) => {
                        const route = citationPath(c);
                        return route ? (
                          <Link key={i} to={route} onClick={onClose}>
                            [{i + 1}] {c.title || c.name || "查看来源"}
                            <ArrowUpRight size={12} />
                          </Link>
                        ) : (
                          <span key={i}>
                            [{i + 1}]{" "}
                            {c.title || c.name || c.source || "当前页面资料"}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
        <div ref={bottom} />
      </div>
      {error && (
        <div className="chat-error" role="alert">
          {error}
          {recoverTurn && (
            <button
              className="btn secondary"
              onClick={() => {
                setError("");
                setBusy(true);
                setPending(recoverTurn);
                setRecoverTurn(null);
              }}
            >
              刷新回答
            </button>
          )}
          {loadFailed && (
            <>
              <button
                className="btn secondary"
                onClick={() => setLoadTick((v) => v + 1)}
              >
                重试加载
              </button>
              <button className="btn secondary" onClick={newConversation}>
                开始新对话
              </button>
            </>
          )}
          {!actor && (
            <button
              className="btn secondary"
              onClick={() => ensureVisitor().catch((e) => setError(e.message))}
            >
              重试连接
            </button>
          )}
          {!user && quotaError && (
            <Link to="/login" onClick={onClose}>
              登录后查看账号额度
            </Link>
          )}
        </div>
      )}
      <form className="chat-input" onSubmit={submit}>
        <textarea
          aria-label="输入问题"
          placeholder={!actor ? "正在准备游客体验…" : "输入你的问题…"}
          maxLength={500}
          rows={2}
          value={text}
          disabled={
            !actor ||
            busy ||
            loading ||
            loadFailed ||
            sendUncertain ||
            !!recoverTurn
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit(e);
            }
          }}
        />
        <button
          className="btn icon-btn"
          aria-label={sendUncertain ? "重试同一问题" : "发送问题"}
          disabled={
            !actor ||
            busy ||
            loading ||
            loadFailed ||
            !!recoverTurn ||
            !text.trim()
          }
        >
          <Send size={20} />
        </button>
      </form>
      <p className="muted">
        问题、相关公开资料和你主动附带的图片会发送给 DeepSeek。AI
        可能出错，请结合来源核实。
      </p>
    </Modal>
  );
}
