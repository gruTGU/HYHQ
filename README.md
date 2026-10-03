# HYHQ 海晏河清智慧平台 · 独立云迁移版

面向校园及周边河湖、公园的微信小程序，提供生态资料浏览、自然观察、科普学习、漫步路线和 AI 辅助解读。**本分支正在迁移至微信云开发个人版：Node.js 云函数、文档数据库、私有云存储。** 原 Django/PostgreSQL 自建版与此前云托管方案保留独立，不会自动替换北京服务器。

**当前分支：`codex/personal-cloud-live-ui-20261003`，本轮起点 `8b7a3c0`。** 独立云迁移分支源于 M5 快照 `6901985`；原自建版目录及分支继续保留。云函数已部署并完成部分真实业务验证，尚未完成全部验收或上架。

本轮实施范围见 [U01–U10 真实联通与交互优化](docs/云版真实联通与交互优化计划.md)，完整迁移范围见 [PN01–PN09 个人版原生迁移](docs/微信个人版原生迁移计划.md)。用户已明确只用已购个人版；[C00–C05 计划](docs/云迁移实施计划.md)仅保留之前容器路线的开发记录。传统 HTTP、云托管、原生云函数分别配置，不自动回退。

- 功能与使用入口：[最新版功能介绍与使用说明](docs/最新版功能介绍与使用说明.md)
- 当前任务状态：[开发目标 TODO](docs/开发目标TODO.md) · [云迁移计划 C00–C05](docs/云迁移实施计划.md) · [自建版计划 S01–S09](docs/自建服务器后续开发计划.md)
- 当前验证：[个人版本地与云端验收](docs/verification/个人版原生迁移本地验证.md)；容器历史：[云迁移本地验证记录](docs/verification/云迁移本地验证记录.md)；历史证据：[M5 本地增强验证记录](docs/verification/M5本地增强验证记录.md)
- 架构决策（2026-10-03）：自建版与云版分别保存，个人版复用页面和业务协议、重写后端持久化；[个人版计划](docs/微信个人版原生迁移计划.md)记录已验证项目与待完成条件。

## 个人版：开发与验证

**真实环境进展（2026-10-03）：** `hyhqApi` 已部署到已购个人版；公开页面、资料检索、维护入口、真实微信登录、本人资料读取与修改均已成功。经用户授权，两项提供方 Key 已存入云端后端环境；真实 DeepSeek 文章问答、识别结果附图解读各完成一次，Markdown 列表及资料引用正常。最新包已于 22:01:27 更新到云端，本人图片分片上传、花卉模型识别雏菊及识别历史读取成功。河道也已在云内返回候选，花卉/河道切换和结果保持同页；两模型仅计作少量链路验证。北京 0 / 云 25,000 / 本机 1,000 天气配置切换已执行；天津、上海真实天气已返回，13 个地点选项及手动切换成功；主动定位经原生授权后第二次点击成功选中天津；天气缓存复用及缓存验证时的 6 笔成功上游记录已核对；管理、手机和供应商金额账单仍待验收。

| 本轮状态 | 已完成 | 仍待验证 |
| --- | --- | --- |
| 私有图片与模型 | 本人图片上传及两模型执行成功：花卉结果约 6,148 ms，河道约 8,730 ms；两个结果及历史可读 | 独立图片准确性、头像、跨账号图片隔离、过期删除 |
| 界面与交互 | 13 地点手选、主动定位选中天津；花卉/河道同页往返无递归更新警告；个人页圆形头像与六项横向入口、底部 AI 图案/圆环/标签同轴已确认 | Android/iOS、位置拒绝、弱网/窄屏、首次定位失败原因 |
| 真实账号与 AI | 登录、`me`、`PATCH me`；文章问答及识别附图解读各一次成功，Markdown 正常，后端回执共 2,072 token 已核对 | 收藏/隐私/多账号隔离、多轮长答、更多附图质量与供应商金额账单 |
| 自动验证 | 后端 227/227（含本机真实模型），前端 440/440；28 WXML、30 WXSS 编译 | 自动测试不替代多账号、手机及长期运行验收 |
| 私有配置 | DeepSeek 已启用：全站每日 50 次尝试、100,000 token；北京天气关闭/0，本机上限 1,000 已载入，云上限 25,000 已保存 | 供应商金额账单和长期配额观察 |

详细证据见[个人版验收记录](docs/verification/个人版原生迁移本地验证.md)。

