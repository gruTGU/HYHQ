import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backend = spawn(process.execPath, ["backend/server.cjs"], {
  cwd: root,
  stdio: "inherit",
});
const frontend = spawn(
  process.execPath,
  [
    path.join(root, "frontend/node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5178",
  ],
  { cwd: path.join(root, "frontend"), stdio: "inherit" },
);
const stop = () => {
  backend.kill("SIGTERM");
  frontend.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
backend.on("exit", (c) => {
  if (c) stop();
});
frontend.on("exit", (c) => {
  if (c) stop();
});
