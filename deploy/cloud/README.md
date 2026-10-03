# HYHQ 微信云托管版本（独立部署准备）

本目录仅用于 `codex/wechat-cloud-20261003` 的云版本。原北京服务器及自建版本继续保留。当前交付是代码、隔离测试及部署模板；**尚未创建云环境、购买资源、构建/上传容器或完成微信真机云调用验收**。本机无 Docker 运行时，不能将静态检查称作镜像构建通过。

## 首期架构与约束

小程序 `wx.cloud.callContainer` → 云托管容器（Django + Gunicorn + 单组后台 worker）→ 原生 PostgreSQL；私有媒体和已审核的模型文件放在同地域 CFS 持久挂载。此次使用后端鉴权的分片文件传输，不直接开放存储桶或公开媒体 URL。

- 容器服务 **最小实例 1、最大实例 1**，关闭缩容到零；先采用停旧再启新的部署方式，禁止滚动重叠 worker。
- 一个 supervisor 持有 PostgreSQL **session advisory lock** 后才启动花卉、河湖、LLM 三个 worker；任何子进程退出、持锁连接断开或锁丢失都会停止全组并失败退出。该专用连接不经过连接池、不自动重连；不能使用 transaction-pooling 数据库代理。
- 两个图像 worker 使用同一**容器本地** `fcntl` 锁；它不是多主机分布式锁。CFS 只保存文件和模型，不能用 CFS 的 `flock` 代替数据库与部署隔离。
- 数据库 session lock 是防止误起第二组 worker 的保护，**不是网络分区时的绝对防双执行机制**。连接失效到子进程终止之间存在检测窗口。此期不能扩容，也不能新旧部署共享队列同时运行。
- 自建服务器的原 worker 不认识云 gate；迁移同一数据库之前必须停止旧 worker，并证实推理子进程已退出。安全首选是**独立云测试库**，对脱敏备份做演练，不与生产共享执行队列。
- 常规 API 保留 HTTPS、Bearer 鉴权、原微信 `code2Session` 登录。不会将调用者自行传入的 `x-wx-openid` 视为已验证身份。
- 云服务 `/admin` 及 `/admin/…` 固定返回 404。此期没有开放公网/云调用管理后台；使用受控维护通道运行明确的管理命令。若保留浏览器 Admin，应另行设计 SSH/VPN 等可信通道，不能直接公开第二个入口。

