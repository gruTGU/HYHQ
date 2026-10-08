# 独立网页版 API

更新：2026-10-08。正式站点为 `https://greatdata.asia`，本地调试地址为 `http://127.0.0.1:8787`。API 统一前缀 `/api/v1/`，下文部分路径省略该前缀。业务以小程序提交 `1080ad3` 为基线，在独立网页中继续实现账号防刷、游客、人工审核博客、腾讯地图和后台天气缓存；不与当前小程序代码或私有数据库实时同步。`backend/vendor` 为可审阅源文件副本，不包含云凭据、生产用户或微信 SDK。

## 启动与数据

在项目目录运行 `npm --prefix backend install`、`node backend/bootstrap.cjs`、`npm run build`、`npm start`。初始化脚本只通过本机 CLI 创建管理员，密码写入 `.private/admin-credentials.md`，权限 600；重复执行不会更改现有管理员。普通注册永远没有管理权限。

服务读取 `.private/local.env`，已有环境变量优先；不打印密钥。账号、哈希密码、会话、覆盖资料、使用量和审计存于 `.private/hyhq.sqlite3`（WAL、完整同步），规范化图片在 `.private/uploads`。本机与生产网页使用各自运行目录；旧云账号与云私有数据不会导入。不要删除数据库以重置服务预算。

## 通用格式与账号

JSON 请求必须 `Content-Type: application/json`。返回 `{ "data": ... }`，分页附带 `meta`；错误为 `{ "error": { "code": "...", "message": "..." }, "request_id": "..." }`。204 无响应体。本站浏览器 `fetch` 使用 `credentials: 'same-origin'`。会话保存在 `HttpOnly; SameSite=Strict; Path=/api/` cookie，7 天有效，API 不返回 token。开发回环 HTTP 不加 Secure；生产经 HTTPS 反代并启用 Secure Cookie，应用端口仍只监听回环地址。

- `GET /api/v1/web/captcha/?purpose=register|login`：返回官方 ALTCHA 原始挑战 JSON（此接口不套 `data`）。前端 Widget、中文和计算 worker 同源打包，由用户点击完成验证，注册/登录请求携带 `altcha` 字符串。挑战五分钟有效，绑定用途及 IP 摘要；服务端真实验签并以事务一次性消费，密码错误后也须重新验证。
- `POST /api/v1/auth/register/`：`{"email":"user@example.test","password":"a","nickname":"用户","agreement":{"accepted":true,"version":"2026-10-07"},"altcha":"用户刚完成的验证载荷"}`。可用 `username` 替代 `email`。密码接受任意非空内容，不 trim，不限制字符组合；上限 128 个 UTF-16 字符及 512 个 UTF-8 字节。使用每账号随机盐与 scrypt；协议必须由用户明确勾选。返回 `{user, expires_at}` 并写 cookie。
- `POST /api/v1/auth/login/`：提交 `email` 或 `username`、原样密码及用途为 login 的 `altcha`；登录页同时提交用户勾选后的 `agreement`。返回相同格式。管理员实际密码只见受限凭据文件。
- `POST /api/v1/auth/logout/`：`{}`，撤销当前会话。
- `GET /api/v1/me/`：`{id,nickname,email,username,role,auth_kind:"local",avatar_url,record_history}`。
- `PATCH /api/v1/me/`：`{"nickname":"新昵称","record_history":true,"avatar_asset_id":"UUID或null"}`，字段均可独立提交。
- `DELETE /api/v1/me/`：`{}`，停用并清理个人记录、图片、草稿、会话、预约、通知和密码凭据。匿名预算与管理审计保留。

身份仅从 cookie 对应的数据库会话读取，忽略客户端 OPENID、APPID、Bearer 或角色字段。Host、Origin、请求大小、会话有效期、账号存活状态与对象归属在服务端校验。验证码与认证各按可信 IP 限十五分钟 30 次；完成防刷后再计入账号失败限制。仅 `HYHQ_TRUST_PROXY=loopback` 且直接连接来自回环反代时采信单一合法转发 IP；生产 Nginx 必须覆盖该头。公网直接伪造或逗号链不会被采信。

