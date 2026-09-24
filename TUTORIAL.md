# Codex版AutoFigure-Edit使用说明

## 安装与启动

本发行版以 `16f3749` 为上游基线，模型调用由Python SDK驱动Codex完成。\
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
   - 画面组织、参考图和风格规则见Skill的[生图设计](.codex/skills/autofigure-edit-codex/references/design.md)。
   - Skill将绘图要求写入输入材料，以新的运行目录启动主程序。
5. 手动启动使用下面的命令。Provider自动调用Codex并返回结果，同一Python进程继续执行。

   ```bash
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

Provider为每次模型请求创建独立Codex任务，按原顺序传入文本和图片。\
SDK管理登录与工具执行，文本结果返回上游解析器，生图结果从原生工具事件读取。

> **原版流程冻结**
>
> Codex只执行当前模型请求。阶段推进与失败处理继续由原版代码决定。

Provider在内存中传递请求和结果，运行时遵循以下约定：

- 文本返回字符串，生图返回PIL图片，产物由上游流程保存。
- SDK异常原样抛给调用方，每次调用均重新请求Codex。
- 同一输出目录只运行一个进程，中断后重新执行原命令。

模型参数由CLI传入Provider，Codex支持的控制项如下。

| 参数 | Codex行为 |
| --- | --- |
| `--svg_model codex-agent` | 使用Codex配置的默认Agent模型；指定真实模型名时传给SDK |
| `--image_model codex-imagegen` | 使用Codex内置生图工具，图像模型由Codex管理；其他值报错 |
| 原版 `max_tokens` / `temperature` | SDK未提供对应控制，实际采样采用Codex设置 |
| 原版图片尺寸参数 | 作为生图指令传入，Codex返回尺寸由实际产物决定 |

上游默认在生成图长边不足4K时等比例放大至4K长边，最终 `figure.png` 还受这一步影响。\
使用 `--disable_auto_upscale` 可保留Codex返回的像素尺寸。

Provider使用临时工作目录并关闭项目指令加载，避免编码工作流影响单次绘图请求。\
每次调用结束后关闭SDK进程并清理临时目录；Codex自身生成的图片缓存由Codex管理。

## 交付

上游 `final.svg` 保留为详细源稿，Skill在工作副本中减少实际叶对象。\
PPTX保留可转换的原生对象，定稿生成图决定最终外观，导出遵循以下约定：

- 每个图标按结构选择整体矢量或局部位图，记录判断依据；SVG与PPT中各保留一个对象。
- 整页纯色底层设为PPT页面背景；局部面板保持完整，前景色块与白色覆盖层各自独立。
- `final.pptx` 不含备注文字；对象压缩结果保存为 `editable.svg`。

同一片多色散点作为一个完整编辑对象，必要时整片转换为局部图片，图例仍独立。文本按完整语义单元合并，同一正文段落的多行共用一个原生文本框，标题与正文分别保留文本框。标题附带的括号限定语仍归入标题文本框，各单元内部保留不同字号与粗细。Codex在现有SVG响应中修复有明确依据的生图缺陷，修复记录与工作副本保存在运行目录，原链路保持冻结。

生成图定稿后，SVG/PPTX除字体替换与已记录的明确生成缺陷外须一比一复刻。图标外观、配色与连线位置保持一致。

字体按Skill的[文本规则](.codex/skills/autofigure-edit-codex/references/postprocess.md#文本)选择，保留文字内容及层级，允许为可读性调整换行与排版。

导出后按相同画布尺寸叠加对照，字体替换与缺陷修复之外的差异须标明，未解决时不能声称已完成一比一复刻。

实际压缩结果需要对照渲染与对象数。`<g>` 分组不会消除其内部图元，不能据此声称减少编辑负担。遇到整页栅格结果或导出不支持的组件，Skill应处理具体问题并重新核对。

CLI可通过帮助命令核对参数：

```bash
.venv/bin/python autofigure2.py --help
```

主链路相对上游的差异仅涉及Codex Provider接入。后续同步上游时逐项检查差异，提示内容与阶段算法按上游更新；对象压缩与PPTX导出继续保留在Skill中。

本机完整示例位于 `outputs/pii-flywheel-003/`，输入来自PII分类数据飞轮项目。运行完成21个局部图标的分割与抠图，执行一次SVG优化。该历史示例曾在后处理重绘图标，未满足后来新增的一比一复刻要求；它用于验证编辑单元与导出能力。示例合并26组语义文本，将整片多色散点压缩为一个对象。具体计数和检查结果保存在运行目录的 `verification.json`；`run.log` 记录原始链路执行。该目录不随代码提交。

## webide远端运行

webide已有独立GPU环境，本次Provider更新需在远端同步代码并安装新版依赖。\
SDK在运行主机发起模型调用，图像分割与抠图使用H20，PPTX使用Linux运行时。远端执行按以下顺序准备：

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

3. 选择Skill入口时由Codex执行以下启动命令；手动入口时执行相同命令，Provider自动完成模型请求。GPU运行使用远端启动器 `/root/.local/share/autofigure-runtime/run_autofigure.py`，其余CLI参数沿用前文。启动器在进程内为SAM3处理器设置官方示例采用的CUDA BF16 autocast，再把检测框与置信度转为NumPy兼容的FP32，此次类型转换不增加舍入；SAM3推理仍为BF16，RMBG继续使用原有精度。启动器位于项目外，仓库文件、上游阶段顺序和提示保持冻结。项目环境继承Conda的CUDA版PyTorch，其余项目依赖装在 `.venv`；SAM3源码位于 `/root/sam3`。SAM3与RMBG权重保存在 `/root/.cache/huggingface/hub`。

   ```bash
   .venv/bin/python -u /root/.local/share/autofigure-runtime/run_autofigure.py \
     --provider codex \
     --method_file outputs/run-001/method.txt \
     --output_dir outputs/run-001 \
     --sam_backend local \
     --optimize_iterations 1
   ```

4. 主程序保留在持久会话中，同一输出目录只运行一个进程。同步项目Skill后，使用新的自动调用说明。
   - SDK在远端内存中返回结果，上游流程保存生图产物。
   - 远端Skill安装目录为 `/root/.codex/skills/` 和 `/root/.agents/skills/`。
5. 主流程完成后运行Skill后处理，PPTX使用 `/root/.local/share/autofigure-pptx-runtime` 中的Artifact Tool。`RUNTIME_NODE` 等变量已由 `.env.webide-runtime` 设置；使用现有安装，避免在该目录执行 `npm prune` 删除从官方包复制的依赖。
6. 本次字体位于 `/root/.local/share/fonts/autofigure/`，Roboto采用静态Regular与Bold文件；变量字体曾导致Cairo正文错误加粗，换成静态文件并刷新字体缓存后正常。用远端Presentations Skill重新导入最终PPTX并渲染，再核对对象与备注。示例运行目录使用 `outputs/webide-demo-001/`，模型请求和各阶段日志保存在该目录。

`.env.webide-runtime` 记录当前主机路径，和密钥配置一样留在远端本地。备份版本位于项目同级目录及 `/root/.local/share/autofigure-install-backups/20260920/`，不参与Skill扫描。

历史示例已跑通生图、GPU分割、SVG优化与PPTX导出。PPTX有7个原生文本框，整片散点保留为一张局部图片，页面背景不占对象；备注为空。历史部署记录包含原始链路5项测试与Skill后处理22项测试。新版SDK Provider的远端运行仍需部署后验证。图形轮廓和文本布局已对照渲染；原图细微纹理与原生填充、字体抗锯齿仍有差异，本示例验证远端全链路运行，未达到逐像素复刻。
