# Codex版AutoFigure-Edit使用说明

## 安装与启动

本发行版以 `16f3749` 为上游基线，生图由当前会话内置image-gen完成，文本请求使用Codex SDK。\
原版阶段顺序和提示保持冻结；完整绘图的材料准备与PPTX后处理由入口Skill负责。首次使用按以下顺序准备：

1. 按 [上游README](README.md) 安装Python依赖和本地SAM3，准备RMBG权重或访问凭据。
   - `requirements.txt` 固定 `openai-codex==0.156.1`，安装时包含配套Codex运行时。
   - 在运行主机执行 `codex login`，再用 `codex login status` 确认登录。SDK使用同一 `CODEX_HOME` 的身份。
2. 将 `.codex/skills/autofigure-edit-codex` 安装到自己的Codex技能目录，或在当前项目中引用该Skill。设置 `AUTOFIGURE_CODEX_ROOT` 可指定仓库路径。
3. 根据 `.env.example` 配置本地依赖所需环境变量。CLI使用当前进程环境，运行前加载本地 `.env`；保持文件本地保存，避免在终端打印凭据。

   ```bash
   set -a
   source .env
   set +a
   ```

4. 在Codex中调用 `autofigure-edit-codex`，提供材料并说明目标风格。
   - 整体采用rich pastel配色，图标使用lineal color或restrained flat特征，也可融合。
   - 图标用于概括对象，具体结构优先用形状示意；适用的3D结构保留立体表达。
   - 画面组织与风格规则见Skill的[生图设计](.codex/skills/autofigure-edit-codex/references/design.md)。配套图标展示图仅供Agent理解风格；仅在用户明确指定生图参考图时使用 `--reference_image_path`。
   - Skill将方法事实与用户明确要求写入输入材料，具体布局和视觉细节交给生图模型安排，以新的运行目录启动主程序。
5. 当前Agent用以下命令启动，并按[生图交接](.codex/skills/autofigure-edit-codex/references/imagegen.md)处理请求。
   - 生图调用等待回传，收到图片后同一Python进程继续。
   - 独立终端使用 `--input_figure_path` 导入已有图片，可跳过生图交接。

   ```bash
   export AUTOFIGURE_IMAGE_REQUEST_DIR="$PWD/outputs/run-001/.imagegen"
   .venv/bin/python -u autofigure2.py --provider codex --method_file outputs/run-001/method.txt --output_dir outputs/run-001 --sam_backend local --optimize_iterations 1
   ```

6. 示例显式启用一次SVG优化，上游CLI默认值保持不变。生成结束后由Skill执行密集对象压缩，再导出PPTX。入口说明和后处理示例都位于 [Skill目录](.codex/skills/autofigure-edit-codex/SKILL.md)。

项目依赖包含SDK运行时，登录CLI通过npm安装。已安装uv和Node.js的主机可执行：

```bash
uv pip install --python .venv/bin/python -r requirements.txt
npm install --global @openai/codex@latest
codex login
codex login status
```

macOS使用CairoSVG时，需要已安装Cairo动态库。Apple Silicon的Homebrew默认位置为 `/opt/homebrew/lib`，确认文件存在后可为命令设置 `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`。本地SAM3源码未安装进Python环境时，先按上游安装；当前工作区已有的兼容性目录属于本机环境，不属于发行版提交。

## 模型调用

文本Provider创建独立Codex SDK任务，结果返回上游解析器。生图Provider发布文件请求，等待当前Agent调用内置工具。

> **原版流程冻结**
>
> 原程序组装生图提示，Provider返回PIL图片。阶段推进与失败处理继续由原版代码决定。

### 生图调用

设置 `AUTOFIGURE_IMAGE_REQUEST_DIR` 后，Provider在该目录发布独立请求。
当前Agent读取请求，调用本会话内置image-gen，再原子写入图片路径或原始错误。

**交接要求：**