## 游客体验

- `POST /web/guest-session/`：`{}`，建立随机 HttpOnly 游客 Cookie；`GET /web/guest-session/` 恢复本人游客会话和额度状态。必要会话用于本人数据归属，不等于注册账号。
- 北京时间每日同公网 IP 花卉与河道合计 5 次，AI 的 home/explore/learn/recognition 各 5 次；事务预留和结算，清 Cookie 不重置额度。同 IP 下不同 Cookie 仍不能读取彼此图片、任务与会话。
- 游客只可使用授权的识别、识别图片和 AI 链路；头像、收藏、账户、博客投稿/评论/举报和管理需要注册账号。验证码仅在注册和登录时使用，不要求每次 AI 请求验证。
- UI 只在达到限制时提示；服务端用量账本仍真实记账。

## 图片与推理

`POST /api/v1/web/uploads/`：`{"name":"photo.jpg","content_type":"image/jpeg","purpose":"recognition","data":"BASE64"}`，purpose 可为 `avatar`。接收 JPEG、PNG、WebP 静态图片，最高 5 MiB、1600 万输入像素。按真实图片解码检查，去元数据、自动旋转、最长边 2048，生成 JPEG 原图和 384 缩略图；忽略文件名中的路径。

返回 `{id,purpose,width,height,byte_size,thumbnail_url,created_at,original_expires_at,expires_at}`。`GET /api/v1/uploads/:id/content/?variant=thumbnail|original` 返回 JPEG 二进制，仅本人可取。原图 24 小时、识别缩略图 30 天；选作头像后保留至更换。原有 `/cloud-files/uploads/` 分块 API 也保留。

推理沿用 `/recognition-jobs/` 和 `/assessment-jobs/`：先 POST `{"asset_id":"UUID"}`，按返回的 job ID 发起 GET 轮询（GET 会推动队列执行）。详见 vendor/lib/recognition.js。不会使用假候选或伪造水质结论，真实 ONNX 需校验固定 SHA256，模型不可用时明确关闭功能。 删除识别或观察任务时，也清除关联 AI 会话的私密问答正文；保留防止延迟任务恢复的删除标记和使用量账本。

## 公共资料与管理

保留 regions、places、rivers、maps、water-bodies、observations、contents、routes、收藏、历史、游览、LLM sessions/turns、weather-data 等接口。新增 `/web/blog/` 是网页独立的人工审核博客与评论系统，现已开放。旧 `/community/` 资料反馈编辑仍维持原安全闸门，不能把其关闭状态解释为新博客关闭，也不伪造微信 msgSecCheck 通过。私人反馈 `POST /feedback/ {body}`，未处理反馈新增 `PATCH /feedback/:id/ {body}`；只有原作者可编辑。

- `GET /web/config/`：运行能力、ALTCHA 登录类型、协议版本、网页博客状态、天气预算、AI、站内提醒信息。地图实际提供方以独立 `/web/map-config/` 为准。
- `GET /web/map-config/`：`{provider:"tencent"或"openstreetmap",js_key:"网页JS Key或空值"}`。仅提供独立浏览器地图 Key，不提供和风、DeepSeek 等服务端密钥。腾讯 GL 使用 GCJ02，浏览器 WGS84 定位只在本机转换；未配置或失败可使用备用地图。
- `GET /web/site-info/`：已配置的运营者、联系邮箱、备案信息；没有真实配置的字段为空，不杜撰。
- `GET /web/map-points/?region=tianjin-nature`：参考点包，同时提供 `locations` 与 `points` 数组；省略参数返回全部 211 点。坐标为 GCJ02，前端须按地图底图转换。
- `GET /web/legal/privacy/` 或 `/web/legal/terms/`：`{title,version,sections,body}`。
- `GET /personal-admin/status/`：`{enabled,editable_kinds,revision}`。
- `GET /personal-admin/stats/`、`/personal-admin/audit/`、`/personal-admin/feedback/`。
- `POST /personal-admin/feedback/:id/resolve/`：`{reply,expected_revision}`。
- `GET /personal-admin/catalog/:kind/`：分页行；`meta.revision` 是本次数据版本。kind 为 contents、routes、places、rivers。
- `GET /personal-admin/catalog/:kind/:id/`：`{id,value,deleted,published,revision}`。
- 新建 POST 到目录、修改 PATCH 到 ID：`{value:{需要修改的字段},publish:true或false,expected_revision:数字}`；返回包含新 revision。发布前后都在本机目录覆盖表持久化，产生审计记录。
- 撤下 DELETE 到 ID：`{expected_revision:数字}`。过期版本返回 409，需刷新。
- 模拟资料保留策略、清理预览和撤下沿用 `/personal-admin/simulation/...`。

