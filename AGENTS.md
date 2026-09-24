# AutoFigure-Edit Codex项目指南

## 文件树总览

项目以 `16f3749` 为上游基线。SDK Provider位于统一调用边界，后处理由Skill在主程序退出后执行。主要文件按职责分布如下：

- 上游入口与模型调用。
  - `autofigure2.py` 保留上游算法和提示，仅增加Codex Provider。
  - `codex_bridge.py` 通过Python SDK在内存中调用Codex，返回文本或PIL图片。
- 绘图Skill与后处理。
  - [Skill入口](.codex/skills/autofigure-edit-codex/SKILL.md)负责材料准备、CLI运行及后处理，细则见Skill内的 `references/postprocess.md`。
  - Skill的 `scripts/compact_svg.py` 执行显式对象计划，`scripts/svg_to_pptx.mjs` 导出原生PPT对象。
- 验证与说明。
  - 后处理结果按Skill的 `references/postprocess.md` 核对对象与渲染。
  - `TUTORIAL.md` 保存安装和运行说明，`README.md` 和 `README_ZH.md` 保留上游正文并链接Codex入口。
- 原始服务与本地产物。
  - `server.py` 和 `web/` 保持上游实现，Codex完整链路使用Skill入口。
  - `outputs/` 保存运行产物且不提交，本地 `sam3/` 与 `.pptx-build/` 保持未跟踪。

模型调用完成后继续同一Python进程。每次调用均请求SDK；中断后重新执行命令，同一输出目录仅运行一个进程。

## 用户偏好

用户已明确以下长期绘图与交付偏好，后续任务继续采用：

- Python代码的import统一放在文件开头，新增或修改代码时采用顶层导入。
- 一次性验证脚本与测试文件用毕删除，不纳入Git提交。
- 科研图默认采用rich pastel配色，保持专业、清晰，色温不限。
  - 背景与内部元素分别配色；图标与局部背景、箭头与文字分别使用不同色相，标签沿用文字配色。
  - 图标采用[lineal color](.codex/skills/autofigure-edit-codex/assets/lineal_color.png)或[restrained flat](.codex/skills/autofigure-edit-codex/assets/restrained_flat.png)特征，也可融合。
  - 图标用于概括对象，具体结构优先使用形状示意；卷积核、多维参数及3D算子按内容保留立体表达。
- 字体允许区别于生成图。中文推荐微软雅黑或宋体，英文推荐Times New Roman或Comic Sans；保留文字内容与层级，按可读性调整字体带来的排版差异。
- 整图保留直角，矩形与折线禁止圆角化。箭身可为完整弧线；天然圆形图元可保留。
- 编辑单元按语义确定。整片多色散点合为一个叶对象；同一段落的多行合为一个原生文本框，标题与正文各自独立。标题附带的括号限定语仍归入标题文本框，各单元内部保留混合字号和粗细。
- 定稿生成图是外观依据，SVG/PPTX除字体替换与明确缺陷外一比一复刻。风格调整在生图阶段完成，合并只改变编辑单元；简单几何组成的图标转为整体矢量，复杂图标保留原图局部位图；须逐个记录结构依据，禁止整批默认保留位图。每个图标在SVG与PPT中各为一个对象，禁止拆成密集小对象或用分组冒充压缩；密集样本分布仍按独立压缩规则处理。纯色整页底层使用PPT页面背景。局部背景面板保留完整几何形状，前景色块独立叠放；白色覆盖层保留为原生对象，底层不得因遮挡而挖孔或切碎。上游链路仅改模型Provider。Codex在既有SVG响应或独立工作副本中修复明确生图缺陷；后处理全部置于Skill，教程采用workplace-docs规范，PPTX不含任何备注文字。

## 项目状态

项目以冻结主链路和Skill独立后处理组织实现，接手时按以下入口定位：

- 主链路保留上游结构，Codex SDK在统一模型接口执行请求。
  - `autofigure2.py` 的统一模型入口调用 `codex_bridge.call_text` 或 `call_image`。
  - 相对上游 `16f3749` 的处理逻辑冻结，一次性验证结束后清理脚本与产物。
- 自动Provider固定 `openai-codex==0.156.1`，SDK随包提供配套运行时。
  - 每次调用创建独立任务，临时目录与项目指令隔离。原生 `imageGeneration` 结果转为PIL，文本返回上游解析器。
  - `codex_bridge.py` 统一在顶层导入SDK；模型请求与结果均在内存传递，远端尚未部署此版本。
