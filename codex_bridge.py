"""Call Codex in memory from the upstream model interfaces.

Install requirements.txt, run ``codex login``, then start AutoFigure with
``--provider codex``. Each call creates an isolated SDK turn and returns text or
a detached PIL image. The upstream pipeline owns output files and stage order.
Codex controls sampling; its SDK does not expose max_tokens or temperature.
"""
from __future__ import annotations

import base64
import io
import tempfile
from typing import Any

from openai_codex import ApprovalMode, Codex, CodexConfig, ImageInput, Sandbox, TextInput
from PIL import Image


def _run_codex(contents: list[Any], model: str, image_size: str | None = None) -> str | Image.Image:
    """Run one model request, preserving input order and returning its native value.

    An image_size selects the built-in image tool. Otherwise the turn returns
    text without tools. Temporary workspace and SDK process close on exit;
    SDK exceptions propagate to the upstream caller unchanged.
    """
    image_call = image_size is not None
    if image_call and model != 'codex-imagegen':
        raise ValueError('Codex built-in image generation requires --image_model codex-imagegen; '
                         'its image model is managed by Codex.')
    agent_model = None if image_call or model == 'codex-agent' else model
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
    if image_call:
        instructions += (
            'Use the built-in image generation tool exactly once and return one image. '
            'Use the supplied prompt and reference images. Do not synthesize or edit '
            'images with shell, Python, SVG, or other tools. '
            f'Requested image size: {image_size}. '
            'The application will collect the native image tool result.'
        )
    else:
        instructions += 'Return only the requested text or SVG. Do not use tools.'

    print(f'Codex calling {"image_generation" if image_call else "text"}', flush=True)
    # Isolate the model request from repository and user AGENTS.md instructions.
    with tempfile.TemporaryDirectory(prefix='autofigure-codex-') as workspace:
        with Codex(CodexConfig(cwd=workspace)) as codex:
            thread = codex.thread_start(
                cwd=workspace, ephemeral=True, model=agent_model,
                approval_mode=ApprovalMode.deny_all,
                sandbox=Sandbox.workspace_write if image_call else Sandbox.read_only,
                config={'project_doc_max_bytes': 0},
                developer_instructions=instructions,
            )
            result = thread.run(inputs)
            if result.status.value != 'completed':
                raise RuntimeError(f'Codex turn ended with status {result.status.value}')
            if image_call:
                images = [item.root for item in result.items if item.root.type == 'imageGeneration']
                if len(images) != 1 or images[0].status != 'completed' or images[0].failure:
                    details = [(item.status, str(item.failure)) for item in images]
                    raise RuntimeError(f'Codex must return one completed image generation: {details}')
                image_bytes = base64.b64decode(images[0].result, validate=True)
                with Image.open(io.BytesIO(image_bytes)) as generated:
                    return generated.copy()
            if not isinstance(result.final_response, str) or not result.final_response.strip():
                raise RuntimeError('Codex completed without a text response')
            return result.final_response


def call_text(contents: list[Any], model: str) -> str:
    """Return Codex text to the upstream SVG generation or repair caller."""
    return _run_codex(contents, model)


def call_image(prompt: str, reference: Image.Image | None, model: str, image_size: str) -> Image.Image:
    """Return a detached image; the upstream pipeline saves the final artifact."""
    contents = [prompt] if reference is None else [prompt, reference]
    return _run_codex(contents, model, image_size)