## 网页博客、评论与举报

这些接口使用独立 `blog_*` 数据表。公开列表合并既有科普资料与已审核网页文章，待审、草稿、撤回和删除内容不进入公开阅读或 AI 资料召回。

- `GET /web/blog/posts/`：公开分页列表，支持 `search/category/region/place/plant_label`；`origin` 区分 `catalog` 与 `blog`。
- `POST /web/blog/posts/`：注册用户创建私人草稿，字段为 `title,summary,body,category,region,place,plant_label,source`；返回 `id,version,status` 等本人字段。
- `GET /web/blog/posts/:id/`：已发布网页文章；原目录文章继续使用 `/contents/:id/`。`GET /web/blog/drafts/:id/` 仅作者可读私人稿件。
- `PATCH /web/blog/posts/:id/`：允许字段及当前 `version`，仅草稿、驳回或撤下稿可编辑；`POST .../:id/submit/`、`POST .../:id/withdraw/`、`DELETE .../:id/` 均带当前 `version`。已发表文章需先撤回再编辑送审。
- `GET /web/blog/mine/?kind=posts|comments|reports`：本人记录分页，不能列他人草稿。
- `GET /web/blog/comments/?target_kind=content|post&target_id=:id`：仅已审核评论；`POST /web/blog/comments/` 提交 `{target_kind,target_id,body}`，初始待审；`DELETE /web/blog/comments/:id/` 带 `{version}`，仅本人可删除。
- `POST /web/blog/reports/`：`{target_kind,target_id,reason,details}`，注册用户举报公开文章或评论；相同用户对同一对象的待处理举报不可重复。
- `GET /web/blog/moderation/?kind=posts|comments|reports&state=pending` 和 `GET /web/blog/moderation/:kind/:id/` 仅管理员可用。`POST` 到该详情提交 `{version,action,note}`；文章支持 publish/reject/unpublish，评论支持 approve/reject/hide，举报支持 resolve/dismiss/remove。举报移除关联对象还须 `target_version`，防止覆盖他人新修改。

变更与审核记录在同一事务内保存，版本冲突返回 409。人工审核流程不代表微信内容安全接口或运营资格已经自动通过；不得将草稿直接发布、擅自改作者或绕过管理权限。

## 天气与站内预约

### 数据读取与请求预算

2026-10-08 当前分配为：**微信云小程序 15,000 次/月 + 生产网页 15,000 次/月 = 30,000 次/月**。云函数配置已保存并重新打开核对为 15,000，网页后端另强制封顶 15,000；各自保留原用量账本并同时检查自然月与滚动日桶。旧的本地独立额度不再适用，不得另起第三处使用同一 Key 抓取天气。本机网页后台抓取关闭，当前本机后端也已停止。

- `GET /weather-data/locations/`：当前网页公开天气地点仅天津、北京。
- `GET /weather-data/summary/?location=tianjin|beijing`：只读四项数据库缓存，返回 `cache_only:true, refresh_policy:"background"`；未命中、过期和刷新页面均不直接调用和风。
- `GET /weather-data/:location/forecast/`：只读对应预报缓存；旧的非支持城市链接返回明确不可用状态，不新增外呼。
- 仅生产内部天气任务启用 `HYHQ_WEATHER_BACKGROUND_ENABLED=true`，每 30 秒检查固定的两城任务；实况、空气、预警每小时，日预报每六小时。后台任务没有公开 HTTP 刷新入口，保留租约、防重、预算及失败退避；重启不补抓过去每个错过的时段。
- 正常成功调度约 `(2×3×24 + 2×4)×31 = 4,712` 次/31天，失败重试仍计入 15,000 上限。这是请求估算，不是提供方账单保证；不调用热带气旋、海洋、辐照接口。
- 预约、浏览和 AI 天气上下文同样读取缓存，不能绕过后台调度额外抓取。过期缓存保留来源和时间并如实标注，不生成默认温度或“无预警”结论。

