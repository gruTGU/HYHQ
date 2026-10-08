import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = "http://127.0.0.1:8787";
async function healthy() {
  try {
    const r = await fetch(url + "/api/v1/health/", {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}
function open() {
  if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore" });
  console.log("打开网页：" + url);
}
if (await healthy()) {
  open();
  console.log("本地服务已经运行。");
} else {
  const server = spawn(process.execPath, ["backend/server.cjs"], {
    cwd: root,
    stdio: "inherit",
  });
  let opened = false;
  const timer = setInterval(async () => {
    if (!opened && (await healthy())) {
      opened = true;
      clearInterval(timer);
      open();
    }
  }, 500);
  server.on("exit", (code) => {
    clearInterval(timer);
    process.exitCode = code || 0;
  });
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => server.kill(s));
}