官方依据：[微信云调用及关闭公网入口](https://docs.cloudbase.net/run/develop/access/mini)、[云托管概述](https://docs.cloudbase.net/run/introduction)、[CFS 挂载](https://docs.cloudbase.net/run/deploy/configuring/storage/cfs)。实际地域、CFS/数据库可用规格及费用以账户控制台为准。

## 配置与持久目录

以 `backend.env.example` 为字段清单，把值放到云平台私有环境配置。不要提交真实 `.env`、私钥、数据库 URL、媒体或模型。

| 字段 | 要求 |
|---|---|
| `ENV`, `DJANGO_DEBUG`, `ALLOW_DEV_AUTH` | `production`, `0`, `0` |
| `DJANGO_SECRET_KEY` | 随机独立密钥，至少 32 字符，与自建版隔离 |
| `DJANGO_ALLOWED_HOSTS` | 实际云内部域名/探针 Host，明确枚举，不能 `*` |
| `DATABASE_URL` | 显式 PostgreSQL 账号密码；生产使用可信 CA 校验的 TLS，数据库私网访问 |
| `HYHQ_CLOUD_ENV_ID` | 真实关联的云环境标识 |
| `HYHQ_CLOUD_PRIVATE_INGRESS_CONFIRMED` | 控制台关闭公网访问并复核后才设 `1` |
| `HYHQ_CLOUD_TRUST_PROXY_HTTPS` | 确认平台覆盖 `X-Forwarded-Proto` 后才设 `1` |
| `HYHQ_CLOUD_MOUNT_ROOT` | 实际 CFS 挂载点，默认 `/mnt/hyhq` |
| `HYHQ_MEDIA_ROOT` | `/mnt/hyhq/private`，仅 UID/GID `10001:10001` 可写 |
| 私有音频目录 | 默认 `/mnt/hyhq/private-narration`（`MEDIA_ROOT` 的同级目录），同样需要 `10001:10001` 权限；无授权音频时可为空 |
| `HYHQ_MODEL_ROOT`, `HYHQ_ASSESSMENT_MODEL_ROOT` | `/mnt/hyhq/models`，挂载后读模型，模型文件另行核对摘要 |
| `HYHQ_RECOGNITION_LOCK_PATH` | `/tmp/hyhq-runtime/inference.lock`，两个推理 worker 共用 |
| `WECHAT_APP_ID`, `WECHAT_APP_SECRET` | 对应真实小程序；不配置则不启动/不就绪 |

维护通道预先建立私有目录、所有权及 `.hyhq-volume-id` 文件，文件内容必须恰好为 `HYHQ_CLOUD_ENV_ID`。不要用镜像内同名空目录冒充 CFS：启动及 readiness 同时检查真实挂载（`ismount`/Linux mountinfo）、环境标记、目录位置/可读性和私有目录写入能力。检测只能证明挂载和权限成立，**不能证明存储的备份/容灾质量**。CFS、数据库、模型、微信身份的最终平台验证尚待完成。

DeepSeek / 和风天气默认关闭且 Key 留空，可以正常启动其余模块。启用前迁移完整用量账本、核对所有部署合计天气请求预算及用户 AI 限额；不能给新环境空账本后继续使用原项目的同一 30,000 次预算。热带气旋、海洋、辐照接口仍不接入。

可选评论、预报、订阅也保持关闭，原有资质和审核条件仍然适用。

## 构建与显式初始化

从项目根目录构建；只有源码进入镜像，模型通过挂载供应：

```sh
docker build -f deploy/cloud/Dockerfile -t hyhq-cloud:review .
```

国内构建可选可信镜像，例如额外传 `--build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`。不使用 `--trusted-host` 或关闭 TLS。正式发布还应记录基础镜像 digest、依赖清单及构建日志。

入口只有三种操作：

- `serve`：预检数据库迁移/持久挂载/微信配置，通过后启动 supervisor；**不执行 migrate、seed、模型激活或外部 API 调用**。
- `check`：输出布尔预检结果，失败退出；不会回显凭据。
- `manage <command>`：维护窗口中显式执行某条 Django 管理命令。原 `run_recognition_worker`、`run_assessment_worker`、`run_llm_worker` 在云配置中拒绝单独运行。

首次安装顺序：完成独立 PostgreSQL/CFS 私网连通及凭据 → 挂载和标记 → 使用镜像执行 `manage check` → 备份后显式 `manage migrate --noinput` → 必要的内容导入/模型注册与摘要检查 → `check` → 启动 `serve`。不对已存在业务库随意执行 seed。

镜像以 UID/GID `10001` 运行、`umask 077`。不在容器内安装训练框架，不构建任何用户上传的代码。部署端口为 8000，终止宽限建议至少 20 秒；资源容量要用真实模型验证，不把自建服务器的实测结果直接当作云规格保证。

## 健康探针

- `GET /_cloud/live`：仅进程 HTTP 存活，返回 `{ "ok": true }`。
- `GET /_cloud/ready`：微信配置存在、PG 连通、无未应用迁移、挂载有效及 supervisor 最近心跳全部通过才返回 200，否则 503。响应只有 `ok`，不泄露目录、凭据、环境 ID、数据库信息。
- 只有这两个精确路径允许平台内部 HTTP 探测；其他路径仍执行 HTTPS 安全逻辑。探针不构成用户身份凭据，不触发收费提供方调用。
- `HYHQ_CLOUD_ROLE=api` 仅是未来拓扑预留；本期 supervisor 和 readiness 拒绝它，不能宣称已经支持 API 横向扩容。

## 隔离测试模板

`compose.test.yml` 使用独立 PostgreSQL volume、loopback 端口 `127.0.0.1:18080` 及 `.runtime/cloud-test-volume`。不要传生产库 URL、真实第三方 Key 或现网媒体目录。测试库密码只用于该临时库；`.runtime/cloud-test.env` 保持 Git 忽略。

准备目录/volume marker，并在 `.runtime/cloud-test.env` 中添加仅供该临时库使用的 `CLOUD_TEST_DB_PASSWORD`（使用随机十六进制等 URL 安全字符）。文件权限设为 `600`；完整填写其余字段后，从项目根目录执行：

```sh
docker compose --env-file .runtime/cloud-test.env -p hyhq-cloud-rehearsal -f deploy/cloud/compose.test.yml up -d postgres
docker compose --env-file .runtime/cloud-test.env -p hyhq-cloud-rehearsal -f deploy/cloud/compose.test.yml run --rm app manage migrate --noinput
docker compose --env-file .runtime/cloud-test.env -p hyhq-cloud-rehearsal -f deploy/cloud/compose.test.yml up app
```

`--env-file` 用于 Compose 自身的密码插值；服务内的 `env_file` 只负责容器环境，不能代替该参数。初次 CFS 以本地 bind mount 代替只验证文件协议，**不算 CFS 云验证**；真实微信登录配置不在假凭据下验收。仅在确认这是临时 project 后使用 `… down -v` 清除这个测试库，禁止复用现网 project 名。

运行代码测试使用独立测试 PostgreSQL：

```sh
ENV=test HYHQ_USE_SQLITE=0 DATABASE_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:55438/TEST_DATABASE' \
  .venv/bin/python backend/manage.py test cloudruntime --noinput
```

这会创建 Django `test_…` 数据库；账号需具备只限测试环境的建库权限。若借用另一工作目录解释器，用其绝对路径替换 `.venv/bin/python`。测试不会联系付费 API。

## 暂存上传维护

通过受控维护任务每 10 分钟运行镜像的 `manage cleanup_cloud_uploads`，使用同一私有卷和数据库。未完成上传默认 1 小时过期，过期但尚未清理的分片仍占暂存配额；应监控清理失败和剩余空间。该维护命令不启动推理/LLM worker，不需要绕过单组执行限制。云平台的定时任务配置仍待实际部署验收。

Gunicorn 访问日志只保留请求方法、路径、状态和耗时，不记录 query、请求头或请求体；异常日志遵守应用已有敏感信息过滤。云日志也应设置合理保留周期和访问权限。

## 升级、迁移与回退

1. 明确维护窗口、独立数据库和服务标识，关闭进入待切换实例的新任务；保留当前已验证镜像 tag/digest。
2. 停止旧 API/worker 接收新任务，确认旧 supervisor、worker 和推理子进程全部退出。不要依赖 cloud gate 去排斥旧 systemd worker。
3. 在静止状态下备份 PostgreSQL、私有媒体（包括同级 `private-narration` 音频目录）、模型/规则清单与配置引用，记录每份摘要及一致时间点；先在独立环境证明备份能恢复。数据库 dump 单独不构成完整恢复。
4. 显式应用迁移，检查迁移计划与数据保留情况；挂载原已确认卷，启动新版本单实例。新实例抢不到 gate 应失败退出，不强杀不明持锁会话。
5. 检查探针、登录、来源资料、私有文件越权、任务恢复、每模块限额与跨部署天气总预算；恢复流量后观察错误率/队列/磁盘。
6. 若新版本失败，先停新进程。仅在确认数据库 schema 向后兼容时切回旧镜像；有不兼容迁移时，从同一一致备份恢复**数据库与文件整套**到隔离位置后切回。禁止在有新用户写入时直接覆盖旧备份。
7. 恢复前对账备份后已发生及结果未知的外部调用用量、已发提醒、授权取消和用户删除。回退不能返还额度、重复发送或恢复已删除个人数据；无法可靠合并时保持外部服务关闭，完成核对后再恢复。

云平台真实部署还需核实：小程序与云环境同主体关联、callContainer 可用性、关闭公网、TLS 代理信任、CFS/PG 地域网络、镜像构建、微信真机文件传输、计费预算与生产审核。本目录准备工作不替代这些验收。
