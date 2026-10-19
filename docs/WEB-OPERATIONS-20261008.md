# 网页生产运行与回退

## 当前部署（2026-10-19）

- 当前版本 `20261019-activities-environment`；上一版 `20261011-single-picker` 保留。
- 地方活动、站内订阅、识别环境反馈及管理工作流已上线。活动和上报均是明确的模拟演示。
- 数据库备份、验证范围及回退说明见 [本轮记录](ACTIVITIES-ENVIRONMENT-20261019.md)。
- 以下2026-10-11及更早内容为历史记录。


## 当前部署（2026-10-11）

- 当前版本：`/srv/hyhq-web/releases/20261011-single-picker`；上一版 `20261011-observation-backgrounds` 保留可回退。
- 花卉识别与河道观察删除重复的“使用相机”入口，保留“拍照 / 选图”；生产构建及浏览器入口检查通过。此项纯界面删减未重复运行全量测试。
- 数据库备份：`/srv/hyhq-web/backups/20261011-single-picker`；共享数据、模型、密钥与预算保持，健康及公网构建资源核对通过。

## 2026-10-11 识别背景版本记录

- 正式服务：`https://greatdata.asia`，`hyhq-web.service`，入口链接 `/srv/hyhq-web/current`，回环端口 `18787`。
- 当前版本：`/srv/hyhq-web/releases/20261011-observation-backgrounds`；在每日天气、模拟异常提醒和河道 AI 看图基础上，移除模拟通知的天气链接，加入纪实自然志花卉/河道选图区照片背景。
- 上一版本：`/srv/hyhq-web/releases/20261011-river-ai`；更早的 `20261011-weather-instant` 与 `20261009-cover-alignment` 均保留。
- 每次部署先通过 SQLite backup API 保存一致性副本；本次备份在 `/srv/hyhq-web/backups/20261011-observation-backgrounds`，仅管理员可读。此前两次备份均保留。
- 沿用 `/srv/hyhq-web/shared/private` 的数据库、上传、模型和环境；部署前后环境文件摘要一致，未改密钥、天气预算、站点或 HTTPS 配置。
- 发布前全量 135 项测试与构建通过，390 px 手机及 1365 px 电脑背景排版已核对。发布后核对健康接口及公网 HTML、JS/CSS、两张图片与发布包相同。此前真实浏览器选图被权限审批拒绝，未声称看图全链路已实测。
- 每个版本的 `PREVIOUS_RELEASE` 保存可回退目标。回退只切换 `current` 并重启服务；失败应切回本版本。不要用较旧数据库覆盖当前用户数据或额度账本。

## 2026-10-08 历史部署

- 入口：https://greatdata.asia；独立网页服务 `hyhq-web.service`。
- 当前版本：`/srv/hyhq-web/releases/20261008-campus-themes`；上一版 `20261008-home-layout`。校园点位与主题入口更新仅涉及代码及静态资料，沿用当前共享数据库和私有环境。
- 入口链接：`/srv/hyhq-web/current`；后端回环端口 `18787`。
- 数据、环境与模型：`/srv/hyhq-web/shared/private`，不在源码或 Git 中。
- 上一轮备份：`/srv/hyhq-web/backups/20261008-2025`，包括一致性 SQLite 备份、旧环境配置、Nginx 配置与上一版路径。
- 网页后台抓取只运行于生产：天津、北京，实况/空气/预警每小时，预报每 6 小时；网页硬上限 15,000。云小程序另设 15,000。本机自动抓取关闭。

## 代码回退

当前目录的 `PREVIOUS_RELEASE` 记录本轮上一版路径。回退本轮可将 `current` 切回 `20261008-home-layout` 并重启服务，校园点位属于代码内静态数据，随版本一起回退。

早期升级另提供 `scripts/rollback-web-20261008.py`，复制到北京服务器后由 root 运行。脚本先验证目标目录，切换回上一版并做健康检查；失败则恢复当前版本。它保留当前共享数据库、用户内容、密钥和所有计费账本，不覆盖旧数据库，不清零额度。

本轮没有在生产执行回退，以免打断已验证服务；已检查脚本语法。上一版没有本轮博客/游客/验证码界面，回退后需要重新检查页面和接口。脚本只回退代码，当前 Nginx 的 8 MiB 请求上限及私有环境保留；不要把早期全量数据库备份直接覆盖正在使用的库。

## 后续运维

- 查健康：`https://greatdata.asia/api/v1/health/`。
- 查看服务运行和日志：`systemctl status hyhq-web.service`、`journalctl -u hyhq-web.service`。
- 天气页面访问只读缓存，不要用删除账本或更换 Cookie 的方式测试计费上限。
- 备份含私人数据，保持仅管理员可读。运营者、邮箱、备案展示待提供准确资料后填入后端环境。
