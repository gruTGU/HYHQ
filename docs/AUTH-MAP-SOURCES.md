# 网页防刷与腾讯地图适配依据

更新：2026-10-08。此文件只描述桌面独立网页 `/hyhq` 的实现，不变更微信小程序。

## 注册与登录

- 使用官方 `altcha@3.3.0`、`altcha-lib@2.6.0`。Widget、中文资源和 PBKDF2 worker 由网页构建产物同源提供，未使用 CAPTCHA CDN 或 ALTCHA 托管服务。采用官方 PBKDF2/SHA-256 挑战和库验证流程。[官方 Widget 文档](https://altcha.org/docs/integration/widget/)、[服务器集成](https://altcha.org/docs/integration/server/)
- 验证只用于注册和登录，`auto="off"`，由本人点击。协议默认不勾选；无人代用户操作验证码或协议。关闭与本地挑战无关的可选 Human Interaction Signature 采集。[HIS 官方说明](https://altcha.org/docs/sentinel/features/human-interaction-signature/)
- `GET /api/v1/web/captcha/?purpose=register|login` 返回原始 ALTCHA JSON；业务表单带 `altcha` 字符串。挑战在私有 SQLite 保存五分钟，绑定用途及经过 HMAC 处理的 IP 摘要。验证通过后先事务删除，再验证密码；错误密码也消耗本次证明。并发、重放和重启后重放均拒绝。
- IP 挑战及认证请求各限每十五分钟 30 次；验证成功后才计入账号失败限制（每十五分钟 12 次），成功登录清除该账号失败计数。协议/密码格式检查失败不会锁定其他账号。
- 只有 `HYHQ_TRUST_PROXY=loopback` 且连接来源为回环地址时，才使用单一合法 `X-Forwarded-For`。反代必须覆盖此头为直接客户端 IP；从公网直接伪造的头或逗号链均不采信。
- 密码接受 1–128 个 UTF-16 字符，保留原样，包括空格；并限 UTF-8 长度最多 512 字节。仍以随机盐与 scrypt 存储，不保存密码原文。
- 局部自动测试在隔离数据库使用真实官方算法求解测试挑战，没有生产绕过。测试不代用户在网页完成验证。

## 腾讯地图

- 组件从同源 `GET /api/v1/web/map-config/` 读取 `{data:{provider,js_key}}`。只有提供独立的网页 JS Key 且 `provider=tencent` 时，加载固定的官方 `https://map.qq.com/api/gljs`，以官方回调确认 SDK 可用。不读取服务端 WebService Key、不增加 POI 搜索或路线请求。[官方基础接入](https://lbs.qq.com/webApi/javascriptGL/glGuide/glBasic)
- 腾讯底图使用 GCJ-02。资料地点和已核实河道坐标直接传入，浏览器主动定位返回的 WGS84 在本机换算。组件不主动调用定位、不把当前位置写到业务后端。手机“我的附近”仍由页面的现有主动点击入口负责。
- 保留点选择、所选点聚焦、地区恢复、经审核的河道线、附近位置。DOM 内容不通过 HTML 字符串插入，点名称由地图文本参数展示。[标注手册](https://lbs.qq.com/webApi/javascriptGL/glDoc/glDocMarker)、[矢量线手册](https://lbs.qq.com/webApi/javascriptGL/glDoc/glDocVector)
- 脚本超时或网络失败可重试、可转备用地图；瓦片超过十二秒仍未就绪和 WebGL 上下文丢失时显示说明，地点列表始终可用。地图关闭时解绑监听、移除覆盖物并销毁地图，尺寸变化触发 SDK 的窗口尺寸处理，不调用不存在的 `resize()` 公共方法。[Map 生命周期、手势和事件](https://lbs.qq.com/webApi/javascriptGL/glDoc/docIndexMap)
- 地图 Key 为浏览器必需的公开 JS 凭据，依靠腾讯控制台的域名白名单限制。服务器环境变量不入 Git；网页运行期间会将该 JS Key 交给官方地图 SDK。API URL 不包含其他项目私密密钥。

## 验证边界

已执行注册登录专项 21 项、管理界面真实登录契约 3 项、地图控制器与加载失败专项 11 项；均通过。地图专项使用接口替身验证生命周期、坐标、失败和重试，不替代真实地图服务测试。需要由主任务在白名单域名验证真实腾讯瓦片、手机拖动/缩放、点选与附近定位；localhost 未在白名单时不能据此宣称腾讯服务不可用。
