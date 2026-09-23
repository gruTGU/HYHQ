# HYHQ 原生微信小程序 · 生态科普与自然观察

原生 JavaScript + JSDoc、WXML、WXSS，**无需 npm 安装或构建**；Markdown 使用仓库内固定版本的浏览器依赖。微信基础库基线固定为 `3.7.12`，Node 测试使用 Node.js 20 或更新版本。

## 已实现的范围

- 五个原生 tab：首页、生态导览、AI 识别、科普智游、我的。
- 统一 API 客户端、Bearer 会话、401 清理、超时与错误反馈、个人记录分页。
- 游客读取服务端的真实天气与预警，以及地点、监测站、模拟生态观测、文章与预设路线；真实天气与示范生态数据分开展示。
- 首页手动切换天津市、天津工业大学、天津师范大学、天津理工大学和北京市，显示天气、湿度、空气质量、预警、来源与缓存状态。校园天气代表附近网格，不代表校园传感器；此入口不请求定位。
- 共享地区选择、原创静态导览及 12 个示范点位：分类、版本选择、按钮缩放、拖动和地点详情；坏图仍可通过列表浏览。
- 智慧河湖与数据中心：单站多指标、来源/场景/成功批次/时间筛选、统计、缺失断点趋势和可展开明细表；首页与地点详情有对应入口。
- 显式开发模拟登录；正式 `wx.login → auth/wechat/` 适配，不在前端保存 AppSecret。
- 昵称、主动选头像、浏览记录隐私开关、个人记录、退出与注销确认。
- 科普按区域/分类/植物标签/地点/标题摘要筛选、完整分页及地点关联；路线按公开节点浏览，查看地点后返回原选择。
- 我的反馈：提交、分页查看处理状态/答复、本人删除；头像、个人资料、记录和确认操作均绑定发起会话。
- 图片上传、私有缩略图鉴权下载、识别任务状态查询。读取服务端 `health.recognition` 展示当前模型范围、类别与版本；成功时展示最多三个候选及模型分数，不确定时明确提示无法确认。**没有模型时显示明确失败，不输出假预测。**
- 识别结果可以跳转关联的已发布科普，历史任务保留其模型版本，支持重新拍摄及删除任务/关联图片。
- DeepSeek Flash 分区互动：识别结果、生态导览与科普智游各有独立使用限制；导览、科普及详情的浮动 AI 入口传递公开资料 ID。页面不展示次数，发送超限后才提示。回答支持 Markdown，历史支持分页及删除。
- 品牌与导航：首页、个人中心展示 HYHQ 主 Logo，五个底栏入口及悬浮助手使用统一绿色图标，底栏保留文字标签与突出的中央 AI 按钮。

M2 静态导览、河湖与数据中心已完成 API 和页面逻辑联调，相关后端已纳入北京部署；微信原生 canvas、movable-view、不同屏幕布局及触摸体验仍待完整开发者工具/真机验收。底图为版本绑定的虚构校园示意图，无真实地理含义，来源与复现见 [底图说明](assets/maps/README.md)。河道图像观察仅在用户主动点击后请求可选定位，拒绝定位仍可上传；不会自动收集位置。公开数据浏览不需要登录或定位。所有页面业务数据均来自 API，后端不可用时显示错误，不自动注入本地假数据。

当前模型属于**五类花卉原型**，覆盖雏菊类、蒲公英类、蔷薇属花卉、向日葵类、郁金香类；具体以健康接口发布的范围为准。它不等于通用植物识别，校园实拍及开放集效果尚待验证。模型分数不是经过校准的正确概率。当前 v1 的验证集规则选出阈值 `0.0`，**未启用低分拒识**，图片质量合格时只给出候选参考，范围外对象也可能获得高分；过小或近纯色图片返回 `LOW_IMAGE_QUALITY`、`uncertain`。后续注册阈值大于零的版本时，低于该阈值才返回 `LOW_CONFIDENCE`。页面与历史结果均根据各自返回的阈值说明实际行为。

## 当前默认配置与正式联调

`config/index.js` 默认连接 `https://greatdata.asia/api/v1`，`development: false`，不显示开发模拟登录。请求超时仍为 15 秒，上传超时仍为 30 秒。此配置只切换客户端目标，实际联通还需要服务器 HTTPS 有效、微信合法域名配置完成，以及正式登录所需的服务端微信配置。

