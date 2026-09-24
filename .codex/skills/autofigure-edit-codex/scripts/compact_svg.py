"""Apply an Agent-authored object plan; never infer semantic membership.

Usage: python compact_svg.py INPUT.svg PLAN.json OUTPUT.svg
Plan: {"operations": [{"kind": "vector", "ids": ["a", "b"],
"name": "sample-cloud", "reason": "one sample cloud"}]}
A raster operation selects one root child group with ids:["group-id"] and
bbox:[x,y,width,height] in root user coordinates. It requires CairoSVG.
The source is preserved; a count report is written beside OUTPUT.svg.
A text operation combines Agent-selected plain text lines into one text element
with positioned, styled tspans. Typography never determines semantic membership.
"""
from __future__ import annotations

import argparse
import base64
import copy
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
DRAWABLE = {'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use'}


def tag(element):
    return element.tag.rsplit('}', 1)[-1]


def count_objects(element):
    """Count renderable elements, excluding definitions and text span children."""
    if tag(element) in {'defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker'}:
        return 0
    if tag(element) in DRAWABLE:
        return 1
    return sum(count_objects(child) for child in element)


def geometry(element):
    """Convert supported primitives to independent SVG subpaths in local space."""
    a = element.attrib
    kind = tag(element)
    if kind == 'path':
        if not re.match(r'^\s*M', a['d']):
            raise ValueError('Each combined path must start with absolute M')
        return a['d'], {'d'}
    if kind == 'line':
        return f"M {a.get('x1', '0')} {a.get('y1', '0')} L {a.get('x2', '0')} {a.get('y2', '0')}", {'x1','y1','x2','y2'}
    if kind in {'circle', 'ellipse'}:
        x, y = float(a.get('cx', 0)), float(a.get('cy', 0))
        rx = float(a['r'] if kind == 'circle' else a['rx'])
        ry = float(a['r'] if kind == 'circle' else a['ry'])
        # Two exact elliptical arcs, rather than a polygonal approximation.
        d = f'M {x-rx} {y} A {rx} {ry} 0 1 0 {x+rx} {y} A {rx} {ry} 0 1 0 {x-rx} {y} Z'
        return d, {'cx','cy','r','rx','ry'}
    raise ValueError(f'Unsupported vector merge primitive: {kind}')


def compact(source: Path, plan: dict, destination: Path) -> dict:
    """Execute explicit vector or raster operations and report real object counts."""
    if source.resolve() == destination.resolve():
        raise ValueError('Keep the upstream SVG; output must be a different file')
    root = ET.parse(source).getroot()
    before = count_objects(root)
    reports = []
    for operation in plan['operations']:
        if not operation['reason'].strip():
            raise ValueError('Agent must record the semantic reason')
        lookup = {e.get('id'): e for e in root.iter() if e.get('id')}
        nodes = [lookup[key] for key in operation['ids']]
        parents = {child: parent for parent in root.iter() for child in parent}
        parent = parents[nodes[0]]
        indices = [list(parent).index(e) for e in nodes if parents[e] is parent]
        if len(indices) != len(nodes) or indices != list(range(indices[0], indices[0]+len(nodes))):
            raise ValueError('Selected objects must be consecutive siblings in paint order')
        previous_count = sum(count_objects(e) for e in nodes)
        if operation['kind'] == 'text':
            if any(tag(node) != 'text' or len(node) or node.get('transform') for node in nodes):
                raise ValueError('Text example requires plain text siblings without individual transforms')
            replacement = ET.Element(f'{{{NS}}}text', {**nodes[0].attrib, 'id': operation['name']})
            for node in nodes:
                line = ET.SubElement(replacement, f'{{{NS}}}tspan', {k:v for k,v in node.attrib.items() if k != 'id'})
                line.text = node.text
        elif operation['kind'] == 'vector':
            paths, styles = [], []
            for node in nodes:
                d, geometric = geometry(node)
                style = {k:v for k,v in node.attrib.items() if k not in geometric | {'id'}}
                if any(k in style for k in ('style','opacity','fill-opacity','stroke-opacity','filter','mask','clip-path','marker-start','marker-mid','marker-end','class')):
                    raise ValueError('Resolve CSS, transparency, effects and markers before vector merging')
                paths.append(d)
                styles.append(style)
            if any(s != styles[0] for s in styles):
                raise ValueError('One compound path requires identical explicit appearance and transform')
            replacement = ET.Element(f'{{{NS}}}path', {**styles[0], 'id': operation['name'], 'd': ' '.join(paths)})
        elif operation['kind'] == 'raster':
            if len(nodes) != 1 or parent is not root or tag(nodes[0]) != 'g':
                raise ValueError('Raster example requires one root child group in root coordinates')
            import cairosvg
            x, y, width, height = operation['bbox']
            isolated = copy.deepcopy(root)
            for child in list(isolated):
                if tag(child) != 'defs' and child.get('id') != nodes[0].get('id'):
                    isolated.remove(child)
            isolated.set('viewBox', f'{x} {y} {width} {height}')
            isolated.set('width', str(width))
            isolated.set('height', str(height))
            png = cairosvg.svg2png(bytestring=ET.tostring(isolated), scale=2)
            replacement = ET.Element(f'{{{NS}}}image', {'id': operation['name'], 'x': str(x), 'y': str(y),
                'width': str(width), 'height': str(height), 'href': 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')})
        else:
            raise ValueError(f"Unknown operation: {operation['kind']}")
        if previous_count <= 1:
            raise ValueError('A merge must reduce renderable leaf objects')
        parent.insert(indices[0], replacement)
        for node in nodes:
            parent.remove(node)
        reports.append({**operation, 'before': previous_count, 'after': 1})
    destination.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(destination, encoding='utf-8', xml_declaration=True)
    report = {'before': before, 'after': count_objects(root), 'operations': reports}
    destination.with_suffix('.objects.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('plan', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(compact(args.source, json.loads(args.plan.read_text(encoding='utf-8')), args.destination), ensure_ascii=False))
