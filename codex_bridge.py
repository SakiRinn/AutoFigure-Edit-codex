"""Connect upstream model calls to Codex text and the current agent's image tool.

Install requirements.txt, run ``codex login``, then start AutoFigure with
``--provider codex``. Set AUTOFIGURE_IMAGE_REQUEST_DIR to a directory in the run
folder. The current Codex agent answers each request.json with an atomic
response.json containing an absolute image_path or an error message; see the
Skill's references/imagegen.md. Text calls use isolated SDK turns. Image calls
wait up to 30 minutes and return a detached PIL image to the same process.
The upstream pipeline owns output files and stage order.
Codex controls sampling; its SDK does not expose max_tokens or temperature.
"""
from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from openai_codex import ApprovalMode, Codex, CodexConfig, ImageInput, Sandbox, TextInput
from PIL import Image


IMAGE_WAIT_SECONDS = 1800


def _run_codex(contents: list[Any], model: str) -> str:
    """Return SDK text, preserving input order and propagating SDK errors."""
    agent_model = None if model == 'codex-agent' else model
    inputs = []
    for item in contents:
        if isinstance(item, str):
            inputs.append(TextInput(item))
        elif isinstance(item, Image.Image):
            stream = io.BytesIO()
            item.save(stream, format='PNG')
            encoded = base64.b64encode(stream.getvalue()).decode('ascii')
            inputs.append(ImageInput('data:image/png;base64,' + encoded))
        else:
            raise TypeError(f'Unsupported model input: {type(item).__name__}')
    instructions = (
        'Complete only this single AutoFigure model request. The application owns '
        'the pipeline and will perform all later stages. Do not ask questions. '
    )
    instructions += 'Return only the requested text or SVG. Do not use tools.'

    print('Codex calling text', flush=True)
    # Isolate the model request from repository and user AGENTS.md instructions.
    with tempfile.TemporaryDirectory(prefix='autofigure-codex-') as workspace:
        with Codex(CodexConfig(cwd=workspace)) as codex:
            thread = codex.thread_start(
                cwd=workspace, ephemeral=True, model=agent_model,
                approval_mode=ApprovalMode.deny_all,
                sandbox=Sandbox.read_only,
                config={'project_doc_max_bytes': 0},
                developer_instructions=instructions,
            )
            result = thread.run(inputs)
            if result.status.value != 'completed':
                raise RuntimeError(f'Codex turn ended with status {result.status.value}')
            if not isinstance(result.final_response, str) or not result.final_response.strip():
                raise RuntimeError('Codex completed without a text response')
            return result.final_response


def call_text(contents: list[Any], model: str) -> str:
    """Return Codex text to the upstream SVG generation or repair caller."""
    return _run_codex(contents, model)


def call_image(prompt: str, reference: Image.Image | None, model: str) -> Image.Image:
    """Wait for the current agent's built-in image tool and return its pixels.

    Publish tool arguments atomically under AUTOFIGURE_IMAGE_REQUEST_DIR. The
    agent writes response.json atomically in that request's directory. A success
    contains only image_path, an absolute path on this host; a failure contains
    only error, preserving the tool's message. Temporary exchange files are
    removed on return, exception, timeout, or KeyboardInterrupt. The returned
    image is detached; its source file remains owned by the agent.
    """
    if model != 'codex-imagegen':
        raise ValueError('Codex built-in image generation requires --image_model codex-imagegen; '
                         'its image model is managed by Codex.')
    request_root = os.environ.get('AUTOFIGURE_IMAGE_REQUEST_DIR')
    if not request_root:
        raise RuntimeError('Set AUTOFIGURE_IMAGE_REQUEST_DIR inside the run directory and '
                           'use the AutoFigure Skill to answer requests with built-in image_gen.')
    root = Path(request_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='request-', dir=root) as workspace:
        request_dir = Path(workspace)
        request = {
            'prompt': prompt,
            'transparent_background': False,
        }
        if reference is not None:
            reference_path = request_dir / 'reference.png'
            reference.save(reference_path, format='PNG')
            request['referenced_image_paths'] = [str(reference_path)]
        # The final filename is the ready signal; readers never see partial JSON.
        pending = request_dir / 'request.tmp'
        pending.write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
        pending.replace(request_dir / 'request.json')
        print(f'Codex image request: {request_dir / "request.json"}', flush=True)
        response_path = request_dir / 'response.json'
        deadline = time.monotonic() + IMAGE_WAIT_SECONDS
        while not response_path.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError(f'No built-in image_gen response within {IMAGE_WAIT_SECONDS}s: '
                                   f'{response_path}')
            time.sleep(0.5)
        response = json.loads(response_path.read_text(encoding='utf-8'))
        if not isinstance(response, dict) or set(response) not in ({'image_path'}, {'error'}):
            raise ValueError('Image response must contain exactly image_path or error')
        if 'error' in response:
            raise RuntimeError(f'Codex image_gen failed: {response["error"]}')
        image_path = Path(response['image_path'])
        if not image_path.is_absolute():
            raise ValueError('Image response image_path must be absolute on the pipeline host')
        with Image.open(image_path) as generated:
            return generated.copy()