原生函数源码位于 `cloudfunctions/hyhqApi/`，对应测试位于 `cloud-native/tests/`。已迁入公开资料、个人记录、身份绑定、分片图片、天气预算、AI 网关、两个 CPU 识别模型和管理维护模块。本地测试通过不代表云端或手机已通过，真实部署结果另记入验收记录。

```sh
npm ci --prefix cloudfunctions/hyhqApi --ignore-scripts
node --test cloud-native/tests/*.test.js
node --test miniprogram/tests/*.test.js
node scripts/prepare-personal-miniprogram.mjs --env ENV_ID --appid WECHAT_APP_ID
node scripts/package-personal-function.mjs --env ENV_ID --appid WECHAT_APP_ID \
  --flower-file-id FLOWER_CLOUD_FILE_ID --river-file-id RIVER_CLOUD_FILE_ID \
  --output miniprogram-personal/cloudfunctions/hyhqApi --maintenance true
```

本地测试使用当前操作系统的依赖。部署脚本另外生成 Linux x64 CPU 依赖；不能把 macOS 原生库上传，也不能用云端自动安装替代打包检查。先把本副本 `.runtime/cloud-migration/models/` 中两份固定模型上传到同环境私有存储，再提供其 File ID 打包；模型权重不进入 Git，也不占函数上传包。服务端下载后检查大小与 SHA，不接受任意模型或外部地址。见[模型私有存储与部署包](docs/verification/个人版模型私有存储与部署包.md)。真实模型对照需要额外指定模型和已生成的对照样本路径，普通测试会明确跳过该项。

微信开发者工具打开生成的 `miniprogram-personal/` 项目，选择已购环境。在数据库创建 `hyhq_data` 并设置所有用户不可直接读写；存储同样仅服务端可访问。云函数采用 Node.js 20.19，初始内存 512MB、超时 60 秒，关闭云端依赖安装。实际包体限制、Linux 执行、身份与权限必须云端另验。

API Key 仅放云函数环境变量；代码和前端不包含 Key。源码模板天气和 LLM 默认关闭；本次已授权环境的 DeepSeek 已启用并完成两次真实调用；云天气 25,000 上限已保存，天津、上海真实请求成功。管理端默认关闭并要求显式管理员名单。全项目天气每月及滚动 31 天不超过 3 万次；新分配及验证边界见下文。不自动升级套餐，不开按量付费。

详细验收拆分：[个人版原生迁移计划](docs/微信个人版原生迁移计划.md)。以下为先前容器方案记录。

## 云托管容器方案：已保存的本地成果

**本地开发完成，真实云部署未验收。** 后端 **597/597**、前端 **371/371**，微信 **26 WXML / 27 WXSS** 编译通过；分片上传、私有下载、授权音频、两个真实 CPU 模型及历史数据库迁移均完成隔离验证。没有调用 DeepSeek/和风，没有变更北京服务器。

- 云模式通过 `wx.cloud.callContainer` 访问固定环境和服务，支持分页、登录、超时、取消与账号隔离。缺配置会报错，无自动 HTTP 回退。
- 图片和音频通过受限 JSON 分块传输，保留图片净化、归属、发布状态和有效期检查；语音下载到设备后播放。退出清理私有缓存，云版隐私说明已补充。
- 后端保留 PostgreSQL；正式文件和模型使用 CFS 持久挂载。提供非 root 镜像模板、挂载/迁移检查、单组 worker、失锁停止和健康探针。
- 云版 `/admin` 暂不开放；通过受控维护命令管理。天气、LLM、评论、预报、订阅保持关闭，启用前核对凭据、原有条件和跨环境总预算。

用户已提供现有环境截图。服务名、地域及实际云托管能力待补充；本机没有容器运行时，**未构建镜像、未部署云服务、未完成真实云 SDK/微信身份/CFS/手机验收**。本地 HTTP 桥接替身的成功不能代替这些结果。

真实环境与服务确认并完成后端部署后，生成独立小程序目录（以下大写值需替换）：

```sh
node scripts/prepare-cloud-miniprogram.mjs --env ENV_ID --service SERVICE_NAME --appid WECHAT_APP_ID
```

在微信开发者工具导入生成的 **`miniprogram-cloud/`**，保持 `development:false` 与 `urlCheck:true`。AppID、环境和服务名是路由信息；AppSecret、数据库密码、API Key 只能放后端私有配置。生成目录已排除 Git，不能把本地桥接环境上传审核。

部署与恢复步骤：[云部署说明](deploy/cloud/README.md)；逐项状态：[C00–C05 实施计划](docs/云迁移实施计划.md)。下面的“新环境本地启动”适用于保留的 HTTP 开发方式。