- 日志出现 `Codex image request:` 后及时处理，完整步骤见[生图交接](.codex/skills/autofigure-edit-codex/references/imagegen.md)。
- 最多等待30分钟，超时或工具失败会抛出异常。返回、异常或Ctrl+C均清理本次临时交接目录。
- 同一运行目录只保留一个进程；中断后使用新目录重跑。生成图片留在运行目录中。

原版prompt保持原文，Provider追加一句高难度、高精细度与最大努力提示，并保留尺寸要求。

### 参数

模型参数继续由CLI传入Provider，实际控制能力如下：

| 参数 | Codex行为 |
| --- | --- |
| `--svg_model codex-agent` | 使用SDK默认Agent模型；真实模型名传给SDK |
| `--image_model codex-imagegen` | 当前会话内置生图；其他值报错 |
| 原版 `max_tokens` / `temperature` | SDK未提供对应控制，采样采用Codex设置 |
| 原版图片尺寸参数 | 写入工具prompt，实际尺寸以返回图片为准 |

当前内置工具没有图像模型选择或思考强度参数，不能显式设置最新模型或 `max`。
最大努力提示属于自然语言要求。

上游默认将不足4K长边的图片等比例放大。使用 `--disable_auto_upscale` 可保留返回像素尺寸。

### 文本调用

SDK按原顺序接收文本和图片，返回字符串。临时工作目录关闭项目指令加载，调用结束后清理。
SDK异常原样抛给调用方，每次文本调用都会重新请求Codex。

## 交付

上游 `final.svg` 保留为详细源稿，Skill在工作副本中减少实际叶对象。\
PPTX保留可转换的原生对象，定稿生成图决定最终外观，导出遵循以下约定：

- 每个图标按结构选择整体矢量或局部位图，记录判断依据；SVG与PPT中各保留一个对象。
- 整页纯色底层设为PPT页面背景；局部面板保持完整，前景色块与白色覆盖层各自独立。
- `final.pptx` 不含备注文字；对象压缩结果保存为 `editable.svg`。

同一片多色散点作为一个完整编辑对象，必要时整片转换为局部图片，图例仍独立。文本按完整语义单元合并，同一正文段落的多行共用一个原生文本框，标题与正文分别保留文本框。标题附带的括号限定语仍归入标题文本框，各单元内部保留不同字号与粗细。Codex在现有SVG响应中修复有明确依据的生图缺陷，修复记录与工作副本保存在运行目录，原链路保持冻结。

生成图定稿后，SVG/PPTX除字体替换与已记录的明确生成缺陷外须一比一复刻。图标外观、配色与连线位置保持一致。

