#!/usr/bin/env node
// Build an isolated personal-plan project: native pages + deployable native cloud function.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markerName = '.hyhq-generated-personal';
const markerText = 'HYHQ generated native cloud function project v1\n';

export function preparePersonalMiniprogram({ root = repository, env, appid, functionName = 'hyhqApi' }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(env || '')) throw new Error('必须提供有效的云环境 ID；不会生成空配置云包。');
  if (!/^wx[a-f0-9]{16}$/i.test(appid || '')) throw new Error('必须提供已关联云环境的小程序真实 AppID（不是 AppSecret）。');
  if (!/^[a-z][a-z0-9_-]{0,59}$/i.test(functionName || '')) throw new Error('云函数名称无效。');
  const source = path.join(root, 'miniprogram');
  const functionSource = path.join(root, 'cloudfunctions', 'hyhqApi');
  if (!fs.existsSync(path.join(functionSource, 'index.js')) || !fs.existsSync(path.join(functionSource, 'package.json'))) throw new Error('缺少 cloudfunctions/hyhqApi/index.js 或 package.json，请先准备原生云函数后端。');
  for (const file of ['app.js', 'app.json']) {
    const entry = path.join(source, file);
    if (!fs.existsSync(entry) || !fs.lstatSync(entry).isFile()) throw new Error('缺少有效的小程序入口 miniprogram/' + file + '；已保留现有生成项目。');
  }
  const app = JSON.parse(fs.readFileSync(path.join(source, 'app.json'), 'utf8'));
  if (!app || !Array.isArray(app.pages) || !app.pages.length) throw new Error('小程序 app.json 缺少 pages 入口；已保留现有生成项目。');
  const destination = path.join(root, 'miniprogram-personal');
  const marker = path.join(destination, markerName);
  if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== markerText)) throw new Error('miniprogram-personal 不是本工具生成的目录，已停止以保护文件。');
  const ignored = new Set(['tests', 'node_modules', 'project.config.json', 'project.private.config.json', 'project.private.config.example.json', 'config/local.js', 'config/local.example.js', 'config/cloud.example.js', 'config/personal.example.js', 'config.local.js', 'package.json', 'README.md']);
  const temporary = fs.mkdtempSync(path.join(root, '.hyhq-personal-build-'));
  function filter(base, frontend) {
    return (file) => {
      const relative = path.relative(base, file);
      const components = relative.split(path.sep);
      if (components.some((part) => part.startsWith('.') || part === 'node_modules' || part === 'tests' || part === '__pycache__')) return false;
      if ((frontend && ignored.has(relative)) || /(?:\.pem|\.key|\.env|\.pyc)$/i.test(file) || /(?:^|\/)(?:config|deployment)\.local\.(?:js|json)$/.test(relative) || /(?:^|\/)project\.private\.config\.json$/.test(relative)) return false;
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('项目来源中存在符号链接，已停止以保护私有文件。');
      return true;
    };
  }
  try {
    fs.cpSync(source, path.join(temporary, 'mini'), { recursive: true, filter: filter(source, true) });
    fs.cpSync(functionSource, path.join(temporary, 'cloudfunctions', functionName), { recursive: true, filter: filter(functionSource, false) });
    const configuration = { transport: 'cloud-function', baseURL: 'https://greatdata.asia/api/v1', cloud: { env, function: functionName }, development: false, timeout: 15000, uploadTimeout: 60000, maxUploadBytes: 5 * 1024 * 1024 };
    fs.writeFileSync(path.join(temporary, 'mini', 'config', 'index.js'), '// Public routing identifiers only. Keep API keys in the cloud function environment.\nmodule.exports = ' + JSON.stringify(configuration, null, 2) + ';\n');
    const project = JSON.parse(fs.readFileSync(path.join(source, 'project.config.json'), 'utf8'));
    project.appid = appid;
    project.projectname = 'HYHQ-personal';
    project.description = 'HYHQ 微信云开发个人版独立项目';
    project.miniprogramRoot = 'mini/';
    project.cloudfunctionRoot = 'cloudfunctions/';
    project.setting = Object.assign({}, project.setting, { urlCheck: true });
    project.packOptions = Object.assign({}, project.packOptions, { ignore: [...((project.packOptions || {}).ignore || []), { type: 'file', value: markerName }] });
    fs.writeFileSync(path.join(temporary, 'project.config.json'), JSON.stringify(project, null, 2) + '\n');
    fs.writeFileSync(path.join(temporary, markerName), markerText);
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true });
    fs.renameSync(temporary, destination);
    return destination;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { env: process.env.HYHQ_PERSONAL_ENV, appid: process.env.HYHQ_PERSONAL_APPID, functionName: process.env.HYHQ_PERSONAL_FUNCTION || 'hyhqApi' };
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/prepare-personal-miniprogram.mjs --env ENV_ID --appid wx0123456789abcdef [--function hyhqApi]');
    console.log('也可使用 HYHQ_PERSONAL_ENV、HYHQ_PERSONAL_APPID、HYHQ_PERSONAL_FUNCTION；禁止传入 AppSecret 或 API Key。');
  } else {
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index].replace(/^--/, '');
      if (!['env', 'appid', 'function'].includes(key) || !args[index].startsWith('--') || !args[index + 1]) throw new Error('参数无效；使用 --help 查看格式。');
      options[key === 'function' ? 'functionName' : key] = args[index + 1];
    }
    console.log('生成前请关闭微信开发者工具中的 miniprogram-personal 项目；生成后重新打开项目根目录。');
    console.log('个人版独立项目：' + preparePersonalMiniprogram(options));
    console.log('mini/ 为前端，cloudfunctions/ 为独立函数；development:false、urlCheck:true，无 HTTP 回退。');
    console.log('需在已关联的云环境部署函数并完成真机验收；生成不会上传或开通云资源。');
  }
}
