# 科普手记采集核对记录（第一批）

采集与核对日期：2026-09-23。

## 交付范围

- 内容文件：`backend/knowledge/data/eco_notes_part1.json`，共 15 篇：植物知识 8 篇、水资源保护 7 篇。
- 每篇均为重新组织的中文科普手记，包含 3 个小节：知识解释、可执行的观察记录、判断边界；不是原文转载或逐句翻译。
- 每篇保留一个独立的公开机构来源链接、标题、发布机构和访问日期。未填写无法可靠确认的原文发布日期。
- 仅整理内容及本记录；本批采集没有修改数据库、调用天气或大模型 API，也没有抓取或使用来源图片。

## 来源核对表

下列页面均已实际打开并阅读正文，不以搜索摘要代替核对。中文资料优先采用政府、科研机构页面；国外资料采用大学研究团队、公共植物园及环境／地学主管机构页面。

| 手记 | 核对重点 | 已读取的具体来源 |
| --- | --- | --- |
| 读一片银杏叶，也读一段植物历史 | 扇形叶片、古老谱系；区分栽培与野生 | 中国科学院植物研究所（转载北京晚报）：[《〖北京晚报〗银杏是中国送给世界的珍贵礼物》](https://ib.cas.cn/2019gb/meiti2019/201911/t20191110_5434882.html) |
| 竹子地上有节，地下也有一套生长路线 | 禾本科、竹秆节间与地下茎 | 中国农业科学院农业信息研究所：[《观赏竹类的栽培技术》](https://cast.caas.cn/kj/syjs/zzyjs/208843.html) |
| 向日葵会一直追着太阳转吗 | 昼夜节律、生长阶段与花盘朝向 | 加利福尼亚大学戴维斯分校：[《Sunflowers Move by the Clock》](https://www.ucdavis.edu/news/sunflowers-move-clock) |
| 蒲公英的小伞，为什么留着那么多空隙 | 多孔冠毛与分离涡环 | 爱丁堡大学蒲公英研究团队：[《Welcome to the Dandelion Research Group website》](https://dandelion.eng.ed.ac.uk/) |
| 秋叶的黄与红，来自不同的色素变化 | 叶绿素、类胡萝卜素与花青素 | 中国科学院青海盐湖研究所：[《一年一度秋风劲，绿叶缘何变黄叶?》](https://isl.cas.cn/kxcbn/kpwz/201501/t20150129_6797529.html) |
| 荷叶上的水珠，为何常常滚成一团 | 叶面蜡质与水珠、自清洁现象 | 中国科学院武汉植物园：[《“出淤泥而不染”——莲自我清洁的秘密》](https://wbg.cas.cn/KPPJ/kpdt/202008/t20200811_5652680.html) |
| 不是每一种蕨，都长着羽毛一样的叶 | 叶形多样、两类叶与孢子结构 | 中国科学院沈阳应用生态研究所树木园（来源：华南植物园）：[《“蕨”代芳华——鹿角蕨》](https://www.iae.cas.cn/smy/kpjy/kpzs/202503/t20250327_7569477.html) |
| 蹲下来，看见苔藓的小尺度生活 | 假根、表面吸水与环境适应 | 英国皇家植物园邱园：[《7 interesting things about moss》](https://www.kew.org/read-and-watch/moss) |
| 水里的氧气，看不见也很重要 | 氧的补给、消耗与温度影响 | 深圳市水务局：[《为什么DO（溶解氧含量）可作为评价水体受有机物污染及其自净程度的间接指标？》](https://www.sz.gov.cn/hdjl/ywzsk/shuiwj/ps/content/post_11345018.html) |
| pH 的一小格，并非酸碱程度的一小步 | 对数刻度、测量方法与局限 | 美国地质调查局 USGS：[《pH and Water》](https://www.usgs.gov/water-science-school/science/ph-and-water) |
| 雨后的河水变浑，先记录，再判断 | 光散射、悬浮物与雨后径流 | 美国地质调查局 USGS：[《Turbidity and Water》](https://www.usgs.gov/water-science-school/science/turbidity-and-water) |
| 一滴雨落在校园后，会流向哪里 | 共同出口、嵌套流域与下渗 | 美国地质调查局 USGS：[《Watersheds and Drainage Basins》](https://www.usgs.gov/water-science-school/science/watersheds-and-drainage-basins) |
| 水太有营养，也可能让生态失去平衡 | 氮磷过量、藻类增长与缺氧 | 美国环境保护署 EPA：[《Basic Information on Nutrient Pollution》](https://www.epa.gov/nutrientpollution/basic-information-nutrient-pollution) |
| 湿地里的枯叶，也是食物网的一部分 | 植物残体、食物网与湿地作用 | 美国环境保护署 EPA：[《Why are Wetlands Important?》](https://www.epa.gov/wetlands/why-are-wetlands-important) |
| 一块下凹绿地，怎样接住一场雨 | 浅凹绿地、径流与过滤下渗 | 美国环境保护署 EPA：[《Types of Green Infrastructure》](https://www.epa.gov/green-infrastructure/types-green-infrastructure) |

## 编辑取舍

- 银杏页面为中科院植物所转载的报纸科普，来源字段已明确转载关系；只使用基础形态和研究方法，不采用极端寿命数字等旁支说法。鹿角蕨页面的上游出处为华南植物园，也在机构字段中保留。
- 向日葵采用 UC Davis 对本校研究的说明，区分年轻植株与成熟花盘；蒲公英采用爱丁堡大学研究团队的专门介绍页，区分手机可见现象与实验揭示的气流机制。
- 竹、秋叶、苔藓等主题的部分备选机构旧链接超时或读取失败，已换用表中可读取页面。USGS 的 pH 旧路径正常跳转到当前规范地址，最终保留规范地址。未绕过登录、付费或访问限制。
- 单一来源只抽取与主题直接相关的少量事实，以简短改写交代；观察步骤、记录方式和判断边界另行编写。未整篇翻译，未复制正文段落或图片。
- 不把水面颜色或一项水质参数写成检测结论；不提供医疗、食用、野外采食或化学投加建议；不写实时天气数值。
- 观察任务以开放步道、不采集、不扰动为前提。不同文章分别提供固定枝条、朝向对照、冠毛视频、汇水草图、三层视线等具体方法，避免通篇套用同一段模板。
- `plant_label` 仅为向日葵 `sunflowers` 和蒲公英 `dandelion` 设置；其他文章留空，避免把扩展科普内容误标为现有分类模型能力。

## 本地结构校验

通过 Python 标准库读取 JSON，并对以下条件执行断言：

- schema_version 为 1，采集日期与所有来源访问日期一致。
- 精确 15 篇、8 篇 plants / 7 篇 water；slug 和标题唯一；15 个来源 URL 不重复。
- 字段完整、slug 采用 `fieldnote-` 前缀，来源均为完整 HTTPS 地址。
- 摘要长度为 54–61 个字符（要求 45–80）；正文为 315–333 个汉字，含 Markdown 与标点的总长度为 360–384 个字符。
- 每篇 3 个 Markdown 二级小节；来源信息以非 ASCII 转义 JSON 序列化后为 141–196 个字符，均小于 500。
- 植物关联标签精确限定为上述两条；正文无图片引用。

校验结果：15 篇全部通过。结构校验不代表数据库已导入；导入、备份和端到端展示由后续流程验证。
