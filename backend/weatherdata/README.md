# 和风天气接入

真实天气采用独立的 `weatherdata` 表和 API，不写入模拟 `Observation`，也不会替换或挪用虚构校园坐标。公开请求只接受后台已配置且启用的地点短名。位置精度遵循上游接口的小数点后两位，校园入口代表附近气象网格，不代表校园内的传感器观测。

## 可用接口

- `GET /api/v1/weather-data/locations/`：返回 `{items, enabled, forecast_enabled}`；地点包含 `slug/name/latitude/longitude/coordinate_system/scope_note`。
- `GET /api/v1/weather-data/summary/?location=beijing`：返回地点及 `weather/air/alerts`。仅允许一个 `location` 参数，禁止客户端坐标、任意 URL、类别或强制刷新参数。
- `GET /api/v1/weather-data/<slug>/forecast/`：独立三日预报；功能及权益确认开关默认关闭，不随首页 summary 自动调用。

仍沿用项目的 `{data, request_id}` JSON 外层。每个组件包括：

| 字段 | 含义 |
| --- | --- |
| `status` | `fresh`、`stale`、`unavailable`；预警成功且 `zeroResult=true` 时为 `empty` |
| `data` | 规范化业务数据；从未成功取得数据时为 `null` |
| `fetched_at / expires_at` | 本机成功取数时间与缓存过期时间，均保留时区 |
| `observed_at` | 新版天气与空气接口未提供独立观测时间，保持 `null`，禁止用抓取时间冒充 |
| `attributions` | 上游数据声明，必须和数据共同展示；可能包含网址与文本 |
| `refer.sources / source_label / source_kind` | `QWeather` / 和风天气 / `api` |
| `reason` | 缺凭据、刷新中、冷却、预算耗尽或上游错误等受控代码，不含上游原始错误或凭据 |

过期预警即使上一次结果为空，也显示 `stale`，不能声称“目前无预警”。预警条目保留发布/生效/到期时间、发布机构、取消或更新类型及指导说明。空气质量保留上游指数名称/代码与污染物原始单位，不把国外 AQI 冒称中国 AQI。

官方 `metadata.zeroResult=true` 明确表示请求成功但无数据，因此该标志出现时允许上游省略 `alerts` 或返回 `null`，规范化为空列表；没有明确标志、标志与非空列表矛盾、类型错误或请求失败仍返回不可用。

## 请求预算与缓存

默认天气 30 分钟、空气 60 分钟、预警 15 分钟缓存，均持久化并按地点、类别、坐标区分。五地点连续高频访问时，常规成功刷新约为 `5 × 31 × 24 × (2 + 1 + 4) = 26,040` 次/月。

每次出站前在 PostgreSQL 事务内锁定全局门控行、检查预算并写入不可退款的请求预占。失败、超时、进程退出均计入；没有网络自动重试。每部署同时限制**北京时间自然月**和**过去 31 天**的请求数，防月边界及上游结算时区差异；硬上限 30,000。滚动窗口可能在新月继续限制请求，这是预期行为。

同一账号两个数据库必须分配互不重叠的预算：本机 `100`，服务器 `29900`。不要在其他应用使用该凭据额外调用；不要恢复旧账本、删除请求记录或临时提高某部署预算。应用不能统计绕过它的调用，所以账号级免费额度仍需在和风控制台核对。部署前若已有外部调用，须从剩余额度扣除后分配。

每部署最多 15 次/分钟；同一缓存有 60 秒跨进程租约，普通失败冷却 10 分钟，429 全局冷却 1 小时，401/402/403 冷却 24 小时。管理员刷新同样受缓存、冷却和预算约束，没有强制消耗入口。月份与请求记录在后台只读，不允许新增、修改或删除。

## 安全配置

仅后端环境变量保存 `QWEATHER_API_KEY` 和专属 `QWEATHER_API_HOST`；凭据 ID 不用于 API Key 请求。主机只允许 `qweatherapi.com` 下合法专属域名（支持区域子域），通过系统 CA 校验证书。认证只在 `X-QW-Api-Key` Header 中，不进入 URL、日志、数据库或前端。

固定允许且仅允许：

1. `/weather/v1/current/{latitude}/{longitude}`
2. `/airquality/v1/current/{latitude}/{longitude}`
3. `/weatheralert/v1/current/{latitude}/{longitude}`
4. `/weather/v1/daily/{latitude}/{longitude}?lang=zh&days=3`（仅预报及权益确认开关同时开启时允许）

热带气旋、海洋、辐照没有连接器或公开请求入口。客户端无法指定路径。使用标准库 HTTPS，无重定向、代理环境继承或重试；响应及 gzip 解压均限制 256 KiB，错误不保存原始正文。

## 初始化与维护

```sh
python manage.py migrate
python manage.py weather_location --slug beijing --name 北京市 --latitude 39.9042 --longitude 116.4074 --source '已核对的 WGS84 城市代表点' --order 0
python manage.py weather_refresh --location beijing
python manage.py weather_refresh --location beijing --fetch
```

地点配置与默认刷新预览均不发送外部请求。`--fetch` 才会按三类缓存策略取数。后台“真实天气与请求预算”可维护地点、核对只读账本及缓存；配置改动和维护检查进入业务审计。禁用再启用不会删除历史账本。修改坐标建立新的缓存键，不再把旧坐标数据发布为新地点数据。

## 三日预报、AI 上下文与一次提醒

预报使用独立 6 小时缓存，仍共享原有持久预算。`weather_refresh --forecast` 仅预览，额外加 `--fetch` 才可能出站。AI 的 `build_public_weather_context` 只读明确地点的缓存，过期数值不传给模型，不增加天气调用。

一次性提醒必须经用户点击并获得微信授权；能力、模板和凭据门禁默认关闭。`weather_reminders` 只预览，额外加 `--send` 才可能发送。worker 只用新鲜缓存，不刷新天气；结果不明的消息不自动重发。配置、接口、迁移、待核实项与隔离测试见 [M5 天气预报与订阅实现](../../docs/M5天气预报与订阅实现.md)。

## 已核对官方文档（2026-09-21）

- [实时天气](https://dev.qweather.com/docs/api/weather/weather-current/)
- [实时空气质量](https://dev.qweather.com/docs/api/air-quality/air-current/)
- [实时天气预警](https://dev.qweather.com/docs/api/warning/weather-alert/)
- [API Host](https://dev.qweather.com/docs/configuration/api-host/)
- [身份认证](https://dev.qweather.com/docs/configuration/authentication/)：现有 API 支持 API Key；官方说明 2027-01-01 起限制该认证方式的每日调用量，届时应评估迁移 JWT。
