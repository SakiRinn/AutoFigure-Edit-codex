# SVG到PPTX导出参考

本参考说明配套导出器的对象计划与调用接口。Agent先按 [可编辑转换](postprocess.md) 裁决语义对象，再将实际选型写入计划；示例中的ID与数据须替换为本次图稿内容。

## 调用

运行时通过桌面 `load_workspace_dependencies` 获取，webide使用已部署运行时。环境须提供fontconfig的 `fc-list`、所用字体和以下变量。

| 变量 | 指向 |
| --- | --- |
| `RUNTIME_NODE` | Node可执行文件 |
| `RUNTIME_NODE_MODULES` | 含sax、jszip、xml-js与sharp的包目录 |
| `ARTIFACT_TOOL_PATH` | `@oai/artifact-tool/dist/artifact_tool.mjs` |

```bash
"$RUNTIME_NODE" "$SKILL_DIR/scripts/svg_to_pptx.mjs" \
  "$RUN/editable.svg" "$RUN/final.pptx" \
  --plan "$RUN/ppt-object-plan.json"
```

CLI语法为 `INPUT.svg OUTPUT.pptx [--plan PLAN.json]`。省略计划仅适用于全部对象均可自动映射的图稿。输出保留原SVG，生成单页PPTX及同路径后缀文件。

- `OUTPUT.pptx.preview.png` 来自最终PPTX重新导入后的渲染。
- `OUTPUT.pptx.objects.json` 记录实际PPT对象、资源关联及结构检查结果。

## 对象计划

顶层对象包含 `fonts` 和 `objects`。计划中的每项至少提供以下字段。

| 字段 | 含义 |
| --- | --- |
| `id` | 导出对象的唯一ID，也供连接符绑定引用 |
| `sourceIds` | 工作SVG中的元素ID数组，可选叶元素或带ID的组 |
| `kind` | `shape`、`custom`、`connector`、`text`、`vector`、`image`、`table`、`chart` 或 `background` |
| `position` | 需要覆盖定位时提供 `{left,top,width,height,rotation,horizontalFlip,verticalFlip}` |
| `reason` | 自定义几何、整体资产或自由端点的结构依据 |

位置与大小使用CSS像素，旋转使用度。SVG的viewBox和父级变换会参与源坐标计算。选定多个来源时，其可见叶元素必须在绘制顺序中连续；同一来源不得跨对象重复归属，也不得同时选择祖先组及其子元素。

被计划覆盖的来源只产生选定语义对象，其余叶元素继续自动映射。建议给需引用的SVG对象显式ID；自动生成的 `__svg_*` ID只随当前解析顺序稳定。

### 字体

默认英文使用Times New Roman，中文优先STSong，缺失时采用NSimSun。导出器检查实际使用的字体，缺失即报错；先补齐字体再导出。

```json
{"fonts":{"latin":"Times New Roman","cjk":"STSong"},"objects":[]}
```

文字按书写系统拆分run，保留内容与混合样式。普通文本run可显式指定 `textStyle.typeface`；此字体也必须安装。字体替换须满足交付规则并记录依据。

### 对象表示

| `kind` | 计划字段与实际输出 |
| --- | --- |
| `shape` | `preset` 指定PowerPoint预设名称；可用 `adjustments:[{name,formula}]` 保留OpenXML调整参数，输出一个原生形状 |
| `custom` | 单个SVG几何来源，必须有 `reason`；保留路径与贝塞尔命令，输出一个原生自定义形状 |
| `connector` | `preset` 指定连接符预设，或记录自定义路线 `reason`；通过端点字段输出一个原生连接符 |
| `text` | SVG文本自动提取，或显式提供 `paragraphs`；输出一个原生文本框 |
| `vector` | `reason` 说明整体矢量资产的结构依据；写入纯SVG资源及兼容PNG预览，PPT中为一个图形对象 |
| `image` | `reason` 说明复杂图标或密集区域裁决；输出一个局部PNG图片对象 |
| `table` | `table.values` 明确给出单元格内容，输出原生表格 |
| `chart` | `chart.type` 与系列数据明确给出，输出原生图表及内嵌XLSX数据 |
| `background` | 仅用于最底层的全画布不透明纯色对象，写入页面背景，不产生可选形状 |

