# 京津补充内容草稿交换与审核

2026-10-07 阶段只解析原 Markdown 并准备本地草稿包。2026-10-08 用户提供并确认的 74 条坐标已作为小程序静态参考点接入；正文仍保持待审，未执行正式云数据库导入。本工具没有网络写入能力，不发布文章、地点或路线。

## 本地使用

使用 Python 3 标准库，无需 Django 服务、数据库凭证或第三方库。在仓库根目录执行：

```sh
python3 scripts/import-content-drafts.py /absolute/path/补充库.md \
  --jsonl .runtime/content-import-20261007/content-drafts.jsonl \
  --report .runtime/content-import-20261007/validation-report.json
```

缺省全量验证：12 个已知分类各 100 条，ID 前缀与完整序列、分类/记录/元数据/正文标记、JSON 重复字段、字段类型、正文汉字数、全部关系引用、来源 URL 格式与来源边界。原文示例不会执行，来源 URL 不会联网抓取；`verification_date` 是文档自带声明，不代表导入时重新核实事实。

JSONL 中保留原始正文段落、全部原字段、来源范围、访问限制和路线节点文字。原文件 SHA-256 按原始字节计算；记录 SHA-256 按 UTF-8、递归键排序、无额外空白的 JSON 计算。全量导出可复现。报告注明正文总字数、分类数量、关系引用、来源统计和 JSONL 校验和。

### 可选的独立 SQLite 演练

这只是本地审核/回滚验证库，不是当前正式版数据保存处，不连接 Django 应用数据库。表 `content_drafts` 保存完整 JSON 文档，没有创建正式业务记录。

```sh
python3 scripts/import-content-drafts.py /absolute/path/补充库.md \
  --sqlite .runtime/content-import-20261007/rehearsal.sqlite3 \
  --report .runtime/content-import-20261007/preview.json
python3 scripts/import-content-drafts.py /absolute/path/补充库.md \
  --sqlite .runtime/content-import-20261007/rehearsal.sqlite3 --apply \
  --report .runtime/content-import-20261007/first-import.json
```

重复导入使用同一稳定主键和完整文档比较：完全相同则保留；任何差异（包括管理员修改、审核状态或来源指纹）使整批停止，不覆盖、不追加副本。写操作要求新的报告路径，防止覆盖首次写入的回滚凭证；第二次报告的新增列表为空。

```sh
python3 scripts/import-content-drafts.py \
  --sqlite .runtime/content-import-20261007/rehearsal.sqlite3 \
  --rollback .runtime/content-import-20261007/first-import.json \
  --report .runtime/content-import-20261007/rollback-preview.json
```

加 `--apply` 才执行本地回滚。只删除该凭证首次创建且完整校验和仍一致的行；一条被修改即整批拒绝回滚。先前已有行不在凭证里，不会删除。

## 最终微信云数据库契约（尚未导入）

独立集合名：`content_drafts`。仅管理端服务身份可读写，客户端权限应拒绝；用户公开目录、搜索、地图和路线接口均不得读取这个集合。管理员可在微信云开发数据库控制台按 `dataset_id`、`editorial_status`、`category`、`source_id` 筛选，展开 `source_record` 阅读完整稿件及边界信息。后续独立审核界面也应使用管理员身份校验，不能把草稿并入公开 `catalog`。

每条文档的结构：

| 字段 | 含义 |
| --- | --- |
| `_id` | `hyhq-supplement-v1-` + 原 ID 小写，例如 `hyhq-supplement-v1-riv-001` |
| `schema_version` | 1；只支持本次无坐标的固定交换格式 |
| `dataset_id` | `hyhq-beijing-tianjin-20261007-v1` |
| `source_id/category/title/city/summary` | 审核索引字段；保持原始内容 |
| `editorial_status` | 固定为 `draft_review_required` |
| `published` | 固定为 `false` |
| `source_record` | 全部 23 个原始元数据字段，加 `body_md` |
| `provenance` | 原文件名、`source_sha256`、`record_sha256`、起止行号 |

正式云导入前，应全量读取同 ID 记录并比较：缺失的记录可作为本批新增；完全相同的文档视为已存在；任何变化进入冲突报告，停止覆盖。写入过程按文档使用原子“仅新增”操作，不能用无条件 `set`/upsert。云端分批写不具备本地 SQLite 整批事务保证，应在本地保存本批成功新增 ID 和完整文档哈希，用于失败后的精准补偿；删除前再次校验文档与哈希，避免删除管理员后来编辑的稿件。云控制台导入应选择遇重复 ID 报错，不选择覆盖模式。

草稿尚未导入，控制台不会看到这一批新记录。此文档定义后续管理员的查阅方式，不宣称已新增审核后台。

## 审核后的字段转换提案

下面是依据现有 `knowledge.Content`、`knowledge.Route`、`ecology.Place` 的明确映射提案，工具不执行这些转换。所有来源证据和访问说明仍需通过稳定 `source_id` 关联回审核原稿。现有 `source`/`source_note` 长度为 500，不能把全部来源直接拼接后截断。

