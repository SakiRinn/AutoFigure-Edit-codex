# 生图交接

原程序在生图Provider内等待，当前Codex Agent调用本会话内置image-gen并回传图片。

原版阶段顺序不变，Python收到PIL图片后继续保存与后续处理。

## 启动

先完成 [输入材料核对](../SKILL.md#输入材料)，确认当前会话提供内置image-gen工具，再启动流水线。

参考图须先用图像查看工具读取，仅借鉴视觉风格。结构与布局按方法安排，风格文件中的明确要求优先。

启动前设置 `AUTOFIGURE_IMAGE_REQUEST_DIR`，指向本次运行目录下的 `.imagegen`。

该路径属于Python运行主机；同一运行目录只保留一个流水线进程。

```bash
export AUTOFIGURE_IMAGE_REQUEST_DIR="$PWD/outputs/run-001/.imagegen"
```

交接目录设置后，启动参数按输入类型选择：

- 方法文本使用 `--method_file`，自定义风格使用 `--style_file`，省略风格参数时加载项目默认 `style.txt`。
- 参考图使用 `--reference_image_path`。
- 已有定稿图片才使用 `--input_figure_path`；这种模式不会发布生图请求。

方法文本模式发布请求后，Agent按日志中的路径处理本次调用。

## 请求处理

日志中的 `Codex image request:` 给出已就绪的 `request.json` 绝对路径。

每次调用使用独立的 `request-*` 目录，Agent只处理当前活跃进程发布的请求。

按以下顺序处理：

1. 保留原进程句柄，读取该请求。生成工具调用前确认原进程仍在运行。
2. 将请求中的 `prompt` 原文传给内置image-gen，保留 `transparent_background`。
3. 请求包含 `referenced_image_paths` 时，先查看这些图片，再按原顺序传入路径。
4. 调用内置工具生成候选图，确认返回的实际图片路径，再用图像查看工具读取候选图。
5. 按方法内容与本次实际风格文件逐项验收，记录实际检查结果；发现问题先修订并复查。
   - 方法问题更新 `method.txt`，视觉问题更新本次 `style.txt`。保留模板，将完整新内容替换进对应标签后再调用工具。
   - 保存本次实际调用提示与修订记录；修改文件不会改变等待中的请求，须更新工具调用提示。
   - 修订保留原请求的其他要求；未通过验收时禁止发布含 `image_path` 的成功响应。
6. 全部适用项通过并定稿后，复制定稿图到运行主机本次目录中的 `imagegen.png`。
   - 内置工具通常保存到 `$CODEX_HOME/generated_images/`，以实际返回位置为准。
   - 确认复制后的文件可用PIL打开；仅返回图片数据时，将原数据解码保存。
7. 按下节写入成功响应，再等待原进程继续。原程序保存 `figure.png` 后才进入后续重建。

请求内容与工具参数共同决定本次调用，原文传入还须遵循以下约定。

**调用约束：**

- 首次调用原文传入请求中的 `prompt`，其中已含主程序模板统一规定的细节、质量与最大努力要求，桥接层原样传递；修订只调整已记录问题。
- 请求无参考图时，省略两个图片引用参数，避免带入当前对话中的其他图片。
- 当前工具没有 `model`、`quality` 或 `reasoning_effort` 参数，调用时保留最大努力提示。
- 调用结果不能报告为已设置 `max`，也不能声称已选择最新图像模型。

视觉验收通过后回传定稿图；工具错误或验收无法通过时，按下节回传错误并保留具体原因。

## 结果回传

图片须完整保存到Python运行主机，成功响应仅包含 `image_path`。

该字段使用绝对路径，Provider读取图片后返回独立的PIL对象。

```json
{"image_path": "/absolute/run/imagegen.png"}
```

工具失败时，响应仅包含 `error`，保留原始失败信息。原程序会收到异常。

```json
{"error": "Original image_gen error message"}
```

响应须先写临时文件，再以同目录重命名发布，避免Python读取半写入的JSON。

以下命令在Python运行主机执行；按实际请求替换两个路径：

```bash
.venv/bin/python - /absolute/request-dir /absolute/run/imagegen.png <<'PY'
import json
import sys
from pathlib import Path

request_dir = Path(sys.argv[1])
image_path = Path(sys.argv[2]).resolve(strict=True)
pending = request_dir / 'response.tmp'
pending.write_text(json.dumps({'image_path': str(image_path)}), encoding='utf-8')
pending.replace(request_dir / 'response.json')
PY
```

成功与失败响应均使用上述原子发布方式，发布前核对以下条件。

**发布检查：**

- 成功响应对应的图片须已有逐项验收记录且全部适用项通过；PIL可打开仅表示文件可读。
- 失败回传将JSON对象改为 `{'error': '原始错误信息'}`，保留原始失败信息。
- 响应目录必须仍然存在；请求已结束时停止回传，禁止重新创建过期目录。

响应发布后继续跟进原进程，交接目录的清理由Provider负责。

## 结束处理

Provider最多等待30分钟，包含生图、修订与验收；超时抛出异常，原进程按现有异常处理退出。

每次修订前确认原进程仍在等待。同一问题修订后仍未解决时停止，回传未通过项并保留候选图，禁止降级放行。

返回、异常或Ctrl+C都会清理本次交接目录；运行目录中的生成图片保留。

运行期间遇到异常时按以下约定处理：

- 内置工具不可用或调用失败时回传错误，报告原因；禁止改用SDK生图或Images API。
- 停止流水线时优先发送Ctrl+C并等待退出。强制终止后，确认进程已退出再清理遗留交接目录。
- 工具返回结果前进程已结束时，保留已生成图片并报告，停止回传。

重跑使用新运行目录。看到新的请求路径后才处理，不复用旧响应。

## 远端主机

Python在远端运行时，请求及响应均保存在远端，内置工具使用本地可访问的图片路径。

按传输顺序完成交接：

1. 读取远端请求，将参考图复制到工具可访问的本地路径。
2. 工具参数只替换参考图路径，保持图片内容与提示原文，再执行生图。
3. 在本地按请求处理步骤验收并定稿，再用 `scp` 传回远端运行目录，以PIL打开确认文件完整。
4. 在远端原子写入响应，`image_path` 填写远端绝对路径；原远端Python进程持续等待并在回传后继续。
