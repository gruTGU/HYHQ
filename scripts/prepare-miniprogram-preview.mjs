#!/usr/bin/env node
// Build an isolated local preview; production source and private credentials stay untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'miniprogram');
const destination = path.join(root, 'miniprogram-preview');
const marker = path.join(destination, '.hyhq-generated-preview');
console.log('生成前请先在微信开发者工具中关闭 miniprogram-preview 项目：本工具会重建整个预览目录。');
if (fs.existsSync(destination)) {
  if (!fs.existsSync(marker)) throw new Error('预览目录不是本工具生成的目录，已停止以保护文件。');
  fs.rmSync(destination, { recursive: true, force: true });
}
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(marker, 'Generated local preview. Regenerate from miniprogram; do not edit or upload.\n');
const ignored = new Set(['tests', 'project.private.config.json', 'config/local.js', 'config/local.example.js', 'README.md', 'package.json']);
fs.cpSync(source, destination, {
  recursive: true,
  filter: (file) => {
    const relative = path.relative(source, file);
    return !ignored.has(relative) && !relative.startsWith('tests' + path.sep) && !path.basename(file).startsWith('.');
  },
});
const config = path.join(destination, 'config', 'index.js');
const defaults = createRequire(import.meta.url)('../miniprogram/config/index.js');
const localConfig = { baseURL: 'http://127.0.0.1:8000/api/v1', development: false, timeout: defaults.timeout, uploadTimeout: defaults.uploadTimeout, maxUploadBytes: defaults.maxUploadBytes };
fs.writeFileSync(config, 'module.exports = ' + JSON.stringify(localConfig, null, 2) + ';\n');
const project = JSON.parse(fs.readFileSync(path.join(source, 'project.config.json'), 'utf8'));
const privatePath = path.join(source, 'project.private.config.json');
if (fs.existsSync(privatePath)) {
  const local = JSON.parse(fs.readFileSync(privatePath, 'utf8'));
  if (/^wx[a-f0-9]{16}$/i.test(local.appid || '')) project.appid = local.appid;
}
project.projectname = 'HYHQ-local-preview';
project.description = 'HYHQ 本地界面验证，禁止提交审核';
project.setting.urlCheck = false; // Local loopback only; original production checks remain enabled.
fs.writeFileSync(path.join(destination, 'project.config.json'), JSON.stringify(project, null, 2) + '\n');
fs.writeFileSync(path.join(destination, 'project.private.config.json'), JSON.stringify({ appid: project.appid, projectname: project.projectname, setting: { urlCheck: false } }, null, 2) + '\n');
console.log('本地预览目录：' + destination);
console.log('仅连接 127.0.0.1:8000；开发登录关闭；不可将此目录上传或提交审核。');
console.log('生产目录 miniprogram 的 HTTPS 地址、域名校验与私有配置未修改。');
console.log('若生成时预览项目仍在工具中打开，请生成后使用「项目 → 重新打开」；仅编译或清缓存可能无法恢复 App 注册。');