微信公众平台的 request、uploadFile、downloadFile 合法域名均填写 `https://greatdata.asia`，不带 `/api/v1`；当前不使用 socket、UDP、TCP，也无需配置 DNS 预解析或预连接域名。正式联调需在开发者工具中开启域名、TLS 和 HTTPS 证书校验，不能沿用本地调试的跳过校验设置。

本机私有项目配置已保留真实 AppID 并设置 `urlCheck: true`，文件继续被 Git 忽略。2026-09-23 外网 ACME 校验仍被腾讯云拦截，服务器 AppSecret 仍待配置；因此本次地址切换不等于公网已连通。当前定位申请应对应 `wx.getLocation`，填写材料见 [接口申请说明](../docs/微信接口申请填写说明.md)，实际测试及剩余条件见 [联调记录](../docs/verification/上线联调记录.md)。

## 推荐：独立本机预览

在项目根目录运行 `node scripts/prepare-miniprogram-preview.mjs`，然后在微信开发者工具导入生成的 `miniprogram-preview/`。它固定连接 `http://127.0.0.1:8000/api/v1`，保留 `development: false`，不拷贝后端密钥，不改变正式目录配置。先启动本地 API；源码更新后重新生成副本。**不要上传该生成目录。**

本轮 UI、验证和待验项见 [森系界面实施计划](../docs/森系界面与发布准备计划.md)。正式目录始终保留 HTTPS 与合法域名校验，电脑副本不等于手机网络联通。

## 手工切回本地开发（可选）

1. 按项目根目录 README 启动后端，完成迁移、`seed_demo` 和模拟数据生成。确认 `http://127.0.0.1:8000/api/v1/health/` 可访问。
2. 在微信开发者工具中导入**本目录**。默认 `touristappid` 适用于初步页面开发；有账号后在工具“详情 → 基本信息”填写实际 AppID。AppSecret 只配置在后端。
3. 将 `config/index.js` 的 `baseURL` 临时改为 `http://127.0.0.1:8000/api/v1`，并设置 `development: true`。测试结束后恢复正式 HTTPS 地址和 `development: false`，不要将本地调试配置带入上传版本。
4. 仅在本地调试时，把 `project.private.config.example.json` 复制为 `project.private.config.json`，关闭本地域名校验。该文件已忽略，公共配置默认保留 `urlCheck: true`。
5. 点击“编译”。“我的”页面提供可点击的用户协议、隐私说明和“继续注册或登录即同意”说明，可直接使用“开发模拟登录”。该按钮要求前端 `development: true`，且健康接口明确返回 `dev_auth_enabled: true`。正式服务必须关闭服务端开发登录。
6. 启动后端识别任务工作进程后，上传可用 JPEG/PNG/WebP 图片。模型启用时读取真实 `recognized / uncertain` 结果；模型关闭时进入明确的 `MODEL_NOT_CONFIGURED` 失败状态。没有启动工作进程时可能保持排队。前端最多自动查询约 30 秒，之后提供手动刷新。

编译兼容：公共配置明确设置 `setting.swc: false`，保留 ES6 与增强编译。macOS 微信开发者工具 `2.02.2608070` 的默认 SWC 路径曾报 `@swc/runtime/_array_with_holes.js` 缺失并导致首页白屏；关闭 SWC 后已确认首页正常读取本地 API。个人测试 AppID 可写入被忽略的 `project.private.config.json`，避免修改公共示例 AppID。

### 本地配置覆盖

直接编辑 `config/index.js` 即可切换地址与 `development` 开关，它仅含可公开配置。需要个人覆盖时，可复制 `config/local.example.js` 为已忽略的 `config/local.js`，再按示例说明修改 `config/index.js` 的导出行。缺省代码**不引用不存在的 local.js**，新检出即可编译；不要提交指向缺失文件的导出修改。

### 真机与正式环境

