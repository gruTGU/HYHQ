#!/usr/bin/env node
// Isolated domain-free cloud build. Credentials and backend environment are never copied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markerName = '.hyhq-generated-cloud';
const markerText = 'HYHQ generated WeChat cloud build v1\n';

export function prepareCloudMiniprogram({ root = repository, env, service, appid }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(env || '') || !/^[a-z][a-z0-9-]{0,62}$/i.test(service || '')) throw new Error('必须提供有效的云环境 ID 和服务名称；不会生成空配置云包。');
  if (!/^wx[a-f0-9]{16}$/i.test(appid || '')) throw new Error('必须提供已关联云环境的小程序真实 AppID（不是 AppSecret）。');
  const source = path.join(root, 'miniprogram');
  const destination = path.join(root, 'miniprogram-cloud');
  const marker = path.join(destination, markerName);
  if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== markerText)) throw new Error('miniprogram-cloud 不是本工具生成的目录，已停止以保护文件。');
  const ignored = new Set(['tests', 'node_modules', 'project.private.config.json', 'project.private.config.example.json', 'config/local.js', 'config/local.example.js', 'config/cloud.example.js', 'config.local.js', 'package.json', 'README.md']);
  const temporary = fs.mkdtempSync(path.join(root, '.hyhq-cloud-build-'));
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      filter(file) {
        const relative = path.relative(source, file);
        const components = relative.split(path.sep);
        if (components.some((part) => part.startsWith('.') || part === 'node_modules' || part === 'tests')) return false;
        if (ignored.has(relative) || /(?:\.pem|\.key|\.env)$/i.test(file)) return false;
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error('云包来源中存在符号链接，已停止以保护私有文件。');
        return true;
      },
    });
    const configuration = { transport: 'cloud', baseURL: 'https://greatdata.asia/api/v1', cloud: { env, service }, development: false, timeout: 15000, uploadTimeout: 30000, maxUploadBytes: 5 * 1024 * 1024 };
    fs.writeFileSync(path.join(temporary, 'config', 'index.js'), '// Public routing identifiers only. Keep API keys on the backend.\nmodule.exports = ' + JSON.stringify(configuration, null, 2) + ';\n');
    const project = JSON.parse(fs.readFileSync(path.join(source, 'project.config.json'), 'utf8'));
    project.appid = appid;
    project.projectname = 'HYHQ-cloud';
    project.description = 'HYHQ 微信云托管独立版本';
    project.miniprogramRoot = './';
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
  const options = { env: process.env.HYHQ_CLOUD_ENV, service: process.env.HYHQ_CLOUD_SERVICE, appid: process.env.HYHQ_CLOUD_APPID };
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/prepare-cloud-miniprogram.mjs --env ENV_ID --service SERVICE --appid wx0123456789abcdef');
    console.log('也可使用 HYHQ_CLOUD_ENV、HYHQ_CLOUD_SERVICE、HYHQ_CLOUD_APPID；这些均为公开路由标识，禁止传入 AppSecret 或 API Key。');
  } else {
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index].replace(/^--/, '');
      if (!['env', 'service', 'appid'].includes(key) || !args[index].startsWith('--') || !args[index + 1]) throw new Error('参数无效；使用 --help 查看格式。');
      options[key] = args[index + 1];
    }
    console.log('生成前请关闭微信开发者工具中的 miniprogram-cloud 项目；生成后重新打开。');
    console.log('云版本目录：' + prepareCloudMiniprogram(options));
    console.log('已保留 development:false 和 urlCheck:true；仅云调用，无 HTTP 回退。');
    console.log('需完成云环境关联、服务部署、真实微信登录和文件通道验收后再上传审核。');
  }
}
