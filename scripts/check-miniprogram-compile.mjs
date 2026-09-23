#!/usr/bin/env node
// Use the installed WeChat compilers directly; no IDE service port or upload.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'miniprogram');
const binaries = process.env.HYHQ_WECHAT_COMPILER_DIR || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec';
const output = path.join(root, '.runtime', 'wechat-compile');
fs.mkdirSync(output, { recursive: true });
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
for (const [binary, extension] of [['wcc', '.wxml'], ['wcsc', '.wxss']]) {
  const compiler = path.join(binaries, binary + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(compiler)) throw new Error('未找到微信编译器；安装开发者工具，或设置 HYHQ_WECHAT_COMPILER_DIR。');
  const inputs = files(source).filter((file) => file.endsWith(extension)).map((file) => './' + path.relative(source, file));
  const result = spawnSync(compiler, ['-o', path.join(output, binary + '.compiled.js'), ...inputs], { cwd: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, binary + '.log'), (result.stdout || '') + (result.stderr || ''));
  if (result.error || result.status !== 0) throw new Error(binary + ' 编译失败：' + (result.error || result.stderr || result.stdout));
  console.log(binary + ': ' + inputs.length + ' 个文件编译通过');
}
console.log('这是原生模板/样式编译检查，不替代模拟器显示与真机验收。');