矩形自动映射为 `rect`，圆及椭圆映射为 `ellipse`，没有marker的line映射为普通 `line`。符合条件的底层矩形自动转为页面背景，单个SVG文本自动转为文本框。路径、图标或多个部件共同表达的语义对象须写入计划；导出器不会从轮廓猜测用途。

`shape` 可用 `fill` 与 `line` 覆盖源样式；描边另用 `stroke:{cap,join,dash}` 保留端帽、连接方式及像素虚线序列。基础预设名称由运行时映射表校验。`custom` 仅接受一个源几何，多个同样式轮廓先合为一个SVG路径。`custom` 与无预设的自定义连接符采用源路径坐标，不接受 `position` 覆盖；调整位置时先变换工作SVG。

`vector` 必须保留纯矢量内容，禁止内部嵌入位图。多色简单图标无法由一个预设形状或单样式路径表达时，可采用该表示。`image` 可读取SVG image的base64数据或本地资源；远程图片须先下载到本地。整体SVG来源选为image时会栅格化，理由仍须来自结构裁决。

### 连接符与文本示例

下例假定 `flow-line` 与 `flow-tip` 是连续来源，`title-line-1` 与 `title-line-2` 属于同一标题。模块A与B分别由源矩形表达，位置仍以本次SVG为准。

```json
{
  "objects": [
    {"id":"module-a","sourceIds":["box-a"],"kind":"shape","preset":"rect"},
    {"id":"module-b","sourceIds":["box-b"],"kind":"shape","preset":"rect"},
    {
      "id":"flow","sourceIds":["flow-line","flow-tip"],"kind":"connector",
      "preset":"straightConnector1",
      "position":{"left":240,"top":140,"width":80,"height":0},
      "from":{"id":"module-a","side":"right"},
      "to":{"id":"module-b","side":"left"},
      "tailEnd":{"type":"triangle","width":"med","length":"med"},
      "fill":"none","line":{"fill":"#315986","width":2,"style":"solid"}
    },
    {
      "id":"title","sourceIds":["title-line-1","title-line-2"],"kind":"text",
      "textStyle":{"fontSize":20,"bold":true}
    }
  ]
}
```

`headEnd` 是线身起点，`tailEnd` 是线身终点；SVG的marker-start对应前者，marker-end对应后者。端点 `type` 可为 `none,triangle,stealth,diamond,oval,arrow`，`width` 与 `length` 可为 `sm,med,lg`。源稿带marker时必须显式给出对应端点。

`from` 与 `to` 使用导出对象ID，分别绑定起点与终点。每端提供 `side` 或非负整数 `index`；两者均提供时以index为准。side可为 `top,left,bottom,right`，导出器按目标形状解析连接点。绑定目标须为 `shape`、`custom` 或 `text` 对象。自由端点必须记录 `reason`。

预设路线可用 `straightConnector1`、`bentConnector2` 至 `bentConnector5`，或 `curvedConnector2` 至 `curvedConnector5`，配合 `adjustments` 保留参数。输出包写入连接关系及原生箭头端点，保持源稿位置。自定义连接路线仅接受一个源路径，必须记录预设无法表达的具体差异，仍可配置绑定。

### 文本

文本框可从SVG text/tspan的基线位置提取多行，混合字号与粗细保留到run；各行缩进及间距转换为原生段落属性。特殊排版可显式提供 `position` 和 `paragraphs`。

```json
{
  "id":"paragraph","sourceIds":["paragraph-source"],"kind":"text",
  "position":{"left":80,"top":220,"width":260,"height":64},
  "paragraphs":[
    {"runs":[{"run":"Heading","textStyle":{"bold":true,"fontSize":"20px"}}],
     "spaceAfter":600},
    {"runs":[{"run":"Body text","textStyle":{"fontSize":"16px"}}],
     "marginLeft":95250,"indent":0,"paragraphStyle":{"lineSpacingPoints":1500}}
  ]
}
```

段落的 `marginLeft` 与 `indent` 使用EMU，1px为9525EMU。`spaceBefore`、`spaceAfter` 和 `paragraphStyle.lineSpacingPoints` 使用百分之一点，1px为75个该单位；run字号使用带单位字符串，整体 `textStyle.fontSize` 使用像素数值。