## 既有自建版功能与使用方式

以下是保留的自建版能力清单；云版已部署和未验收项以上方 PN 记录为准，尤其真实天气、AI 和 Django 管理后台不因代码迁移自动启用。

底部有 **首页、生态导览、AI 识别、科普智游、我的** 五个入口，使用统一绿色导航、品牌图标与森系卡片界面。

| 模块 | 当前能力与入口 |
| --- | --- |
| 首页与真实天气 | 手动选择天津市、天津工业大学、天津师范大学、天津理工大学、北京市；查看和风天气、空气质量、预警及来源、时间、缓存状态。 |
| 生态导览、河湖、数据中心 | 静态示意图与地点列表切换；查看地点、站点、指标趋势和明细，按来源、模拟场景、成功批次与时间筛选，缺失数据保留断点。 |
| AI 识别 | 主动上传图片，提交五类花卉分类或河道漂浮物实验检测；展示候选、检测框、历史模型版本、图像教学规则说明及画面观察摘要。 |
| 科普智游 | 浏览已发布手记和路线，按区域、分类、植物标签、地点筛选；路线节点可进入地点详情。附新增 30 篇手记、30 条天津/北京漫步路线的离线资料包及来源。 |
| 资料检索 | “科普智游 → 资料检索”：按关键词、标签、地点检索已发布文章、路线和地点，返回原文摘录与可核对来源；无结果明确提示。属于确定性检索，尚非语义检索或多文档生成式 RAG。 |
| DeepSeek Flash | 识别解读，以及生态导览、科普智游的悬浮问答；服务端核验关联资料，支持 Markdown、引用跳转、历史会话、删除及可选识别附图。可主动选择天气地点，只读有效缓存，不因聊天刷新天气。 |
| 我的 | 微信登录适配、昵称与头像、收藏、浏览/游览/识别/AI 记录、个人反馈与管理员答复、浏览记录隐私开关、退出和注销。正式微信身份仍待完成配置和真机验收。 |
| 管理后台（HTTP 版；云入口关闭） | 用户、内容、地点、指标、模型和网关管理；统一北京时间统计口径，按权限查询；关键操作只读审计；模拟批次保留策略、清理预览及确认执行。 |

### 已实现，但当前未开放

| 能力 | 开放前须完成的事项 |
| --- | --- |
| 评论与举报 | 个人主体/服务范围核实、审核人员就绪、真实微信内容安全核验及后台确认。发布、审核、举报、删除、审计和并发保护已实现；条件未满足时前后端均关闭。见 [实现说明](docs/M5评论与举报实现.md)。 |
| 三日天气预报 | 核实和风账号权益后启用独立开关，与现有天气共用预算；首页不会自动增加预报请求。见 [天气预报与订阅](docs/M5天气预报与订阅实现.md)。 |
| 一次性天气订阅 | 核实微信主体/类目、模板和字段、主动授权及真实送达；一次授权对应一次提醒，支持取消、去重和失败处理，当前未启用发送调度。 |
| 文章/路线音频 | 管理员提供有权公开播放的音频并听审、导入，完成手机兼容性验证。无有效音频则隐藏播放器；当前没有正式讲解素材，不调用外部 TTS。见 [语音讲解说明](docs/M5语音讲解实现.md)。 |

## 数据与 AI 的边界

- **真实天气**来自和风；大学地点代表周边网格天气，并非校园传感器实测。上游不可用、缓存过期、明确无预警分别展示，缺失不等于安全。
- **河湖指标、历史生态图表和示范校园底图**主要是明确标注的科普模拟体验。真实天气没有混入模拟历史曲线；静态导览不提供真实 GIS 或实时导航。
- **科普与路线**由管理员发布，资料包保存来源、机构与查阅日期，采用有限事实整理和原创观察建议，不保证路线当下开放、连续通行、预约或无障碍条件。游览记录不是定位核验打卡。
- **花卉模型**只覆盖雏菊类、蒲公英类、蔷薇属花卉、向日葵类、郁金香类。当前 v1 阈值为 `0.0`，没有低分拒识，范围外图片也可能获得高分；分数不等于正确概率，不能用于食用或药用判断。
- **河道模型**仅开放已验证的 `class 9 / floating_debris`。候选框数、框并集占整图比例和九宫格位置是图片观察信息，不是实际污染密度、水面覆盖率或水质等级；未检出表示无法确认。
- **AI 问答**基于核验资料、本人识别记录和用户选定地点的有效天气缓存，没有联网搜索工具。陈旧或不可用天气会明确说明，不生成无依据的实时环境结论。

