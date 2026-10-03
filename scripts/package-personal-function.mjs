#!/usr/bin/env node
// Prepare a local, deployable Linux x64 CPU function. Never deploys or installs cloud dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = '.hyhq-linux-function';
const markerValue = 'HYHQ generated Linux x64 native function v1\n';
const modelNames = ['flowers-efficientnet-b0-v1.onnx', 'river-eco-yolov8n-v1.onnx'];
const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function shuffle4(input) { const output = Buffer.allocUnsafe(input.length), n = Math.floor(input.length / 4); for (let i = 0; i < n; i++) for (let b = 0; b < 4; b++) output[b * n + i] = input[i * 4 + b]; input.copy(output, n * 4, n * 4); return output; }

// Every original byte is retained. Only the deployment envelope changes; the
// server checks both compressed and restored hashes before loading any code.
export function compressFunction(functionRoot, { cacheRoot, bootstrapSource } = {}) {
  const files = [], artifacts = [], chunks = [], resources = new Map(); let offset = 0, total = 0;
  const collect = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) { const file = path.join(directory, item.name), relative = path.relative(functionRoot, file).split(path.sep).join('/'); if (item.isSymbolicLink()) throw new Error('不接受部署依赖中的符号链接。'); if (item.isDirectory()) collect(file); else if (item.isFile()) { const bytes = fs.readFileSync(file), name = relative === 'index.js' ? 'application.js' : relative, digest = checksum(bytes); total += bytes.length;
    if (relative.startsWith('models/') || /(?:\.so\.\d|\.node$)/.test(relative)) artifacts.push({ path: name, size: bytes.length, sha256: digest, transform: relative.startsWith('models/') ? 'shuffle4' : 'raw', bytes });
    else { files.push({ path: name, offset, size: bytes.length, sha256: digest }); chunks.push(bytes); offset += bytes.length; }
  } else throw new Error('部署依赖包含不支持的文件类型。'); } };
  collect(functionRoot);
  const makeBlob = input => {
    const rawHash = checksum(input), cached = cacheRoot && path.join(cacheRoot, rawHash + '.br'); let bytes;
    if (cached && fs.existsSync(cached)) { const candidate = fs.readFileSync(cached); try { if (checksum(zlib.brotliDecompressSync(candidate, { maxOutputLength: input.length })) === rawHash) bytes = candidate; } catch (_) {} }
    if (!bytes) { bytes = zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length } }); if (cached) { fs.mkdirSync(cacheRoot, { recursive: true }); fs.writeFileSync(cached, bytes); } }
    const digest = checksum(bytes), filename = 'resources/' + digest + '.br'; resources.set(filename, bytes);
    return { path: filename, size: bytes.length, sha256: digest, raw_size: input.length, raw_sha256: rawHash };
  };
  for (const row of artifacts) { row.blob = makeBlob(row.transform === 'shuffle4' ? shuffle4(row.bytes) : row.bytes); delete row.bytes; }
  const runtime = makeBlob(Buffer.concat(chunks));
  const manifest = { version: 1, files, artifacts, runtime, total_size: total };
  const bootstrap = fs.readFileSync(bootstrapSource || path.join(functionRoot, 'lib/bootstrap.js'));
  const { validateManifest } = require(path.join(repository, 'cloudfunctions/hyhqApi/lib/bootstrap.js'));
  validateManifest(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n'), manifestHash = checksum(manifestBytes);
  const packageJson = fs.readFileSync(path.join(functionRoot, 'package.json')), config = fs.readFileSync(path.join(functionRoot, 'config.json'));
  // Rewrite only the newly built staging directory; failures cannot damage the
  // user's previous deployable project.
  for (const name of fs.readdirSync(functionRoot)) fs.rmSync(path.join(functionRoot, name), { recursive: true, force: true });
  fs.mkdirSync(path.join(functionRoot, 'resources'));
  for (const [filename, bytes] of resources) fs.writeFileSync(path.join(functionRoot, filename), bytes);
  fs.writeFileSync(path.join(functionRoot, 'bootstrap.js'), bootstrap);
  fs.writeFileSync(path.join(functionRoot, 'bundle.manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(functionRoot, 'package.json'), packageJson);
  fs.writeFileSync(path.join(functionRoot, 'config.json'), config);
  fs.writeFileSync(path.join(functionRoot, marker), markerValue);
  fs.writeFileSync(path.join(functionRoot, 'index.js'), "'use strict';\nconst path = require('node:path');\nconst { prepare } = require('./bootstrap');\nexports.main = async (...args) => {\n  const root = await prepare(__dirname, '" + manifestHash + "');\n  return require(path.join(root, 'application.js')).main(...args);\n};\n");
  return { manifestHash, compressedBytes: [...resources.values()].reduce((sum, bytes) => sum + bytes.length, 0), restoredBytes: total, restoredFiles: files.length + artifacts.length };
}

export function validateDestination(root, output) {
  root = fs.realpathSync(root); output = path.resolve(output);
  const relative = path.relative(root, output), parts = relative.split(path.sep);
  const runtime = parts[0] === '.runtime' && parts.length >= 3;
  const personal = relative === path.join('miniprogram-personal', 'cloudfunctions', 'hyhqApi');
  if (!runtime && !personal) throw new Error('输出只能位于本副本 .runtime/ 的独立子目录或生成项目的 cloudfunctions/hyhqApi。');
  let current = root;
  for (const part of parts) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('输出路径含符号链接，已停止。'); }
  if (personal && (!fs.existsSync(path.join(root, 'miniprogram-personal/.hyhq-generated-personal')) || fs.readFileSync(path.join(root, 'miniprogram-personal/.hyhq-generated-personal'), 'utf8') !== 'HYHQ generated native cloud function project v1\n')) throw new Error('请先用 prepare-personal-miniprogram.mjs 生成独立项目。');
  if (fs.existsSync(output) && !personal && (!fs.existsSync(path.join(output, marker)) || fs.readFileSync(path.join(output, marker), 'utf8') !== markerValue)) throw new Error('拒绝替换非本工具生成的目录。');
  return output;
}
export function inspectLinuxElf(file) {
  const data = fs.readFileSync(file);
  if (data.length < 64 || data.subarray(0, 4).toString('hex') !== '7f454c46' || data[4] !== 2 || data[5] !== 1 || data.readUInt16LE(18) !== 62) throw new Error('原生库不是 Linux x64 ELF：' + path.basename(file));
  const strings = data.toString('latin1');
  const glibc = [...new Set(strings.match(/GLIBC_\d+\.\d+(?:\.\d+)?/g) || [])].sort((a, b) => { const x = a.slice(6).split('.').map(Number), y = b.slice(6).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; });
  return { file: path.basename(file), bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), maximum_glibc_reference: glibc.at(-1) || null };
}
export function prunePlatforms(functionRoot) {
  const imageRoot = path.join(functionRoot, 'node_modules/@img');
  if (!fs.existsSync(imageRoot)) throw new Error('Linux sharp 依赖缺失。');
  for (const name of fs.readdirSync(imageRoot)) if (name.startsWith('sharp-') && !['sharp-linux-x64', 'sharp-libvips-linux-x64'].includes(name)) fs.rmSync(path.join(imageRoot, name), { recursive: true, force: true });
  const bin = path.join(functionRoot, 'node_modules/onnxruntime-node/bin/napi-v6');
  if (!fs.existsSync(path.join(bin, 'linux/x64'))) throw new Error('ONNX Linux x64 CPU 依赖缺失。');
  for (const platform of fs.readdirSync(bin)) if (platform !== 'linux') fs.rmSync(path.join(bin, platform), { recursive: true, force: true });
  for (const arch of fs.readdirSync(path.join(bin, 'linux'))) if (arch !== 'x64') fs.rmSync(path.join(bin, 'linux', arch), { recursive: true, force: true });
  const cpu = path.join(bin, 'linux/x64');
  // CPU-only install must never carry CUDA/TensorRT/provider bundles.
  for (const file of fs.readdirSync(cpu)) if (/cuda|tensorrt|providers/i.test(file)) throw new Error('检测到非 CPU ONNX 依赖，停止打包。');
  fs.rmSync(path.join(functionRoot, 'node_modules/.bin'), { recursive: true, force: true });
}
function sourceFilter(base, file) {
  const relative = path.relative(base, file), parts = relative.split(path.sep);
  if (parts.some(part => part.startsWith('.') || ['node_modules', 'tests', '__pycache__', 'models'].includes(part) && relative !== path.join('data', 'models'))) {
    // The public manifest directory is copied separately below.
    return false;
  }
  if (/\.(?:pem|key|env|pyc|onnx|pt|pth)$/i.test(file) || /(?:config|deployment)\.local\.(?:js|json)$/.test(file)) return false;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('函数源码含符号链接，停止复制。');
  return true;
}
function command(executable, args, cwd, log) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000, env: { ...process.env, npm_config_ignore_scripts: 'true' } });
  fs.appendFileSync(log, `${executable} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}\n`);
  if (result.error || result.status !== 0) throw new Error('本地打包步骤失败；请检查日志：' + log);
}
export async function packagePersonalFunction({ root = repository, appid, output = path.join(root, '.runtime/personal-deploy/hyhqApi'), modelRoot = path.join(root, '.runtime/cloud-migration/models'), env, maintenanceEnabled = false, flowerFileId, riverFileId }) {
  if (!/^wx[a-f0-9]{16}$/i.test(appid || '')) throw new Error('必须提供真实 AppID，不接受 AppSecret 或 API Key。');
  if (env !== undefined && !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(env)) throw new Error('云环境 ID 无效。');
  if (typeof maintenanceEnabled !== 'boolean' || (maintenanceEnabled && !env)) throw new Error('维护定时任务必须提供云环境 ID 与明确布尔开关。');
  output = validateDestination(root, output);
  const source = path.join(root, 'cloudfunctions/hyhqApi'), privateRoot = path.join(root, '.runtime/personal-deploy');
  fs.mkdirSync(privateRoot, { recursive: true });
  const build = fs.mkdtempSync(path.join(privateRoot, '.build-')), log = path.join(privateRoot, 'package-linux.log');
  fs.writeFileSync(log, 'Local Linux x64 CPU package build; lifecycle scripts disabled.\n');
  try {
    fs.cpSync(source, build, { recursive: true, filter: file => sourceFilter(source, file) });
    fs.cpSync(path.join(source, 'data/models'), path.join(build, 'data/models'), { recursive: true, filter: file => { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('模型声明目录含符号链接。'); return fs.lstatSync(file).isDirectory() || file.endsWith('.manifest.json'); } });
    for (const file of ['package.json', 'package-lock.json', 'index.js']) if (!fs.existsSync(path.join(build, file))) throw new Error('函数源码不完整：' + file);
    const inference = require(path.join(source, 'lib/inference.js'));
    const modelFiles = { recognition: inference.validateModelFileId(env, modelNames[0], flowerFileId), assessment: inference.validateModelFileId(env, modelNames[1], riverFileId) };
    // Verify the source files the operator uploaded, but never include weights
    // in the function package. Base64 upload must remain below 50 MiB.
    for (const kind of ['recognition', 'assessment']) await inference.verifiedBytes(kind, modelRoot);
    // npm's cross-platform flags select the Linux/glibc optional sharp packages.
    // onnxruntime-node ships its CPU binaries in the pinned package archive.
    command('npm', ['ci', '--ignore-scripts', '--omit=dev', '--include=optional', '--os=linux', '--cpu=x64', '--libc=glibc', '--no-audit', '--no-fund'], build, log);
    prunePlatforms(build);
    const binaries = ['node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node', 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1', '', ''];
    const sharpLib = path.join(build, 'node_modules/@img/sharp-linux-x64/lib');
    binaries[2] = path.join('node_modules/@img/sharp-linux-x64/lib', fs.readdirSync(sharpLib).find(file => /^sharp-linux-x64(?:-[\d.]+)?\.node$/.test(file)) || 'missing');
    // libvips soname includes the pinned package's version; resolve rather than guess it.
    const vips = path.join(build, 'node_modules/@img/sharp-libvips-linux-x64/lib');
    binaries[3] = path.join('node_modules/@img/sharp-libvips-linux-x64/lib', fs.readdirSync(vips).find(file => /^libvips-cpp\.so\./.test(file)) || 'missing');
    const native = binaries.map(file => ({ ...inspectLinuxElf(path.join(build, file)), path: file }));
    // Keep every dependency's LICENSE/NOTICE and upstream model attribution.
    fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(build, 'THIRD_PARTY_NOTICES.md'));
    fs.writeFileSync(path.join(build, 'deployment.local.json'), JSON.stringify({ appId: appid, ...(env ? { env } : {}), inferenceEnabled: true, maintenanceEnabled, modelFiles }, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(build, 'config.json'), JSON.stringify({ permissions: { openapi: [] }, triggers: maintenanceEnabled ? [{ name: 'hyhqMaintenance', type: 'timer', config: '0 */30 * * * * *' }] : [] }, null, 2) + '\n');
    fs.writeFileSync(path.join(build, marker), markerValue);
    const compression = compressFunction(build, { cacheRoot: path.join(root, '.runtime/personal-compression/cache') });
    const archive = path.join(privateRoot, 'hyhqApi-linux-x64.zip');
    fs.rmSync(archive, { force: true });
    command('/usr/bin/zip', ['-q', '-r', '-9', archive, '.', '-x', '.DS_Store'], build, log);
    if (fs.statSync(archive).size > 36 * 1024 * 1024 || Math.ceil(fs.statSync(archive).size / 3) * 4 + 8192 > 50 * 1024 * 1024) throw new Error('压缩包超过 Base64 上传安全上限；已保留原部署目录。');
    const report = { generated_at: new Date().toISOString(), architecture: 'linux-x64-glibc', runtime: 'Nodejs20.19', timeout: 60, memorySize: 512, installDependency: false, native, model_bytes: 28324531, archive_bytes: fs.statSync(archive).size, archive_sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), native_execution_verified: process.platform === 'linux' && process.arch === 'x64' ? 'still requires actual cloud runtime verification' : false, notes: ['config.json only configures permissions/triggers. Set runtime, timeout and memory in the console or cloudbaserc.', 'CPU model results validated locally; ELF architecture is checked here, not executed on macOS.', 'No API keys or session secrets are placed in this artifact.'] };
    report.compression = compression;
    report.model_storage = 'same-environment-private-cloud-storage';
    report.weights_in_package = false;
    report.upload_base64_bytes = Math.ceil(report.archive_bytes / 3) * 4;
    report.maintenance = { enabled: maintenanceEnabled, schedule_minutes: maintenanceEnabled ? 30 : null, platform_execution_verified: false };
    fs.writeFileSync(path.join(privateRoot, 'package-report.json'), JSON.stringify(report, null, 2) + '\n');
    if (env) fs.writeFileSync(path.join(privateRoot, 'cloudbaserc.local.json'), JSON.stringify({ envId: env, functions: [{ name: 'hyhqApi', dir: output, handler: 'index.main', runtime: report.runtime, timeout: report.timeout, memorySize: report.memorySize, installDependency: false, triggers: maintenanceEnabled ? [{ name: 'hyhqMaintenance', type: 'timer', config: '0 */30 * * * * *' }] : [] }] }, null, 2) + '\n');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (fs.existsSync(output)) fs.rmSync(output, { recursive: true });
    fs.renameSync(build, output);
    return { output, archive, report: path.join(privateRoot, 'package-report.json'), archiveBytes: report.archive_bytes, native };
  } catch (error) { fs.rmSync(build, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { appid: process.env.HYHQ_PERSONAL_APPID, env: process.env.HYHQ_PERSONAL_ENV, flowerFileId: process.env.HYHQ_FLOWER_MODEL_FILE_ID, riverFileId: process.env.HYHQ_RIVER_MODEL_FILE_ID };
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('node scripts/package-personal-function.mjs --appid wx... --env ENV --flower-file-id cloud://... --river-file-id cloud://... [--models PATH] [--output miniprogram-personal/cloudfunctions/hyhqApi] [--maintenance true|false]\n仅本地生成；模型须预先上传本环境私有存储。选择上传所有文件，关闭云端依赖安装。');
  else { for (let i = 0; i < args.length; i += 2) { const key = args[i].replace(/^--/, ''); if (!['appid', 'env', 'output', 'models', 'maintenance', 'flower-file-id', 'river-file-id'].includes(key) || !args[i].startsWith('--') || !args[i + 1]) throw new Error('参数无效，使用 --help。'); if (key === 'maintenance') { if (!['true', 'false'].includes(args[i + 1])) throw new Error('maintenance 必须是 true 或 false。'); options.maintenanceEnabled = args[i + 1] === 'true'; } else options[({ models: 'modelRoot', 'flower-file-id': 'flowerFileId', 'river-file-id': 'riverFileId' })[key] || key] = args[i + 1]; } console.log(JSON.stringify(await packagePersonalFunction(options), null, 2)); }
}
