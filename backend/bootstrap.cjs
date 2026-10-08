"use strict";
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { root } = require("./config.cjs"),
  { SQLiteStore } = require("./store.cjs"),
  { accountRecord } = require("./auth.cjs");
async function main() {
  const folder = path.join(root, ".private"),
    store = new SQLiteStore(path.join(folder, "hyhq.sqlite3"));
  try {
    const existing = await store.list("users", {
      where: { role: "admin" },
      limit: 1,
    });
    if (existing.length) {
      console.log("本机管理员已初始化，现有账号与密码保持不变。");
      return;
    }
    try {
      await fs.access(path.join(folder, "admin-credentials.md"));
      throw Object.assign(
        new Error("先备份并移走现有管理员凭据文件，再明确重新初始化。"),
        { code: "EXISTING_CREDENTIALS_WITHOUT_ADMIN" },
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const password = crypto.randomBytes(18).toString("base64url");
    const user = await accountRecord(
      store,
      { username: "admin", password, nickname: "本机管理员" },
      { admin: true },
    );
    await fs.writeFile(
      path.join(folder, "admin-credentials.md"),
      `# 本机管理员登录信息\n\n地址：http://127.0.0.1:8787\n账号：admin\n密码：${password}\n\n此文件仅保存在本机，权限为仅当前用户读写。请妥善保管，不要加入版本控制或分享。\n`,
      { mode: 0o600, flag: "wx" },
    );
    await store.set("web_config", "bootstrap", {
      admin_id: user.id,
      created_at: new Date().toISOString(),
    });
    console.log(
      "本机管理员已初始化。登录信息已保存到 .private/admin-credentials.md。",
    );
  } finally {
    await store.close();
  }
}
main().catch((e) => {
  console.error("初始化失败：" + (e.code || e.message));
  process.exitCode = 1;
});