### 预算与私有配置

天气仅允许已实现的接口，**不开放热带气旋、海洋、辐照**。请求前记账，失败和超时计入限制，另有滚动 31 天保护。此前记录的分配为本机 **100 次**、北京 **29,900 次**。本轮已执行配置：**云端 25,000、本机 1,000、北京 0**，合计 26,000，留出 4,000 余量。北京关闭且健康，原账本本月 0 / 滚动窗口 15 保留；本机新上限已由 Django 实际载入，云端开关和预算于 22:16:42 保存。天津、上海真实云天气、缓存复用与云账本已核对（22:26–22:29 缓存验证时为 6 笔成功、无预留，后续到期可新增）；任何回退都须计入历史已耗，不能复制密钥后使用空账本重新计费。

DeepSeek 三个板块各自按北京时间限制每账号每天五个成功回合，前台只在超限时提示。另有全站尝试次数、token、并发和输出长度限制；删除会话不返还用量。保留现有网关与账本，金额以提供方账单为准。

真实 API Key 只放云函数后端环境变量、本机 Git 忽略的 `backend/.env` 或服务器受限环境文件；自建版需要的微信 AppSecret、数据库密码同样只放受限后端配置，不能进入小程序、README、日志或源码。仓库只提供空密钥示例；数据库、用户图片、授权音频、SSH 密钥和模型权重不随 Git 分发。

## 技术栈与目录

个人版新增 Node.js 20 云函数（`cloudfunctions/hyhqApi/`）、文档库/私有云存储、原生回归（`cloud-native/tests/`）和独立打包脚本。以下 Django 技术栈保留用于原自建版与容器历史方案。

- 后端：Python 3.12、Django 5.2 / DRF、PostgreSQL 17；既有北京基线验证过 Python 3.13。依赖锁定在 `backend/requirements.txt`。
- 小程序：原生 JavaScript / WXML / WXSS，基础库基线 `3.7.12`，内置固定版本 Markdown 解析器，无需 npm 安装或构建。测试使用 Node.js 20+。
- 推理：ONNX Runtime CPU；Web API 与花卉、河道、LLM 工作进程分离。两个图像消费者共用单主机执行锁，限时子进程执行；当前不能直接扩成多主机分布式推理。

```text
backend/        Django API、数据库迁移、管理后台与测试
miniprogram/    正式小程序源码；默认 HTTPS 与合法域名校验
inference/      模型清单、训练/评估流程和来源记录（不含权重）
deploy/         PostgreSQL Compose、Docker、Nginx、systemd 等模板
scripts/        启动、检查、模拟数据和隔离预览生成工具
docs/           功能说明、任务拆分、部署与验证记录
design/         品牌与插画资源说明
```

## 新环境本地启动

以下命令从仓库根目录执行，适用于**新建开发环境**。更新已有实例先备份数据库和私有文件，再迁移、重启；不要覆盖其 `.env`、重建业务库或重置预算。Git 快照不包含现有本机数据库及模型，克隆后仍须初始化。

### 1. 安装并配置

准备 Python 3.12、Node.js 20+、PostgreSQL 17 和微信开发者工具。可使用已有 PostgreSQL，或安装 Docker / Compose 后使用本地数据库模板：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
chmod 600 backend/.env

