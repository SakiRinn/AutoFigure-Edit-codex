# AutoFigure-Edit Codex项目指南

## 文件树总览

项目以 `16f3749` 为上游基线。Codex Provider位于统一调用边界，后处理由Skill在主程序退出后执行。主要文件按职责分布如下：

- 上游入口与模型调用。
  - `autofigure2.py` 保留阶段算法，使用英文模板与 `<METHOD>` / `<STYLE>` 分隔输入；根目录 `style.txt` 保存默认风格，`--style_file` 可完整替换，`--detail_file` 可追加本次具体安排。
  - `codex_bridge.py` 用SDK返回文本，生图通过当前会话内置image-gen交接后返回PIL图片。
- 绘图Skill与后处理。
  - [Skill入口](.codex/skills/autofigure-edit-codex/SKILL.md)负责材料准备、CLI运行及后处理，细则见Skill内的 `references/postprocess.md`。
  - [生图交接](.codex/skills/autofigure-edit-codex/references/imagegen.md)说明请求处理与远端图片回传。
  - Skill的 `scripts/compact_svg.py` 执行显式对象计划，`scripts/svg_to_pptx.mjs` 编排导出，`scripts/exporter/` 分担对象计划、SVG几何、文本及OOXML资源；接口见 `references/exporter.md`。
- 验证与说明。
  - 后处理结果按Skill的 `references/postprocess.md` 核对对象与渲染。
  - `TUTORIAL.md` 保存安装和运行说明，`README.md` 和 `README_ZH.md` 保留上游正文并链接Codex入口。
- 原始服务与本地产物。
  - `server.py` 和 `web/` 保持上游实现，Codex完整链路使用Skill入口。
  - `outputs/` 保存运行产物且不提交，`.pptx-build/` 保存本地构建资产；`sam3/` 是Git子模块，既有本地改动须保留。

模型调用完成后继续同一Python进程。文本请求使用SDK，生图调用等待当前Agent回传图片；同一输出目录仅运行一个进程。

## 用户偏好

用户已明确以下长期绘图与交付偏好，后续任务继续采用：

- 本机Skill安装以 `~/.agents/skills` 为实体目录，在 `~/.codex/skills` 创建指向同一Skill的符号链接；后续同步只更新实体目录。
- Python代码的import统一放在文件开头，新增或修改代码时采用顶层导入。
- 一次性验证脚本与测试文件用毕删除，不纳入Git提交。
- 生图方法与风格分别写入 `method.txt` 和 `style.txt`，均可使用Markdown；style约束整图宏观风格，detail约束指定部分的微观细节。首轮默认省略detail，后续按画面效果主动提炼并逐步补充。
  - 保留异色要求；用户未指定时，外层Agent不预先固定分区位置、空间分配或加粗名单，生成后按实际画面检查。
- 科研图默认采用rich pastel配色，保持专业、清晰，色温不限。
  - 背景与内部元素分别配色；图标与局部背景、箭头与文字分别使用不同色相，标签沿用文字配色。
  - 图标采用[lineal color](.codex/skills/autofigure-edit-codex/assets/lineal_color.png)或[restrained flat](.codex/skills/autofigure-edit-codex/assets/restrained_flat.png)特征，也可融合。
  - 图标用于概括对象，具体结构优先使用形状示意；卷积核、多维参数及3D算子按内容保留立体表达。