- `GET /weather-data/reminders/`：`{enabled:true,channel:"local_in_app",template_id:"local-in-app-v1",local_login,items,server_time,min_lead_minutes:5,max_ahead_hours:48}`。
- `POST /weather-data/reminders/interpret/`：`{text,location,request_key:UUID}`。复用真实 DeepSeek 结构化解析和独立预算记账，返回待核对草稿；不会直接创建预约。
- `POST /weather-data/reminders/intents/`：`{location:"tianjin",scheduled_for:"含时区ISO时间"}`，5 分钟后至 48 小时内，每天至多一个活跃预约。
- `POST /weather-data/reminders/intents/:id/confirm/`：`{template_id:"local-in-app-v1",decision:"accept"}`。拒绝可用 reject。
- `POST /weather-data/reminders/:id/cancel/`：`{}`。
- `GET /web/notifications/`：个人站内通知分页；`PATCH /web/notifications/:id/ {read:true}` 标为已读；DELETE 删除。

服务每 30 秒处理到期预约，重启后补生成未处理的通知，并以事务保证一个预约只生成一次。通知保存在数据库，可点击进入天气页。它不发微信、短信、邮件，也不声称浏览器已经显示系统通知。服务关闭时不运行定时任务。

## 私有环境配置

必需或可选键（值不要提交）：

```
HOST=127.0.0.1
PORT=8787
HYHQ_SESSION_SECRET=<本机随机值，AI配置检查需要>
HYHQ_INFERENCE_ENABLED=true
HYHQ_MODEL_ROOT=/绝对路径/.private/models
HYHQ_LLM_ENABLED=true
DEEPSEEK_API_KEY=<已有密钥>
HYHQ_LLM_GLOBAL_ATTEMPTS=30
HYHQ_LLM_GLOBAL_TOKENS=60000
HYHQ_LLM_DAILY_LIMIT=5
HYHQ_QWEATHER_ENABLED=false
QWEATHER_API_KEY=<已有密钥>
QWEATHER_API_HOST=<已有允许域名>
HYHQ_QWEATHER_BUDGET_CONFIRMED=false
HYHQ_QWEATHER_MONTHLY_LIMIT=15000
HYHQ_WEATHER_BACKGROUND_ENABLED=false
TENCENT_MAP_JS_KEY=<已授权网页Key或空值>
HYHQ_TRUST_PROXY=<生产回环反代填loopback，本机可留空>
HYHQ_COOKIE_SECURE=<生产HTTPS为true，本机HTTP留空>
```

以上天气关闭值用于本机；只有生产网页将天气启用、预算确认与后台开关设为 true，月预算保持 15000。本机即使需要调试页面，也应读取已有缓存，不额外开第三处抓取。

模型文件为 `flowers-efficientnet-b0-v1.onnx` 和 `river-eco-yolov8n-v1.onnx`。AI 仅在主动发送后调用，生产天气由内部定时任务调用，浏览地图会加载对应提供方资源。初始化本机数据库不会导入云私有数据或发布用户内容。

## 验证

完整 `npm test` 当前 **92/92 通过**，包含真实 ALTCHA 算法、并发重放及重启、短密码原样处理、游客 IP 额度与私有对象隔离、博客审核状态与版本、天气只读缓存与后台限额、地图坐标及生命周期、偏好存储授权、既有模型和管理接口。生产构建通过。自动化测试与真实外部服务、手机交互验收分开记录，见 [验证记录](VALIDATION.md) 与本轮升级说明。