- 手机上 `127.0.0.1` 指向手机本身。局域网调试需把地址改为电脑的实际局域网 IP，并让后端监听对应地址、配置允许的 Host。
- 真机登录需要有效 AppID 和服务端微信配置；游客测试号无法替代正式微信身份验证。
- 正式接口使用 HTTPS；配置小程序 request、uploadFile、downloadFile 所需合法域名，恢复域名/TLS 校验。
- 微信平台头像选择、相册/相机以及上传行为涉及的隐私声明需在实际小程序账号中配置并验证。
- 2026-09-20 已在 macOS 微信开发者工具 `2.02.2608070`、基础库 `3.7.12` 完成首次编译并观察到首页、科普及个人入口渲染，当前无运行错误；这不等于所有交互、canvas、movable-view 或真机验收。Node 测试也不能替代微信授权和发布条件验证。
- 2026-09-21 同一原生开发者工具已显示天津天气、天津工业大学附近天气、北京 AQI 与暂无预警，选择器包含五地点。当时使用本地测试地址，北京后端已部署并启用真实天气与 DeepSeek；当时记录的公网与登录限制见 [北京部署与回退](../docs/北京天气版本部署与回退.md)。2026-09-23 客户端默认值已切换为正式 HTTPS 地址，域名、证书和微信登录能否使用应以本次实际联调结果为准。

## 接口与权限约定

- 基础路径 `/api/v1`，资源路径以 `/` 结尾。
- 成功 `{data, meta?}`，错误 `{error:{code,message,details?},request_id?}`。
- token 只进入 `Authorization: Bearer …` 头，不出现在图片 URL、日志或跳转参数中。
- 私有头像通过 `wx.downloadFile` 携带认证获取临时文件，再显示到 `<image>`。绝不把 bearer token 拼接到 URL。
- 分页 next 和文件绝对地址必须与配置服务同源；异源 URL 会被拒绝，避免令牌发送到其他站点。
- 登录令牌存储在微信本地 storage。退出/注销成功后清除本地会话；后端退出失败会明确提示，不能把未撤销的服务器会话误报为退出成功。
- 天气/空气和观测的来源标识来自返回字段。真实天气使用独立 `weather-data/` 接口，区分 `fresh/stale/unavailable` 与明确无预警的 `empty`；旧模拟预警接口的 `not_connected` 也不表示没有预警。AQI 未提供时不自行计算。
- 图像上传上限前端初筛 5 MiB；实际类型、尺寸、解码与归属仍由服务端验证。

## 验证

在本目录执行：

```sh
node --test tests/*.test.js
```

测试覆盖公共与私有请求、上传/下载、拒绝异源地址、会话过期、并发旧请求 401、错误响应、开发登录双开关、数据缺失/零值、预警未接入状态、账号变化后的个人数据清理，以及页面配置、WXML 标签/事件和 JS 语法检查。测试使用 transport mock，不接入微信账号。

2026-09-21 最新小程序 257 项测试通过，覆盖空输入框保留来源上下文、重试输入保留、底栏选中同步、品牌资源引用、天气缓存状态、城市切换竞态及页面隐藏后的更新取消等回归。后端 377 项和实际管理数据库流程 48 项通过，运行代码 `d4d0bed` 已推送并部署北京，上轮源码与文档快照为 `c7bbdbf`。证据见 [真实天气与管理验证记录](../docs/verification/真实天气与管理验证记录.md)。

识别测试另覆盖动态模型能力、游客查看范围、成功与不确定的区别、关闭模型兼容、Top3 展示、版本/阈值、非法分数、低置信度/低图质提示，以及取消选图、重复轮询、页面销毁、私有缩略图过期、识别记录删除后的缓存清理。

建议实际联调依次核对：游客浏览 → 登录 → 修改昵称/头像 → 收藏与浏览记录 → 关闭浏览记录 → 图片上传任务 → 退出重登 → 注销及旧 token 失效。正式环境使用微信登录；仅在本地双开关已开启时使用模拟登录。停止本地后端后检查错误/重试，不应出现伪造实况。

已启动本地开发 API 与识别工作进程时，可额外执行真实 HTTP 联调：

```sh
node tests/live-smoke.js
```

脚本使用原有小程序客户端和页面逻辑，通过 `wx` transport mock 调用实际服务；会创建并清理自己的开发账号、记录和图片。默认地址为 `http://127.0.0.1:8000/api/v1`，可用 `HYHQ_TEST_API` 覆盖。仅用于启用了开发登录的本地演示环境，不等于微信平台或真机验收。

启用真实模型后运行：

```sh
HYHQ_EXPECT_RECOGNITION=1 node tests/live-smoke.js
```

可以通过 `HYHQ_TEST_IMAGE=/absolute/path/to/image.jpg` 提供有权使用的测试图片。默认的一像素 PNG 仅验证上传、协议与不确定结果的呈现，**不能用于植物分类准确率评估**，即便模型给出高分也不代表开放集可靠。