- 字体允许区别于生成图。中文默认华文宋体（STSong），缺失时回退到新宋体（NSimSun）；英文默认Times New Roman；生图与可编辑转换沿用此约定，保留文字内容与层级，按可读性调整排版。
- 科研图用图形表达机制，禁止模块名后的括号解释等文字补丁；整图标题与caption式叙述放在图外，保留必要短标签、符号及作为数据展示的原文。
- 整图保留直角，矩形与折线禁止圆角化。箭身可为完整弧线；天然圆形图元可保留。
- 编辑单元按语义确定。整片多色散点合为一个叶对象；同一段落的多行合为一个原生文本框，标题与正文各自独立。标题附带的括号限定语仍归入标题文本框，各单元内部保留混合字号和粗细。
- 定稿生成图是外观依据，SVG/PPTX除字体替换与明确缺陷外一比一复刻。风格调整在生图阶段完成，合并只改变编辑单元；简单几何组成的图标转为整体矢量，复杂图标保留原图局部位图；须逐个记录结构依据，禁止整批默认保留位图。每个图标在SVG与PPT中各为一个对象，禁止拆成密集小对象或用分组冒充压缩；密集样本分布仍按独立压缩规则处理。纯色整页底层使用PPT页面背景。局部背景面板保留完整几何形状，前景色块独立叠放；白色覆盖层保留为原生对象，底层不得因遮挡而挖孔或切碎。主流程适配以文件树总览为准。Codex在既有SVG响应或独立工作副本中修复明确生图缺陷；后处理全部置于Skill，教程采用workplace-docs规范，PPTX不含任何备注文字。

## 项目状态

- 主链路以 `16f3749` 为上游基线，阶段逻辑冻结。
  - `autofigure2.py` 统一入口调用 `codex_bridge.call_text/call_image`。两套英文生图模板按参考图有无分支，依次放 `<STYLE>`、`<METHOD>`，非空细节追加 `<DETAIL>`。方法事实优先，明确局部细节可覆盖一般风格默认项。所有Provider共用末尾的细节、质量与最大努力要求，Codex桥接原样传递提示词。可选细节48组组合及CLI传递检查通过，见 `outputs/detail-input-verification/checks.json`。
  - Provider固定 `openai-codex==0.156.1`。文本SDK任务隔离项目指令；生图通过 `AUTOFIGURE_IMAGE_REQUEST_DIR` 交接，30分钟超时，返回或异常均清理。此前13项交接检查与同进程真实回传通过。
  - Skill分别准备方法与风格，首轮默认省略detail，后续从值得继承且需改进的候选图主动提炼局部细节，以文字重新生成；常规绘图读取实际输入文件；验收清除图内大标题与解释性文字补丁，候选图定稿后才回传。默认风格经独立subagent逐项审查通过。参数与交接7组检查及真实CLI帮助验证通过，证据见 `outputs/style-input-verification/`；本轮未调用真实生图。
- 后处理使用Skill内的显式对象计划。
  - `compact_svg.py` 压缩SVG编辑单元；`scripts/exporter/` 导出原生形状与绑定连接符，保留语义文本框，支持单对象SVG图标、局部图片、原生表格及带XLSX的图表。使用接口见 `references/exporter.md`。
  - 导出器重新打开实际PPTX检查对象与资源，再导入渲染。报告的结构检查与人工外观、编辑验收分开；Artifact预览对自定义连接符、二次路径与自定义虚线有已复现的局限，`previewWarnings` 要求另用PPTX渲染器核验；输入不支持的样式须按参考规范化，禁止用全页图片替代交付。
  - 验证记录在 `outputs/exporter-rewrite/`，覆盖混合文本、原生C/Q曲线、连接符绑定、合并表格及图表数据。移动目标框80px后，绑定连接符宽度增加80px。一次性测试输入不提交，检查日志保留。
- Skill安装与运行环境。
  - 本机实体目录为 `~/.agents/skills/autofigure-edit-codex`，Codex目录是符号链接。webide安装目录为 `/root/.agents/skills/autofigure-edit-codex` 和 `/root/.codex/skills/autofigure-edit-codex`；旧安装备份见 `~/.local/share/autofigure-install-backups/20261009/`。
  - webide仓库为 `/root/autofigure-edit-codex`，`.env.webide-runtime` 配置GPU离线缓存与PPT运行时。sharp位于独立 `autofigure-image-runtime`，链接到PPT运行时；STSong和Times New Roman已安装并经fontconfig确认，Linux覆盖样例导出及重新导入通过。
  - GPU启动器和SAM3运行说明见 `TUTORIAL.md`。远端真实全链路记录在 `outputs/webide-demo-001/`，此前完成H20分割、抠图和SVG优化；本次仅重验导出器。