中文默认华文宋体（STSong），缺失时回退到新宋体（NSimSun）。英文默认Times New Roman。字体处理遵循Skill的[文本规则](.codex/skills/autofigure-edit-codex/references/postprocess.md#文本)。

保留文字内容及层级，允许为可读性调整换行与排版；导出前核对首选或回退字体可用。

导出后按相同画布尺寸叠加对照，字体替换与缺陷修复之外的差异须标明，未解决时不能声称已完成一比一复刻。

实际压缩结果需要对照渲染与对象数。`<g>` 分组不会消除其内部图元，不能据此声称减少编辑负担。遇到整页栅格结果或导出不支持的组件，Skill应处理具体问题并重新核对。

CLI可通过帮助命令核对参数：

```bash
.venv/bin/python autofigure2.py --help
```

主链路相对上游的差异仅涉及Codex Provider接入。后续同步上游时逐项检查差异，提示内容与阶段算法按上游更新；对象压缩与PPTX导出继续保留在Skill中。

本机完整示例位于 `outputs/pii-flywheel-003/`，输入来自PII分类数据飞轮项目。运行完成21个局部图标的分割与抠图，执行一次SVG优化。该历史示例曾在后处理重绘图标，未满足后来新增的一比一复刻要求；它用于验证编辑单元与导出能力。示例合并26组语义文本，将整片多色散点压缩为一个对象。具体计数和检查结果保存在运行目录的 `verification.json`；`run.log` 记录原始链路执行。该目录不随代码提交。

## webide远端运行

webide使用已有GPU环境；运行本版前须同步桥接代码和Skill。\
文本SDK在远端调用，生图由当前Agent处理，图像分割与抠图使用H20。远端执行按以下顺序准备：

1. 连接 `ssh webide`，进入 `/root/autofigure-edit-codex`，同步本次代码，执行前文依赖安装与登录命令。
   - 确认远端 `codex login status` 成功；SDK读取远端登录状态。
   - 项目 `.env` 权限保持600，不在终端输出凭据。
2. 加载项目配置，再加载无密钥的运行时配置。后者指定Node与Artifact Tool路径，并启用本地权重缓存。

   ```bash
   cd /root/autofigure-edit-codex
   set -a
   source .env
   source .env.webide-runtime
   set +a
   ```

3. 由Codex执行以下命令，并处理远端发布的生图请求。GPU运行使用远端启动器 `/root/.local/share/autofigure-runtime/run_autofigure.py`，其余CLI参数沿用前文。启动器在进程内为SAM3处理器设置官方示例采用的CUDA BF16 autocast，再把检测框与置信度转为NumPy兼容的FP32，此次类型转换不增加舍入；SAM3推理仍为BF16，RMBG继续使用原有精度。启动器位于项目外，仓库文件、上游阶段顺序和提示保持冻结。项目环境继承Conda的CUDA版PyTorch，其余项目依赖装在 `.venv`；SAM3源码位于 `/root/sam3`。SAM3与RMBG权重保存在 `/root/.cache/huggingface/hub`。

   ```bash
   export AUTOFIGURE_IMAGE_REQUEST_DIR="$PWD/outputs/run-001/.imagegen"
   .venv/bin/python -u /root/.local/share/autofigure-runtime/run_autofigure.py \
     --provider codex \
     --method_file outputs/run-001/method.txt \
     --output_dir outputs/run-001 \
     --sam_backend local \
     --optimize_iterations 1
   ```

4. 主程序保留在持久会话中，同一输出目录只运行一个进程，按[远端交接](.codex/skills/autofigure-edit-codex/references/imagegen.md#远端主机)处理请求。
   - 将生成图片传回远端，响应使用远端绝对路径；SDK继续处理文本请求。
   - 远端Skill安装目录为 `/root/.codex/skills/` 和 `/root/.agents/skills/`。
5. 主流程完成后运行Skill后处理，PPTX使用 `/root/.local/share/autofigure-pptx-runtime` 中的Artifact Tool。`RUNTIME_NODE` 等变量已由 `.env.webide-runtime` 设置；使用现有安装，避免在该目录执行 `npm prune` 删除从官方包复制的依赖。
6. 本次字体位于 `/root/.local/share/fonts/autofigure/`，Roboto采用静态Regular与Bold文件；变量字体曾导致Cairo正文错误加粗，换成静态文件并刷新字体缓存后正常。用远端Presentations Skill重新导入最终PPTX并渲染，再核对对象与备注。示例运行目录使用 `outputs/webide-demo-001/`，模型请求和各阶段日志保存在该目录。

`.env.webide-runtime` 记录当前主机路径，和密钥配置一样留在远端本地。备份版本位于项目同级目录及 `/root/.local/share/autofigure-install-backups/20260920/`，不参与Skill扫描。

历史示例已跑通生图、GPU分割、SVG优化与PPTX导出。PPTX有7个原生文本框，整片散点保留为一张局部图片，页面背景不占对象；备注为空。历史部署记录包含原始链路5项测试与Skill后处理22项测试。此前已验证SDK 0.156.1的CLI登录状态、CUDA可用性与GPU启动器帮助命令。当前会话生图交接尚未在远端部署验证。图形轮廓和文本布局已对照渲染；原图细微纹理与原生填充、字体抗锯齿仍有差异，本示例验证远端全链路运行，未达到逐像素复刻。