# 仅在需要新建本地 PostgreSQL 时执行：
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d db
```

配置 `backend/.env` 的 `DATABASE_URL`，匹配本地数据库。模板账号密码仅用于本机开发；更改 Compose 配置时同步修改连接配置。保持天气、LLM、评论、预报和订阅开关为 `0`，无需第三方密钥即可运行资料与模拟业务。

### 2. 迁移、导入资料并启动 API

```bash
scripts/manage.sh migrate --noinput
scripts/manage.sh seed_demo
scripts/manage.sh seed_recognition_knowledge
scripts/manage.sh seed_assessment_rules --activate
# 先预览，再导入仓库附带的 30 篇手记和 30 条路线：
scripts/manage.sh import_public_knowledge
scripts/manage.sh import_public_knowledge --apply
scripts/manage.sh createsuperuser
scripts/manage.sh runserver 127.0.0.1:8000
```

`seed_demo` 创建示范校园及正常场景模拟数据；资料包导入保留已有同 slug 内容，不覆盖管理员修改。来源见 [资料包说明](backend/knowledge/data/README.md)。另两种场景可运行 `scripts/simulate-current.sh turbidity` 和 `scripts/simulate-current.sh missing`。

启动后查看 [健康接口](http://127.0.0.1:8000/api/v1/health/) 与 [管理后台](http://127.0.0.1:8000/admin/)，使用自己创建的管理员登录。没有 PostgreSQL 时可用 `scripts/dev.sh --sqlite` 做基础开发；其他命令也须设置 `HYHQ_USE_SQLITE=1`。SQLite 不验证 PostgreSQL 行锁，也不会自动获得现有资料，与上述 PostgreSQL 方式二选一。

### 3. 按需启动模型和外部网关

| 能力 | 准备 | 另开终端执行 |
| --- | --- | --- |
| 花卉分类 | 按 [花卉推理说明](inference/README.md) 生成/复制 ONNX 和 manifest，登记并启用 | `scripts/manage.sh run_recognition_worker` |
| 河道观察 | 按 [河道推理说明](inference/river/README.md) 获取固定制品、校验并登记，启用教学规则 | `scripts/manage.sh run_assessment_worker` |
| DeepSeek | 私有环境配置 `DEEPSEEK_API_KEY`、`LLM_ENABLED=1`、模型 `deepseek-flash`；后台启用网关并设预算 | `scripts/manage.sh run_llm_worker` |
| 真实天气 | 配置 `QWEATHER_ENABLED`、专属 `QWEATHER_API_HOST`、`QWEATHER_API_KEY` 及已分配预算；见 [接入说明](backend/weatherdata/README.md) | API 按缓存和预算按需获取，无需独立模型进程 |

修改环境后重启相应 API/工作进程。没有模型时明确返回 `MODEL_NOT_CONFIGURED`，不输出假结果；没有 worker 时任务不能完成。训练依赖与服务端 CPU 推理依赖分开，部署时不安装训练框架。

### 4. 微信开发者工具预览

先启动本地 API。若开发者工具已打开旧预览，**先关闭该项目**，再生成副本并重新打开：

```bash
node scripts/prepare-miniprogram-preview.mjs
```

在开发者工具导入 **`miniprogram-preview/`**，副本固定连接 `http://127.0.0.1:8000/api/v1`，保持 `development: false`，不显示模拟登录，可先体验游客浏览和资料检索。正式登录需要匹配的 AppID 与后端私有 AppSecret；开发身份联调按 [小程序说明](miniprogram/README.md) 显式配置，仅限本地。

**预览目录被 Git 忽略，不能上传或用于审核。** `127.0.0.1` 在手机上不指向电脑。正式目录 `miniprogram/` 保留 `https://greatdata.asia/api/v1` 和域名校验。源码更新后重新生成预览，避免工具保留旧状态。

## 检查与验证

从仓库根目录执行；后端全量测试使用独立测试库，外部供应商使用测试替身：

```bash
ENV=test HYHQ_USE_SQLITE=0 LLM_ENABLED=0 QWEATHER_ENABLED=0 scripts/manage.sh check
ENV=test HYHQ_USE_SQLITE=0 LLM_ENABLED=0 QWEATHER_ENABLED=0 scripts/manage.sh makemigrations --check --dry-run
ENV=test HYHQ_USE_SQLITE=0 LLM_ENABLED=0 QWEATHER_ENABLED=0 scripts/manage.sh test --noinput
node --test miniprogram/tests/*.test.js
node scripts/check-miniprogram-compile.mjs
```

PostgreSQL 测试使用本地开发连接，建立独立 `test_…` 库：使用专用测试角色，或由本地管理员预建测试库后加 `--keepdb`；不要给生产业务角色增加建库权限，也不要把测试库指定为业务库。原生编译需已安装微信开发者工具。详见 [后端说明](backend/README.md) 与 [PostgreSQL 验证](docs/verification/M5本机PostgreSQL验证.md)。

### M5 历史验收：2026-09-24

以下是 **9 月 24 日历史实测**，不表示本次建分支时重新调用上游或重跑整套验收。

