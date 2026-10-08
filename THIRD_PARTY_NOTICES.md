# 来源与第三方组件

本机项目的业务、公开资料、图片、主题与模型复制自用户自己的最新 HYHQ 小程序项目。朋友仓库移植部分沿用原项目已经整合的版本与授权范围；本轮未另行发布或改变许可。

## 程序组件

React、React Router、Vite、Lucide、Leaflet、Marked、DOMPurify、better-sqlite3、Sharp、ONNX Runtime 和格式工具的具体版本见前后端 `package-lock.json`，许可证文本见各安装包的 `LICENSE`/`NOTICE` 文件。模型权重和模型说明位于私有模型目录，未作为公开源码分发。

## 地图

网页地图由 Leaflet 展示 OpenStreetMap 公共底图，始终保留 Leaflet 与 © OpenStreetMap contributors 标识。

- [OpenStreetMap 版权与数据许可](https://www.openstreetmap.org/copyright)
- [公共瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/)

仅按当前视野正常浏览，不提供批量下载、预取或离线打包。浏览器发送正常来源信息并遵守服务缓存；没有添加代理或伪造浏览器身份。GCJ02 转换只用于本机已有点位与底图对齐，不改变原始资料坐标。

## 资料和天气

科普文章、路线、地点保留各自原文来源字段；天气保留和风天气数据来源及上游署名。自然摄影风格的主题装饰图来自用户提供的主题交付包，不把这些装饰图标记为天津或北京实景证据。

本文件是来源清单，不授予超出原材料许可证的再分发权。