| 原 category | 后续目标及审核要求 |
| --- | --- |
| `daisy` | Content.category=`plants`，plant_label=`daisy` |
| `dandelion` | Content.category=`plants`，plant_label=`dandelion` |
| `rosa` | Content.category=`plants`，plant_label=`roses`；宽泛蔷薇属栏目，不推断玫瑰/月季种或品种 |
| `sunflower` | Content.category=`plants`，plant_label=`sunflowers` |
| `tulip` | Content.category=`plants`，plant_label=`tulips` |
| `nature_notes` | 根据逐稿主题人工选择现有 `plants/water/green/travel`；不可全部猜为同一类别 |
| `routes` | Route 的 title/description 可由 title 与正文形成；region 必须明确核对；节点文字不能直接变成 RouteStop，须对应同一区域真实 Place |
| `rivers` | 地点类内容；`river/lake` 由实际实体审核，栏目不等于水体类型 |
| `parks` | 拟映射 Place.kind=`park`，先人工核对实体与跨栏目重名 |
| `walk_sites` | 按实际地点在 `campus/trail/landmark` 中核对，不能只按栏目猜 |
| `scenic/wetlands` | 现有 Place.Kind 无这两项，保留原类别待产品与内容审核决定，不自动降格为公园或河湖 |

原文 `city` 包含“通用”和“京津通用”，不能强行关联具体行政区域。校园条目仍要保留合法入校条件。路线是阅读规划；观察任务不是实测水质或物种记录。本文档不定义坐标映射，等待用户后续完整资料。

所有业务转换先生成未发布草稿：Content.status=`draft`、published_at=null，Route.published=false；若之后确实创建 Place，必须显式 is_published=false（该模型当前默认值是 true）。最终逐条审核和发布另行执行。

## 后续完整文档与版本冲突

当前 parser 对新增字段会明确拒绝；带坐标新版需要先确认新格式，再升级 schema，不能丢弃新增信息。即使 ID 相同，新文件字节变化也产生新的 source_sha256；已有稿件会进入冲突，不会静默覆盖。对照新旧 `record_sha256` 和原稿字段生成审核差异，核对哪些仅改变来源定位、哪些改变正文/实体/坐标，再确定新版本数据包和可审查更新策略。

## 测试

```sh
cd backend
python3 -m unittest knowledge.tests_draft_import
```

测试覆盖严格结构/字段/引用验证、文档示例不执行、确定性导出、预览无写入、重复导入、冲突整批拒绝及回滚保留旧记录/管理员修改。

## 静态参考坐标与待审正文分开（2026-10-08）

`miniprogram/data/map-reference-points.js` 仅包含用户确认的 POI 名称、地址、坐标、访问提示及来源元信息。`source_id` 对应原始 MD ID，坐标与 MD 输入指纹保存在生成资源中。原始 1,200 条正文不随该文件发布，不将文件名中的 verified 解释为正文审核通过或导航可达性确认。

重建资源：

```sh
python3 scripts/import-map-reference-points.py \
  --locations /absolute/path/hyhq_locations_verified.json \
  --reference-md /absolute/path/海晏河清京津生态与花卉内容补充库.md \
  --output miniprogram/data/map-reference-points.js \
  --cloud-output cloudfunctions/hyhqApi/data/map-reference-points.js
```

这是数据转换命令，读取指定文件中的元数据并生成前端与云函数共用的同一份资源，不执行 Markdown 内示例代码、不联网、不写云数据库。遇到身份字段冲突即停止，不覆盖旧输出；后续新批次应先按聊天确认的状态和实际数据调整来源，不能仅为凑数量纳入未接受候选。地图中的参考点没有正式 catalog 地点 ID，不调用地点收藏、浏览历史或详情接口。

导览 AI 使用单独的 `map_reference` 来源类型，服务端按此资源核对参考点，再从现有已发布目录检索相关资料。参考点元数据不等于已发布文章；待审正文以及描述性标题、访问建议不作为 AI 已核验依据。`--cloud-output` 为可选参数；更新 AI 参考点时应与前端一起生成、部署，避免两端数据版本不一致。

## 本次已审天津补充（20261007 最终版本）

用户随后确认《天津地点与地理位置.json》全部内容已审，并选择“多个具体点分别显示”。因此本文件内旧待审状态不再拦截本次导览资料；此确认只作用于该天津文件，不扩展到原始 MD 的其他稿件。

转换工具 `scripts/import-tianjin-map-supplement.py` 读取原 74 点基线与天津文件：225 个具体候选、12 条原接受坐标及 1 个校园点，共 238 份坐标输入；经 POI ID 或坐标加具体名称合并 35 次，新增 203 点。最终 277 点中天津 216、北京 61。原有 ID 保持稳定，不依据附件删除清单擅自删除既有点。

```sh
python3 scripts/import-tianjin-map-supplement.py \
  --base /absolute/path/base-map-reference-points.js \
  --supplement /absolute/path/天津地点与地理位置.json \
  --reviewed-on 2026-10-08 \
  --output miniprogram/data/map-reference-points.js \
  --cloud-output cloudfunctions/hyhqApi/data/map-reference-points.js \
  --guide-output cloudfunctions/hyhqApi/data/tianjin-reviewed-guide.js
```

基线需使用上述首阶段工具生成的原 74 点文件，或本次本地保留的 `.runtime/map-ai-20261008/base-map-reference-points.js`，不要把当前 277 点输出替换成唯一基线。原始附件稳定副本在本机 `.runtime/map-ai-20261008/`，不提交临时路径、候选查询缓存或运行产物。

前后端共享轻量点位模块；145 条已审导览正文仅在云函数资料模块，52 条有关联点位，93 条无具体坐标。AI 仅取当前点/检索命中点的关联材料，按 `source_urls`、`source_scope` 保留归因；父级河流背景与具体 POI 分开，腾讯坐标来源不冒充正文来源。校园条目的简介与正文均仅“畔湖”，旧扩展关联清空。本次没有正式博客发布或云数据库写入。