- 历史PII示例位于 `outputs/pii-flywheel-003/`。
  - `run.log` 记录21个图标分割与一次SVG优化，工作副本277个叶对象降至136个，26组文本合并，102个多色散点成为一个局部图片。
  - PPT保留44个文本框与90个原生几何对象，散点为唯一图片，页面背景不占对象。该例曾后改图标，外观不满足后来新增的一比一复刻要求；`verification.json` 只保存编辑单元检查。

## 工作流程

本机使用以下运行与检查方式，按任务对应步骤执行：

- 验证Skill。
  1. 按Skill的 `references/postprocess.md` 检查对象数量、PPT类型与最终渲染。
  2. 使用 `/usr/bin/python3` 运行系统skill-creator的 `quick_validate.py`，该解释器具备PyYAML。
- 运行本机真实示例。
  1. 安装项目依赖并在本机完成 `codex login`。加载本地 `.env`，本机SAM3目录通过 `PYTHONPATH="$PWD/sam3"` 提供；Cairo通过已安装的Homebrew库路径加载。
  2. 准备 `method.txt` 并读取实际 `style.txt`；自定义风格用 `--style_file` 传入，省略时加载主程序同目录默认文件；具体安排用 `--detail_file` 传入，省略或空白时不加入细节。设置 `AUTOFIGURE_IMAGE_REQUEST_DIR` 到运行目录，启动 `.venv/bin/python -u autofigure2.py --provider codex`，显式设置优化次数。
  3. 日志出现 `Codex image request:` 后读取请求并调用内置image-gen。查看候选图、逐项验收并定稿后才原子回传绝对路径；同一进程继续，验收占用既有30分钟等待时间。
  4. 主程序退出后保留原始SVG，执行Skill中的压缩与PPTX导出。比较叶对象数，逐一核验语义文本框与多色密集区域，渲染后检查图形与文字。
- 验证PPTX文件。
  1. 用 `load_workspace_dependencies` 获取桌面运行时，传入 `RUNTIME_NODE_MODULES` 和 `ARTIFACT_TOOL_PATH`，按 `references/exporter.md` 编写PPT对象计划；先检查字体可用。
  2. Presentations Skill的finalizer要求最终输出目录与校验记录分开；先校验到独立目录，再复制相同文件到交付路径。
  3. 导出器自动重新导入最终文件生成预览，查看 `.preview.png` 并核对 `.objects.json`；继续检查移动连接模块、编辑表格和图表数据。
  4. 多行坐标序列化可能产生末位差异，按0.01像素容差核对；图标存在均匀缩放时同步缩放描边，带描边的非均匀变换须先处理再导出。

- 运行webide GPU环境。
  1. 先同步本次主程序、桥接代码与Skill，按[远端交接](.codex/skills/autofigure-edit-codex/references/imagegen.md#远端主机)回传定稿图。加载项目 `.env` 和 `.env.webide-runtime`，用 `/root/.local/share/autofigure-runtime/run_autofigure.py` 替代CLI中的脚本路径。启动器只在进程内包装SAM3处理器，采用官方BF16上下文，再将框和分数转为NumPy兼容的FP32；阶段逻辑保持冻结，提示适配见文件树总览。
  2. 历史SVG使用静态Roboto Regular/Bold，当前PPT按STSong与Times New Roman规则导出。变量字体曾使Cairo正文错误加粗，替换为静态文件并刷新字体缓存后解决。PPT文字位置须按实际渲染测量，当前示例的逐框校正记录位于 `font-alignment.json`。
  3. SVG line与path共用描边变换逻辑，均匀缩放须同步线宽。此前远端预览曾发现line缩放后描边过细，已在共享变换逻辑中修复。
