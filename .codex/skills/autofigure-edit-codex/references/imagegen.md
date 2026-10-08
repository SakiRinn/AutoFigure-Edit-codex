# 生图交接

原程序在生图Provider内等待，当前Codex Agent调用本会话内置image-gen并回传图片。
原版阶段顺序不变，Python收到PIL图片后继续保存与后续处理。

## 启动

先确认当前会话提供内置image-gen工具，再启动流水线。参考图须先用图像查看工具读取。

启动前设置 `AUTOFIGURE_IMAGE_REQUEST_DIR`，指向本次运行目录下的 `.imagegen`。
该路径属于Python运行主机；同一运行目录只保留一个流水线进程。

```bash
export AUTOFIGURE_IMAGE_REQUEST_DIR="$PWD/outputs/run-001/.imagegen"
```

启动命令继续使用 `--method_file`，参考图继续使用 `--reference_image_path`。
已有定稿图片才使用 `--input_figure_path`；这种模式不会发布生图请求。

## 请求处理

日志中的 `Codex image request:` 给出已就绪的 `request.json` 绝对路径。
每次调用使用独立的 `request-*` 目录，Agent只处理当前活跃进程发布的请求。

按以下顺序处理：

1. 保留原进程句柄，读取该请求。生成工具调用前确认原进程仍在运行。
2. 将请求中的 `prompt` 原文传给内置image-gen，保留 `transparent_background`。
3. 请求包含 `referenced_image_paths` 时，先查看这些图片，再按原顺序传入路径。
4. 调用一次内置工具，从结果确认实际图片路径，复制到运行主机本次目录中的 `imagegen.png`。
   - 内置工具通常保存到 `$CODEX_HOME/generated_images/`，以实际返回位置为准。
   - 确认复制后的文件可用PIL打开，再发布响应；仅返回图片数据时，将原数据解码保存。
5. 按下节写入响应，再等待原进程继续。原程序会将图片保存为 `figure.png`。

`prompt` 已包含原版提示，末尾追加困难任务说明和所需尺寸，Agent无需重新组织内容。
请求无参考图时，省略两个图片引用参数，避免带入当前对话中的其他图片。

当前工具没有 `model`、`quality` 或 `reasoning_effort` 参数。
保留最大努力提示；不能将其报告为已设置 `max`，也不能声称已选择最新图像模型。

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

失败回传采用相同发布方式，将JSON对象改为 `{'error': '原始错误信息'}`。
响应目录必须仍然存在；请求已结束时停止回传，禁止重新创建过期目录。

## 结束处理

Provider最多等待30分钟，超时抛出异常。生图失败向上传播，原进程按现有异常处理退出。
返回、异常或Ctrl+C都会清理本次交接目录；运行目录中的生成图片保留。

运行期间遇到异常时按以下约定处理：

- 内置工具不可用或调用失败时回传错误，报告原因；禁止改用SDK生图或Images API。
- 停止流水线时优先发送Ctrl+C并等待退出。强制终止后，确认进程已退出再清理遗留交接目录。
- 工具返回结果前进程已结束时，保留已生成图片并报告，停止回传。

重跑使用新运行目录。看到新的请求路径后才处理，不复用旧响应。

## 远端主机

Python在远端运行时，Agent先读取远端请求，将参考图复制到工具可访问的本地路径。
工具参数只替换参考图路径，保持图片内容与提示原文。

生成完成后，用 `scp` 将图片传回远端运行目录，以PIL打开确认文件完整，再在远端原子写入响应。
`image_path` 须填写远端绝对路径；原远端Python进程持续等待并在回传后继续。
