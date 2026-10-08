export class ApiError extends Error {
  constructor(message, code, status, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export async function api(path, { method = "GET", data, signal } = {}) {
  let url = path.startsWith("/api/")
    ? path
    : "/api/v1/" + path.replace(/^\/+/, "");
  if (method === "GET" && data) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(data))
      if (value !== undefined && value !== null) query.set(key, String(value));
    url += (url.includes("?") ? "&" : "?") + query.toString();
    data = undefined;
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: data === undefined ? {} : { "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(
      "暂时无法连接本地服务，请确认服务已启动。",
      "NETWORK_ERROR",
      0,
    );
  }
  if (response.status === 204) return { data: null };
  let value;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(
      "服务返回了无法读取的内容。",
      "INVALID_RESPONSE",
      response.status,
    );
  }
  if (!response.ok || value.error) {
    const e = value.error || {};
    throw new ApiError(
      e.message || "操作未完成，请稍后重试。",
      e.code || "REQUEST_FAILED",
      response.status,
      e.details,
    );
  }
  return value;
}
export const assetURL = (id, variant = "thumbnail") =>
  id
    ? "/api/v1/uploads/" +
      encodeURIComponent(id) +
      "/content/?variant=" +
      encodeURIComponent(variant)
    : "";
export async function uploadFile(file, purpose = "recognition") {
  if (!file || file.size > 5 * 1024 * 1024)
    throw new ApiError("请选择不超过 5 MB 的图片。", "FILE_TOO_LARGE", 400);
  const encoded = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  return (
    await api("web/uploads/", {
      method: "POST",
      data: {
        name: file.name,
        content_type: file.type,
        purpose,
        data: encoded,
      },
    })
  ).data;
}
export async function allPages(path, options = {}) {
  let rows = [],
    page = 1;
  for (; page <= 100; page++) {
    const r = await api(
      path +
        (path.includes("?") ? "&" : "?") +
        "page=" +
        page +
        "&page_size=100",
      options,
    );
    rows.push(...(Array.isArray(r.data) ? r.data : r.data?.items || []));
    if (
      !r.meta?.next &&
      !r.meta?.has_next &&
      (r.meta?.total == null || rows.length >= r.meta.total)
    )
      break;
  }
  return rows;
}
