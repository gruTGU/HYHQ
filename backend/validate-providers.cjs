"use strict";
// Explicit opt-in smoke check: makes at most four weather calls and two LLM calls.
// Never used by the offline test suite. Credentials and conversation text are not printed.
if (!process.argv.includes("--run")) {
  console.error("Use --run only when live provider checks are authorized.");
  process.exit(2);
}
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const Database = require("better-sqlite3"),
  { root } = require("./config.cjs");
const db = new Database(path.join(root, ".private", "hyhq.sqlite3"), {
  readonly: true,
  fileMustExist: true,
});
const result = {
  started_at: new Date().toISOString(),
  database: ".private/hyhq.sqlite3",
  weather: {},
  llm: {},
  cleanup: {},
};
let cookie = "",
  testUserId = "";
const row = (kind, id) => {
  const r = db
    .prepare("SELECT value FROM documents WHERE kind=? AND id=?")
    .get(kind, id);
  return r ? JSON.parse(r.value) : null;
};
const count = (kind) =>
  db.prepare("SELECT COUNT(*) n FROM documents WHERE kind=?").get(kind).n;
const day = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function ledger() {
  const w = row("weather_gate", "budget"),
    l = row("llm_days", day());
  return {
    weather_requests: count("weather_requests"),
    weather_days: w?.days || {},
    llm_attempts: l?.attempts || 0,
    llm_accounted_tokens: l?.accounted_tokens || 0,
    llm_reserved_tokens: l?.reserved_tokens || 0,
  };
}
async function api(p, method = "GET", body, auth = false) {
  const t = performance.now(),
    r = await fetch("http://127.0.0.1:8787/api/v1/" + p, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(auth ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  let j = null;
  const raw = await r.text();
  if (raw) j = JSON.parse(raw);
  if (j?.error)
    throw Object.assign(new Error(j.error.code), {
      code: j.error.code,
      http_status: r.status,
    });
  return {
    data: j?.data,
    status: r.status,
    elapsed_ms: Math.round(performance.now() - t),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
function status(data) {
  return Object.fromEntries(
    ["weather", "air", "alerts", "daily"].map((k) => [
      k,
      {
        status: data[k]?.status,
        reason: data[k]?.reason || "",
        observed_at: data[k]?.observed_at,
        fetched_at: data[k]?.fetched_at,
      },
    ]),
  );
}
(async () => {
  try {
    result.before = ledger();
    console.log(JSON.stringify({ phase: "before", ledger: result.before }));
    const cold = await api("weather-data/summary/?location=tianjin");
    result.weather.first = {
      http_status: cold.status,
      elapsed_ms: cold.elapsed_ms,
      components: status(cold.data),
      provider_requests_delta:
        ledger().weather_requests - result.before.weather_requests,
    };
    console.log(
      JSON.stringify({ phase: "weather_first", ...result.weather.first }),
    );
    const afterCold = ledger();
    const warm = await api("weather-data/summary/?location=tianjin");
    result.weather.warm = {
      http_status: warm.status,
      elapsed_ms: warm.elapsed_ms,
      provider_requests_delta:
        ledger().weather_requests - afterCold.weather_requests,
      components: status(warm.data),
    };
    const forecast = await api("weather-data/tianjin/forecast/");
    result.weather.forecast = {
      http_status: forecast.status,
      elapsed_ms: forecast.elapsed_ms,
      status: forecast.data.forecast.status,
      provider_requests_delta:
        ledger().weather_requests - afterCold.weather_requests,
    };
    result.weather.request_outcomes = db
      .prepare(
        "SELECT json_extract(value,'$.kind') kind,json_extract(value,'$.outcome') outcome,json_extract(value,'$.http_status') http_status FROM documents WHERE kind='weather_requests'",
      )
      .all();
    console.log(
      JSON.stringify({
        phase: "weather_cache",
        warm: result.weather.warm,
        forecast: result.weather.forecast,
      }),
    );
    const account = await api("auth/register/", "POST", {
      username: "live-check-" + crypto.randomBytes(6).toString("hex"),
      password: crypto.randomBytes(24).toString("base64url"),
      nickname: "服务验证临时账号",
      agreement: { accepted: true, version: "2026-10-07" },
    });
    cookie = account.cookie;
    testUserId = account.data.user.id;
    const articles = await api("contents/?category=water&page_size=5");
    const article = articles.data[0];
    if (!article) throw new Error("NO_PUBLISHED_ARTICLE");
    const session = await api(
      "llm/sessions/",
      "POST",
      {
        scope: "learn",
        source_type: "content",
        source_id: article.id,
        consent_version: "deepseek-v1",
        include_image: false,
      },
      true,
    );
    const queued = await api(
      "llm/sessions/" + session.data.id + "/turns/",
      "POST",
      {
        request_id: crypto.randomUUID(),
        question:
          "请用 Markdown 两个简短要点，总结这篇资料的核心认识，并明确引用资料标题。限100字。",
      },
      true,
    );
    const completed = await api(
      "llm/turns/" + queued.data.id + "/",
      "GET",
      null,
      true,
    );
    const turn = completed.data;
    result.llm.chat = {
      http_status: completed.status,
      queued_status: queued.data.status,
      status: turn.status,
      error_code: turn.error_code || "",
      elapsed_ms: completed.elapsed_ms,
      model: turn.model,
      answer_characters: (turn.answer || "").length,
      markdown_detected: /^[-*]\s|^\d+\.\s|\*\*/m.test(turn.answer || ""),
      citations_count: turn.citations?.length || 0,
      citation_paths_valid: (turn.citations || []).every((c) =>
        /^\/api\/v1\/(contents|routes|places)\/[a-f0-9-]{36}\/$/.test(
          c.source_path,
        ),
      ),
      selected_source_cited: (turn.citations || []).some(
        (c) => c.id === article.id,
      ),
      usage: turn.usage,
    };
    console.log(JSON.stringify({ phase: "llm_chat", ...result.llm.chat }));
    if (turn.status === "succeeded") {
      const before = ledger();
      if (
        before.llm_attempts < 29 &&
        before.llm_accounted_tokens + before.llm_reserved_tokens < 55000
      ) {
        const tomorrow = new Date(Date.now() + 8 * 3600000 + 86400000)
          .toISOString()
          .slice(0, 10);
        const draft = await api(
          "weather-data/reminders/interpret/",
          "POST",
          {
            location: "tianjin",
            text:
              "请在" + tomorrow + "上午九点提醒我查看天津天气，只提醒一次。",
            request_key: crypto.randomUUID(),
          },
          true,
        );
        result.llm.booking = {
          http_status: draft.status,
          elapsed_ms: draft.elapsed_ms,
          needs_clarification: draft.data.needs_clarification,
          has_draft: !!draft.data.draft,
          location: draft.data.draft?.location,
          scheduled_for: draft.data.draft?.scheduled_for,
          model: draft.data.model,
          reminders_created: count("web_reminders"),
        };
        console.log(
          JSON.stringify({ phase: "booking_draft", ...result.llm.booking }),
        );
      }
    }
  } catch (e) {
    result.failure = {
      code: e.code || e.message,
      http_status: e.http_status || null,
    };
    console.log(JSON.stringify({ phase: "failure", ...result.failure }));
    process.exitCode = 1;
  } finally {
    if (testUserId && cookie) {
      try {
        const removed = await api("me/", "DELETE", {}, true);
        result.cleanup = {
          account_deleted: removed.status === 204,
          user_record_absent: !row("users", testUserId),
          sessions_remaining: db
            .prepare(
              "SELECT COUNT(*) n FROM documents WHERE kind='sessions' AND json_extract(value,'$.owner_id')=?",
            )
            .get(testUserId).n,
          private_turns_remaining: db
            .prepare(
              "SELECT COUNT(*) n FROM documents WHERE kind='llm_turns' AND json_extract(value,'$.owner_id')=?",
            )
            .get(testUserId).n,
        };
      } catch (e) {
        result.cleanup = { error: e.code || e.message };
      }
    }
    result.after = ledger();
    result.finished_at = new Date().toISOString();
    await fs.writeFile(
      path.join(root, ".runtime", "live-provider-validation.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        phase: "done",
        cleanup: result.cleanup,
        ledger: result.after,
      }),
    );
    db.close();
  }
})();
