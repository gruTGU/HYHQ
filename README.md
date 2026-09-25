# HYHQ 海晏河清智慧平台

面向校园及周边河湖、公园的微信小程序，提供生态资料浏览、自然观察、科普学习、漫步路线和 AI 辅助解读。项目采用原生微信小程序、Django 后端和 PostgreSQL，生态模拟、真实天气及图像观察结果分别标明来源与适用范围。

**当前快照：`codex/m5-verified-snapshot-20260925`。** 本分支保存森系界面、公开科普与路线资料包、M5 增强功能和 2026-09-24 本机验证后的修复。它是可继续开发、复现和测试的完整源码快照；**本批 M5 尚未部署北京服务器，也未上传、提审或上架小程序。**

- 功能与使用入口：[最新版功能介绍与使用说明](docs/最新版功能介绍与使用说明.md)
- 当前任务状态：[开发目标 TODO](docs/开发目标TODO.md) · [M5 拆分计划](docs/M5本地开发实施计划.md)
- 验证证据：[M5 本地增强验证记录](docs/verification/M5本地增强验证记录.md)
- 架构备选：[微信云开发迁移可行性](docs/微信云开发迁移可行性.md)——目前仅评估，代码仍使用 Django / PostgreSQL 架构。

## 功能与使用方式

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
| 管理后台 | 用户、内容、地点、指标、模型和网关管理；统一北京时间统计口径，按权限查询；关键操作只读审计；模拟批次保留策略、清理预览及确认执行。 |

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

天气仅允许已实现的接口，**不开放热带气旋、海洋、辐照**。请求前记账，失败和超时计入限制，另有滚动 31 天保护。现有分配为本机每月 **100 次**、北京 **29,900 次**，合计不超过 **30,000 次**；新增环境必须重新分配同一账号预算并延续账本，不能复制密钥后使用空账本重新计费。

DeepSeek 三个板块各自按北京时间限制每账号每天五个成功回合，前台只在超限时提示。另有全站尝试次数、token、并发和输出长度限制；删除会话不返还用量。保留现有网关与账本，金额以提供方账单为准。

真实 API Key、微信 AppSecret、数据库密码只放在 Git 忽略的 `backend/.env` 或服务器受限环境文件中，不能进入小程序、README、日志或源码。仓库只提供空密钥示例；数据库、用户图片、授权音频、SSH 密钥和模型权重不随 Git 分发。

## 技术栈与目录

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

### 最近一次实际验收：2026-09-24

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

正式发布需完成服务器访问方案、微信登录、平台隐私/接口配置和完整手机验收。用户已反馈小程序备案成功，网站域名放行及 HTTPS 的历史阻塞见 [联调记录](docs/verification/上线联调记录.md)；两者需分别核验。云开发目前仅评估，客户端访问方式、数据库和部署均未迁移。

后续优先：确定服务器/云开发方案 → 正式身份与手机联调 → 逐项核实开放评论、预报、订阅和音频 → 提升真实数据与模型效果。真实地图导航、真实校园/河湖监测接入、综合生态指数、垃圾分类、多文档生成式检索、多供应商路由及本地 LLM 尚未实现。

### 进一步阅读

- [开发方案稿](docs/开发方案稿.md) · [开发目标 TODO](docs/开发目标TODO.md)
- [后端接口与开发说明](backend/README.md) · [小程序开发说明](miniprogram/README.md)
- [部署与运行模板](deploy/README.md) · [北京首次部署与回退](docs/北京服务器部署与回退.md)
- [微信接口申请填写说明](docs/微信接口申请填写说明.md) · [森系界面与发布准备](docs/森系界面与发布准备计划.md)
- [M5 资料检索与 AI](docs/M5资料检索与AI验证说明.md) · [模拟批次维护](backend/ecology/MAINTENANCE.md)
- [数据接入与管理计划](docs/数据接入与管理实施计划.md) · [高德与百度接入方案](docs/高德与百度数据接入方案.md)
