#!/usr/bin/env node
// Update frontend source in an existing personal cloud project while preserving its routing and deployment.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { personalSourceExcluded } from './prepare-personal-miniprogram.mjs';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markerText = 'HYHQ generated native cloud function project v1\n';

function regularPath(base, relative, directory = false, optional = false) {
  let current = base;
  const parts = relative ? relative.split(path.sep) : [];
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
    const isDirectory = index < parts.length - 1 || directory;
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) throw new Error('同步路径必须为普通文件或目录，不能包含符号链接；现有工程已保留。');
  }
  return true;
}

function routingConfig(bytes) {
  // Parse generated JSON and the existing public mapSubkey assignment without executing JavaScript.
  const invalid = () => new Error('生成工程连接配置格式无效；请先恢复原 cloud-function 配置。');
  const skipComments = value => {
    value = value.trimStart();
    while (value.startsWith('//') || value.startsWith('/*')) {
      const end = value.startsWith('//') ? value.indexOf('\n') : value.indexOf('*/', 2);
      if (end < 0) { if (value.startsWith('//')) return ''; throw invalid(); }
      value = value.slice(end + (value.startsWith('//') ? 1 : 2)).trimStart();
    }
    return value;
  };
  let source = skipComments(bytes.toString('utf8'));
  const assignment = /^module\.exports\s*=\s*/.exec(source);
  if (!assignment) throw invalid();
  source = source.slice(assignment[0].length);
  if (!source.startsWith('{')) throw invalid();
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0) throw invalid();
  let config;
  try { config = JSON.parse(source.slice(0, end)); } catch (_) { throw invalid(); }
  let tail = skipComments(source.slice(end));
  if (!tail.startsWith(';')) throw invalid();
  tail = skipComments(tail.slice(1));
  if (tail) {
    const publicMapKey = /^module\.exports\.mapSubkey\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*;/.exec(tail);
    if (!publicMapKey) throw invalid();
    try { if (typeof JSON.parse(publicMapKey[1]) !== 'string') throw invalid(); } catch (_) { throw invalid(); }
    if (skipComments(tail.slice(publicMapKey[0].length))) throw invalid();
  }
  if (!config || config.transport !== 'cloud-function' || config.development !== false
    || !config.cloud || typeof config.cloud.env !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(config.cloud.env)
    || typeof config.cloud.function !== 'string' || !/^[a-z][a-z0-9_-]{0,59}$/i.test(config.cloud.function)) throw new Error('生成工程必须保留有效的 cloud-function 环境和函数配置；同步已停止。');
  return config;
}

export function syncPersonalMiniprogram({ root = repository, dryRun = false } = {}) {
  root = path.resolve(root);
  const source = path.join(root, 'miniprogram'), destination = path.join(root, 'miniprogram-personal');
  regularPath(source, '', true); regularPath(destination, '', true);
  regularPath(destination, '.hyhq-generated-personal');
  if (fs.readFileSync(path.join(destination, '.hyhq-generated-personal'), 'utf8') !== markerText) throw new Error('目标不是合法的个人版生成工程；现有文件已保留。');
  regularPath(destination, 'mini', true); regularPath(destination, 'mini/config/index.js'); regularPath(destination, 'project.config.json');
  const preserved = ['.hyhq-generated-personal', 'project.config.json', 'mini/config/index.js'].map(relative => ({ relative, bytes: fs.readFileSync(path.join(destination, relative)) }));
  const config = routingConfig(preserved[2].bytes);
  const project = JSON.parse(preserved[1].bytes);
  if (!project || typeof project.appid !== 'string' || !/^wx[a-f0-9]{16}$/i.test(project.appid) || project.miniprogramRoot !== 'mini/'
    || project.cloudfunctionRoot !== 'cloudfunctions/' || !project.setting || project.setting.urlCheck !== true) throw new Error('生成工程 AppID、目录或域名校验配置无效；同步已停止。');
  regularPath(destination, path.join('cloudfunctions', config.cloud.function), true);
  regularPath(source, 'app.js'); regularPath(source, 'app.json');
  const app = JSON.parse(fs.readFileSync(path.join(source, 'app.json')));
  if (!app || !Array.isArray(app.pages) || !app.pages.length) throw new Error('源码 app.json 缺少 pages 入口；同步已停止。');
  const changes = [];
  function collect(relative = '') {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (personalSourceExcluded(file) || file === path.join('config', 'index.js') || file === 'cloudfunctions'
        || /(?:^|\/)project(?:\.private)?\.config(?:\.[^/]*)?\.json$/.test(file)) continue;
      regularPath(source, file, entry.isDirectory());
      if (entry.isDirectory()) { collect(file); continue; }
      const target = path.join('mini', file);
      const exists = regularPath(destination, target, false, true);
      const bytes = fs.readFileSync(path.join(source, file));
      if (!exists || !bytes.equals(fs.readFileSync(path.join(destination, target)))) changes.push({ relative: target, bytes });
    }
  }
  // Complete all validation before writing any page. The manifest is published last.
  collect();
  changes.sort((a, b) => Number(a.relative === 'mini/app.json') - Number(b.relative === 'mini/app.json') || a.relative.localeCompare(b.relative));
  if (!dryRun) {
    for (const row of preserved) if (!row.bytes.equals(fs.readFileSync(path.join(destination, row.relative)))) throw new Error('预检期间生成配置发生变化；同步已停止。');
    for (const change of changes) {
      regularPath(destination, change.relative, false, true);
      const target = path.join(destination, change.relative), temporary = target + '.hyhq-sync-' + randomUUID() + '.tmp';
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.writeFileSync(temporary, change.bytes, { flag: 'wx' }); fs.renameSync(temporary, target); }
      finally { fs.rmSync(temporary, { force: true }); }
    }
  }
  return { destination, dryRun, changedFiles: changes.length, files: changes.map(row => row.relative), routingPreserved: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('node scripts/sync-personal-miniprogram.mjs [--dry-run]\n仅向已有合法个人版工程同步前端源码；保留连接配置、项目配置、本地配置和云函数。现有额外文件保留。');
  else {
    if (args.some(arg => arg !== '--dry-run')) throw new Error('参数无效；使用 --help 查看格式。');
    const result = syncPersonalMiniprogram({ dryRun: args.includes('--dry-run') });
    console.log(JSON.stringify({ dryRun: result.dryRun, changedFiles: result.changedFiles, routingPreserved: result.routingPreserved }));
  }
}