SVG同行出现独立坐标跳跃、重叠基线或不同旋转时，先规范化或提供显式段落。斜切、非均匀缩放及反射文字也须规范化。特殊字距、baseline-shift或textLength等效果须按实际排版转换，不能据此拆开语义文本框。

### 表格与图表

表格值须为矩形二维数组，单元格可为文本、数字或带 `run/textStyle` 的富文本数组。表格支持列宽、行高与合并区域，字段分别为 `columnWidths`、`rowHeights`、`merges`。合并项写作 `{startRow,endRow,startColumn,endColumn}`，行列从0计数，终点包含在内；合并区域内除起点外的单元格必须为空。`cells` 可按 `row,column` 设置局部填色与文字样式。

```json
{"id":"results","sourceIds":["results-group"],"kind":"table",
 "position":{"left":40,"top":300,"width":260,"height":90},
 "table":{"values":[["Method","Score"],["A",0.8]],
          "columnWidths":[170,90],"rowHeights":[40,50],"textStyle":{"fontSize":16}}}
```

图表使用运行时支持的 `type` 与显式 `series`，普通分类图提供对应 `categories`。每个系列必须有名称和有限数值，数据数与分类数一致。scatter的每个 `series` 需给完整 `xValues`，bubble系列还需 `bubbleSizes`，两者长度均与该系列的 `values` 相同。输出保留图表数据缓存，并写入内嵌XLSX工作簿关联。

```json
{"id":"scores","sourceIds":["scores-group"],"kind":"chart",
 "position":{"left":340,"top":260,"width":300,"height":180},
 "chart":{"type":"bar","categories":["A","B"],
          "series":[{"name":"Score","values":[0.8,0.9]}],"hasLegend":false}}
```

这些数据仅展示接口。实际数据必须来自用户材料或可追溯数据源，禁止从示意图猜测数值。原图无数据依据的示意柱条仍按几何对象表达。

## 输入规范化

导出器覆盖经裁决的绘图对象。原SVG中的样式表与class需先内联；百分比长度须转为明确尺寸。带描边的非均匀缩放须处理到源几何，再核对线宽。

普通几何的filter、mask与clip-path须规范化；渐变或pattern需显式给出支持的 `fill/line`，或按结构裁决封装完整矢量资产。图片默认支持 `preserveAspectRatio="none"` 和 `xMidYMid meet`，其余先规范化。资产必须保留有效资源及定义，整体资产仍接受逐对象外观检查。自动资产边界包含普通描边；滤镜扩张或尖角miter超出几何边界时，按源图提供完整 `position`，避免裁切。

## 结构报告与验收

导出器按语义来源顺序重排最终对象，检查唯一PPT ID和对象数量；核对预设或自定义几何、连接关系及表格文本。矢量资源关联与图表工作簿写入包内，备注文字清空。输出前重新读取最终包，检查顺序、资源存在与备注为空，再导入最终PPTX生成预览。

当前Artifact Tool的预览还不能完整反映二次贝塞尔路径或自定义虚线；重新导入会遗漏自定义几何连接符，包内原生连接符仍保留C/Q路径和箭头。导出器检测重新导入缺失的原生对象，并标记二次路径和自定义虚线的预览差异，写入 `previewComplete:false` 与 `previewWarnings`；此时须用另一PPTX渲染器核验最终文件，自定义路线不得据该预览定稿。

报告的 `structure` 为自动结构检查结果。`visual` 与 `editing` 初始为 `pending`，Agent查看最终画面并检查实际编辑行为后另行记录结论。结构报告不能证明一比一外观，也不能代替移动模块、编辑单元格或修改图表数据的检查。

模块职责保持单一入口。

| 文件 | 职责 |
| --- | --- |
| `scripts/svg_to_pptx.mjs` | CLI、导出编排及最终文件发布 |
| `scripts/exporter/runtime.mjs` | 运行时加载与字体策略 |
| `scripts/exporter/svg.mjs`、`geometry.mjs` | SVG解析、坐标与路径转换 |
| `scripts/exporter/plan.mjs` | 源对象归属与选型检查 |
| `scripts/exporter/objects.mjs`、`text.mjs` | 原生对象、资产与语义文本构建 |
| `scripts/exporter/package.mjs` | OOXML完成、资源关联及最终结构报告 |