- 后处理实现位于Skill目录。
  - `compact_svg.py` 支持连续同父矢量合并、根级区域栅格化和语义文本合并；`svg_to_pptx.mjs` 将多行混合样式文本导出为一个文本框。
  - [生图设计](.codex/skills/autofigure-edit-codex/references/design.md)负责画面组织与风格；[可编辑转换](.codex/skills/autofigure-edit-codex/references/postprocess.md)负责SVG重建、缺陷修复和后处理。
- PII示例已完成真实全链路，运行记录位于 `outputs/pii-flywheel-003/`。
  - `run.log` 记录21个图标分割与RMBG抠图，执行一次SVG优化并完成替换；`repairs.json` 记录局部修复和后处理图标修整。
  - `editable.objects.json` 记录工作副本277个叶对象降为136个，26组文本合为26个文本框，102个多色散点合为一张局部图片。
  - `final.svg` 是上游原稿，`editable.svg` 和 `editable.png` 保存该次运行的图标风格；PPTX保留44个原生文本对象与90个原生几何对象，整片散点为唯一局部图片；SVG中的纯白底层在PPT中转为页面背景，PPT共135个可选对象。
  - 003示例曾事后重绘图标，不符合后来新增的一比一复刻要求；`verification.json` 只保存编辑单元检查；导出后按Presentations Skill校验并重新导入渲染。

- webide已部署完整环境，项目位于 `/root/autofigure-edit-codex`，配置使用本机 `.env` 副本。
  - `.env.webide-runtime` 指定独立Linux PPT运行时并启用离线模型缓存；SAM3源码位于 `/root/sam3`，模型缓存位于 `/root/.cache/huggingface/hub`。项目Skill与Presentations Skill均安装到远端两套Skill目录。
  - `outputs/webide-demo-001/run.log` 记录H20执行3个图标分割、RMBG抠图和一次SVG优化，最终替换成功；`remote-tests.log` 保存部署测试，新增描边回归后的22项后处理测试记录在 `skill-tests.log`，使用入口见 `TUTORIAL.md` 的webide章节。

## 工作流程

本机已验证以下运行与检查方式，按任务对应步骤执行：

- 验证Skill。
  1. 按Skill的 `references/postprocess.md` 检查对象数量、PPT类型与最终渲染。
  2. 使用 `/usr/bin/python3` 运行系统skill-creator的 `quick_validate.py`，该解释器具备PyYAML。
- 运行本机真实示例。
  1. 安装项目依赖并在本机完成 `codex login`。加载本地 `.env`，本机SAM3目录通过 `PYTHONPATH="$PWD/sam3"` 提供；Cairo通过已安装的Homebrew库路径加载。
  2. 启动 `.venv/bin/python -u autofigure2.py --provider codex`，显式设置需要的 `--optimize_iterations`。Provider自动执行模型请求，失败异常由原版调用方处理。
  3. 主程序退出后保留原始SVG，执行Skill中的压缩与PPTX导出。比较叶对象数，逐一核验语义文本框与多色密集区域，渲染后检查图形与文字。
- 验证PPTX文件。
  1. 用 `load_workspace_dependencies` 获取桌面运行时，传入 `RUNTIME_NODE_MODULES` 和 `ARTIFACT_TOOL_PATH`。
  2. Presentations Skill的finalizer要求最终输出目录与校验记录分开；先校验到独立目录，再复制相同文件到交付路径。
  3. 使用 `render_presentation.mjs` 重新导入最终文件并渲染，不能仅检查导出前预览。
  4. 多行坐标序列化可能产生末位差异，按0.01像素容差核对；图标存在均匀缩放时同步缩放描边，带描边的非均匀变换须先处理再导出。

- 运行webide GPU环境。
  1. 加载项目 `.env` 和 `.env.webide-runtime`，用 `/root/.local/share/autofigure-runtime/run_autofigure.py` 替代CLI中的脚本路径。启动器只在进程内包装SAM3处理器，采用官方BF16上下文，再将框和分数转为NumPy兼容的FP32；仓库阶段与提示保持冻结。
  2. 远端字体使用静态Roboto Regular/Bold。变量字体曾使Cairo正文错误加粗，替换为静态文件并刷新字体缓存后解决。PPT文字位置须按实际渲染测量，当前示例的逐框校正记录位于 `font-alignment.json`。
  3. SVG line与path共用描边变换逻辑，均匀缩放须同步线宽。此前远端预览曾发现line缩放后描边过细，已在共享变换逻辑中修复。