## M2 数据浏览联调

使用独立的本地 PostgreSQL 开发库，完成迁移后从仓库根目录生成同一窗口的三场景数据：

```sh
scripts/manage.sh seed_demo --start 2026-09-17T00:00:00Z --hours 48
scripts/manage.sh generate_simulation --scenario turbidity --start 2026-09-17T00:00:00Z --hours 48 --seed 20260916
scripts/manage.sh generate_simulation --scenario missing --start 2026-09-17T00:00:00Z --hours 48 --seed 20260916
scripts/manage.sh runserver 127.0.0.1:18202 --noreload
```

另一个终端进入 `miniprogram/` 执行 `node tests/m2-live-smoke.js`。脚本限定 `127.0.0.1` HTTP，仅 GET，不创建账号、请求定位或启动推理。若使用其他本机端口，可设置 `HYHQ_TEST_API=http://127.0.0.1:8000/api/v1`。验证目录、12 个版本绑定点位、第二水体选择、三种场景的来源/批次隔离、缺失断点、空气站直接打开及详情跳转。

选择旧批次时，时间窗口相对该批次结束时刻；页面显示窗口、生成时间与观测时间。统计来自原始有效观测；缺失或存疑的聚合桶断线，0 仍作为有效值。详情中的原始观测列表有条数限制，完整窗口趋势应进入河湖或数据中心。结果与微信端待验清单见 [M2 验证记录](../docs/verification/M2核心展示验证记录.md)。

## M2 科普、路线与个人业务联调

后端迁移并执行 `seed_demo`、`seed_recognition_knowledge` 后，在独立本机开发库启动 `127.0.0.1:18203`：

```sh
node tests/m2-business-live-smoke.js
node tests/m2-private-live-smoke.js
```

前者只读公开目录与页面，覆盖组合筛选、8 篇文章分页、地点关联与 6 节点路线。后者要求健康接口明确开启开发登录，创建两个自己的临时账号，检验收藏/浏览/游览、昵称与头像、浏览隐私开关、反馈、退出和注销，结束时清理账号；不执行图像识别。两者都只允许 `http://127.0.0.1`，可以通过 `HYHQ_TEST_API` 覆盖本机端口。传输层把相关列表设为每页 2 条，用真实分页验证加载更多。

反馈后台答复的实机 HTTP 测试方式及本轮证据见 [业务验证记录](../docs/verification/M2业务闭环验证记录.md)。普通脚本只验证用户侧，输出 `admin_reply_verified: false`；不能据此声称已实际操作过后台。全部验证仍使用 wx mock，不替代微信原生控件和真机体验。

## 河道图像观察联调

新增独立河道图像观察页，可从首页或 AI 识别页进入。保留原花卉识别流程，只开放有训练数据的 class 9 漂浮物候选；空检出表示无法确认，不提供评分。图像教学规则分不是官方生态等级或水质评价，检测框面积不是水面覆盖率或真实污染程度。框按服务端原图宽高换算相对坐标，历史记录使用各自的模型和规则版本。

准备示范水体、登记并启用漂浮物模型与规则，并启动 `run_assessment_worker` 后，在本目录运行：

```sh
# 使用有权使用的测试照片，仅验证接口和状态，不验证精度。
HYHQ_SMOKE_MODE=assessment HYHQ_EXPECT_ASSESSMENT=1 \
HYHQ_TEST_IMAGE=/absolute/path/to/river.jpg \
node tests/live-smoke.js

# 不提供照片时生成 1×1 PNG，验证低质量图片的无法确认结果。
HYHQ_SMOKE_MODE=assessment HYHQ_EXPECT_ASSESSMENT=1 node tests/live-smoke.js

# 两个 worker 同时启用时，也可一并验证花卉识别与河道观察。
HYHQ_SMOKE_MODE=both HYHQ_EXPECT_RECOGNITION=1 HYHQ_EXPECT_ASSESSMENT=1 node tests/live-smoke.js
```

默认 `HYHQ_SMOKE_MODE=recognition` 保持原花卉联调行为。模型关闭时省略对应 `HYHQ_EXPECT_*` 开关；仍需启动 worker，以验证 `MODEL_NOT_CONFIGURED` 失败。脚本创建自己的开发账号，结束时清理记录与图片。