| 检查 | 结果与证据 |
| --- | --- |
| PostgreSQL 后端全量 | **517/517，0 跳过**，含真实本机 HTTP 和数据库并发锁；[记录](docs/verification/M5本机PostgreSQL验证.md)。 |
| 小程序自动回归 | **331/331**；**26 个 WXML、27 个 WXSS** 原生编译通过；[记录](docs/verification/M5本机前端验证.md)。 |
| 本机接口与管理 | **66/66**，覆盖检索、来源、权限、关闭条件和管理列表；[记录](docs/verification/M5本机接口与管理验证.md)。 |
| 两个现有 CPU 模型 | 花卉、河道各一次真实图片推理通过；证明当前样本与执行链可运行，不代表真实场景精度验收；[记录](docs/verification/M5本机模型验证.md)。 |
| 真实 DeepSeek | **2 轮成功，3,869 token**，回执与本地汇总一致；金额账单未核对；[记录](docs/verification/M5本机DeepSeek验证.md)。 |
| 开发者工具与业务库 | 检索、无结果、标签、全文、天气关闭页和五个底部页操作通过；本地业务库已备份迁移，原内容保留；[综合记录](docs/verification/M5本地增强验证记录.md)。 |

自动测试与模拟器不替代 Android/iOS 真机的微信登录、授权、相机/相册、音频、订阅及公网验收。真实长答质量、更广泛实拍评估、长期负载和恢复演练仍见 TODO。

## 模型与朋友仓库来源

- 花卉使用 TensorFlow `flower_photos`，冻结训练/验证/测试划分与许可记录，选用 EfficientNet-B0，保留 MobileNetV3-Small 对照。见 [训练说明](inference/training/README.md) 与 [评估报告](inference/reports/M3模型评估报告.md)。
- 河道来源于朋友的 [Intelligent-Platform-for-River-Ecological-Assessment](https://github.com/NEAZ71eve/Intelligent-Platform-for-River-Ecological-Assessment)，已适配固定 ONNX 模型、私有任务、教学规则和历史记录，不是整仓覆盖；见 [原整合说明](docs/朋友仓库整合说明.md)。
- 本轮核对固定提交 `d3ed39b00036a8f717a1360303e3e3db61b5c9b1`，新增 HYHQ 自行实现的画面观察摘要，并将上游验收用途适配为只读 `check_assessment_runtime`。未复制无操作文件锁、全局队列消费，也未切换未经验证的 v2–v5 权重；见 [本轮差异与移植](docs/朋友仓库本轮差异与移植.md)。
- 权重按各自说明单独准备。朋友授权复用代码不替代第三方数据、权重及素材的许可核对；来源与署名见 [第三方来源说明](THIRD_PARTY_NOTICES.md)。

## 部署、发布与后续方向

此前北京已部署天气/AI/管理基线为 `d4d0bed`，上一源码与文档快照为 `c7bbdbf`。数据库、依赖和四个服务的历史验证见 [北京天气版本部署与回退](docs/北京天气版本部署与回退.md)；**不表示本分支 M5 已在北京运行。**

个人版通过云函数访问业务，不以自建域名放行作为其请求通道前提；真实登录已通过，正式发布仍需完成平台隐私/接口条件、模型和手机全流程。自建 HTTP 版本仍有域名/HTTPS 等独立条件，历史记录见 [联调记录](docs/verification/上线联调记录.md)。本轮北京只涉及已授权的天气预算调整，执行结果以本轮记录为准，不表示其业务代码已升级为云版。

个人版下一步为图片权限与模型质量补验 → 多账号/管理/手机/账单验收；不再把镜像和 CFS 作为本路线前提。自建分支仍按自己的发布自检、恢复演练、监控和手机计划独立推进。预报、音频、评论与订阅按条件逐项启用；真实地图和历史/河湖数据在后续批次实施。详见 [S01–S09 计划与验收](docs/自建服务器后续开发计划.md)。综合生态指数、垃圾分类、多文档生成式检索、多供应商路由及本地 LLM 继续保留为未开发事项。

### 进一步阅读

- [开发方案稿](docs/开发方案稿.md) · [开发目标 TODO](docs/开发目标TODO.md)
- [后端接口与开发说明](backend/README.md) · [小程序开发说明](miniprogram/README.md)
- [部署与运行模板](deploy/README.md) · [北京首次部署与回退](docs/北京服务器部署与回退.md)
- [微信接口申请填写说明](docs/微信接口申请填写说明.md) · [森系界面与发布准备](docs/森系界面与发布准备计划.md)
- [M5 资料检索与 AI](docs/M5资料检索与AI验证说明.md) · [模拟批次维护](backend/ecology/MAINTENANCE.md)
- [数据接入与管理计划](docs/数据接入与管理实施计划.md) · [生态导览真实地图 EG01–EG10](docs/生态导览真实地图接入TODO.md) · [高德与百度历史调研](docs/高德与百度数据接入方案.md)