河道模式验证手选水体且不获取定位、任务队列、仅 class 9 候选、空检出无评分、原图框比例、历史版本、私图鉴权、账号隔离、花卉/河道任务图片互斥及删除后预览清空。新增单元测试覆盖定位拒绝、取消附近查询、卸载、账号切换、401 和陈旧异步响应。

### 可选定位与微信平台配置

用户主动点击按钮时才调用 `wx.getLocation({ type: 'gcj02' })`；附近候选须手动确认，不代表到访认证。手选水体或不关联水体均可直接上传。可选位置在提交时仅存入本人任务，可取消并随记录删除，不采集轨迹。项目已声明 `scope.userLocation` 和 `requiredPrivateInfos`；正式运行前需在微信平台配置与实际用途一致的隐私声明和位置权限，并用开发者工具、真机检查授权、拒绝及取消流程。

## DeepSeek Flash 分区互动

识别结果进入原识别问答；“生态导览”“科普智游”首页右下的“问问 AI”进入当前区域问答，地点/河湖/文章/路线等详情进入对应内容问答。“我的 → 我的 AI 对话”查看历史。

1. 进入页面只读取资料和能力状态，不自动调用模型。点击“开启对话”只创建本人会话，输入框保持为空；用户填写自己的问题并主动点击“发送”。识别结果或公开资料的关联仍保留，背景资料由服务端提供，不占用输入框。
2. 注册/登录入口统一展示协议及隐私链接，“我的”可随时查看；各业务页不重复要求勾选。相册、相机、定位等系统权限仍需用户自主操作；图片仍需主动上传，识别问答附图默认关闭。
3. `pages/llm` 接受旧识别 `kind/jobId`、历史 `sessionId`，或公开资料 `scope/source_type/source_id`。公开正文由服务端读取，客户端不拼接系统提示词。
4. 三个板块独立计数，但不在页面、按钮或历史中展示剩余额度；发送达到上限时展示服务端拦截提示，不预先隐藏或禁用发送按钮。关闭服务或本会话已有处理中任务时仍禁用发送。
5. 问答每 2.5 秒轮询一次，最多 24 次；可停止与恢复。网络结果未确认时保留问题，相同问题重试复用请求编号。旧账号与离页后的异步响应不写入新视图。
6. Markdown 使用固定版本 markdown-it 解析后转原生 rich-text 节点。支持标题、加粗/斜体、列表、引用、代码与表格；模型 HTML 显示为文字，远程图片不加载，链接不自动跳转。输入及节点数量均限长，异常时保留安全纯文本。许可证在 `vendor/markdown-it/`。
7. 原图过期不改用缩略图，界面依据 `used_image` 显示实际情况。公开资料下架或删除不能继续使用旧来源；历史“查看相关资料”返回对应的区域、地点、河湖、文章或路线。
8. 底栏使用自定义组件，五个入口保留标签，图标及悬浮助手统一使用绿色图标精灵图；中央 AI 圆形按钮突出，各页面进入时同步对应选中项，页面与浮窗预留安全区空间。

本机检查：

```sh
npm test
```

自动测试使用 mock，不调用真实 DeepSeek；原生工具检查与后端回归记录见 [AI 分区互动计划](../docs/AI分区互动实施计划.md)。手机真机仍需单独验证。

## 品牌素材与运行资产

- 主 Logo 原始字节保存在 [主图源文件](../design/brand/hyhq-logo-source.png)，运行时使用 [JPEG 88 版本](assets/brand/hyhq-logo.jpg)，仅优化编码，不裁剪或改绘。首页与个人中心品牌/注册区域使用小白卡承载 Logo，用户头像继续独立显示。
- [用户小图参考](../design/brand/small-icons-reference.png) 与 [六格绿色图标源文件](../design/brand/icons-green-source.png) 保存在设计目录；运行时使用 [JPEG 90 精灵图](assets/brand/icons-green.jpg)，通过原生 image 视窗显示对应图标，不请求远程图片。图标覆盖五个底栏入口及悬浮助手。
- 首页入口卡、个人中心注册卡采用绿色细边框，与原有绿米白配色保持一致。原图放在小程序目录外，避免增加发布包体积。素材来源与编辑过程见 [品牌素材说明](../design/brand/README.md)。

## 官方参考

- [微信开发者工具项目配置](https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html)
- [微信登录](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)
- [上传文件](https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html)
- [下载文件](https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html)
- [微信官方小程序示例项目](https://github.com/wechat-miniprogram/miniprogram-demo)
