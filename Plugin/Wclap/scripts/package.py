#!/usr/bin/env python3
"""Assemble the CHOWTapeModel WCLAP bundle (chowtape.wclap/ and chowtape.wclap.tar.gz).

Run after Wclap/scripts/build.sh. The editor page is one self-contained file
(ui/index.html: its script, styles, fonts and tooltips inlined), so it works both
where a host serves the bundle at a URL and where it builds a srcdoc frame from
clap.webview get_resource. The archive is reproducible: sorted entries, fixed
ownership and permissions, and timestamps from the source commit.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = ROOT / 'Plugin'
WCLAP = PLUGIN / 'Wclap'
ASSETS = PLUGIN / 'Source/GUI/Assets'
NAME = 'chowtape.wclap'
MIME = {'.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png'}


def git(*args, cwd=ROOT):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def source_identity():
    commit = git('rev-parse', 'HEAD')
    dirty = bool(git('status', '--porcelain', '--untracked-files=no'))
    submodules = []
    for line in git('submodule', 'status', '--recursive').splitlines():
        match = re.match(r'^[ +U-]?([0-9a-f]{40}) (\S+)', line)
        if match:
            submodules.append((match[2], match[1]))
    return commit, dirty, submodules, int(git('log', '-1', '--format=%ct'))


def toolchain():
    sdk = ROOT / '.toolchains/emsdk-6.0.10'
    clang = sdk / 'upstream/bin/clang'
    version = subprocess.run([str(clang), '--version'], capture_output=True, text=True).stdout.splitlines()[0] \
        if clang.exists() else 'unknown'
    revision = git('rev-parse', 'HEAD', cwd=sdk) if (sdk / '.git').exists() else 'unknown'
    return version, revision


def tooltips():
    """The desktop editor's tooltips (gui.xml), by parameter id."""
    text = (ASSETS / 'gui.xml').read_bytes().rstrip(b'\0').decode()
    result = {}
    for element in ET.fromstring(text).iter():
        parameter, tip = element.get('parameter'), element.get('tooltip')
        if parameter and tip and parameter not in result:
            result[parameter] = tip
    return result


def editor_page():
    page = (WCLAP / 'ui/index.html').read_text()
    css = (WCLAP / 'ui/editor.css').read_text()

    def inline_asset(match):
        path = ASSETS / Path(match[1]).name
        data = base64.b64encode(path.read_bytes()).decode()
        return f'url("data:{MIME[path.suffix]};base64,{data}")'

    css = re.sub(r'url\("assets/([^"]+)"\)', inline_asset, css)
    script = (WCLAP / 'ui/editor.js').read_text()
    if '</script' in script or '</style' in css:
        raise SystemExit('The editor sources cannot be inlined')
    link = '<link rel="stylesheet" href="editor.css">'
    tag = '<script src="editor.js"></script>'
    if link not in page or tag not in page:
        raise SystemExit('ui/index.html lost its stylesheet or script tag')
    tips = json.dumps(tooltips(), ensure_ascii=False, sort_keys=True).replace('</', '<\\/')
    page = page.replace(link, f'<style>\n{css}</style>')
    page = page.replace(tag, f'<script>window.CHOWTAPE_TOOLTIPS = {tips};</script>\n<script>\n{script}</script>')
    return page


def notices(commit, dirty, submodules):
    clang, revision = toolchain()
    return '\n'.join([
        '# CHOWTapeModel WCLAP: notices',
        '',
        'CHOWTapeModel by Jatin Chowdhury (chowdsp), built as a WCLAP: a CLAP plug-in compiled to',
        'WebAssembly, with its editor as a clap.webview/3 page.',
        '',
        f'Built from https://github.com/jatinchowdhury18/AnalogTapeModel commit `{commit}`'
        + (' with uncommitted changes' if dirty else '') + '.',
        f'Toolchain: Emscripten SDK 6.0.10 (emsdk revision `{revision}`), {clang}.',
        'CLAP headers: free-audio/clap 1.2.7 (Plugin/modules/clap), including the clap.webview/3 draft.',
        '',
        '## Licenses',
        '',
        'Everything in this bundle is distributed under the GNU General Public License version 3',
        '(`LICENSE`): CHOWTapeModel, the JUCE 6 modules it links (used under JUCE\'s GPLv3 option),',
        'chowdsp_utils (BSD-3-Clause and GPLv3 modules), RTNeural (BSD-3-Clause), xsimd (BSD-3-Clause),',
        'nlohmann/json (MIT) and the Roboto Condensed fonts in the editor (Apache-2.0).',
        'The WASI file layer and the test host are adapted from the Surge XT WCLAP (GPL-3.0-or-later).',
        '',
        '## Submodules',
        '',
        *[f'- `{path}` at `{sha}`' for path, sha in submodules],
        '',
    ])


def sources(commit, dirty):
    return '\n'.join([
        '# CHOWTapeModel WCLAP: source',
        '',
        'This bundle is free software. Its complete corresponding source is the AnalogTapeModel',
        f'repository at commit `{commit}`' + (' plus uncommitted changes in the build tree' if dirty else '') + ',',
        'with its Git submodules at the commits listed in `NOTICES.md`.',
        '',
        '```sh',
        'git clone --recursive https://github.com/jatinchowdhury18/AnalogTapeModel && cd AnalogTapeModel',
        f'git checkout {commit} && git submodule update --init --recursive',
        'bash Plugin/Wclap/scripts/build.sh       # build-wclap/wclap/module.wasm',
        'python3 Plugin/Wclap/scripts/package.py  # this bundle',
        '```',
        '',
    ])


def assemble(target, dsp):
    if target.exists():
        shutil.rmtree(target)
    (target / 'ui').mkdir(parents=True)
    shutil.copyfile(dsp, target / 'module.wasm')
    (target / 'ui/index.html').write_text(editor_page())
    shutil.copyfile(ROOT / 'LICENSE', target / 'LICENSE')
    commit, dirty, submodules, epoch = source_identity()
    (target / 'NOTICES.md').write_text(notices(commit, dirty, submodules))
    (target / 'SOURCES.md').write_text(sources(commit, dirty))
    for path in target.rglob('*'):
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    return epoch


def archive(target, output, epoch):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as tar:
        entries = [target] + sorted(target.rglob('*'), key=lambda p: p.relative_to(target).as_posix())
        for path in entries:
            name = (Path(NAME) / path.relative_to(target)).as_posix() if path != target else NAME
            info = tar.gettarinfo(str(path), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = epoch
            info.mode = 0o755 if path.is_dir() else 0o644
            info.pax_headers = {}
            if path.is_dir():
                tar.addfile(info)
            else:
                with open(path, 'rb') as handle:
                    tar.addfile(info, handle)
    with open(output, 'wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as zipped:
        zipped.write(buffer.getvalue())


def check_paths(target):
    """No build-machine paths may leak into the shipped files."""
    needles = [str(ROOT).encode(), str(Path.home()).encode()]
    for path in target.rglob('*'):
        if path.is_file():
            data = path.read_bytes()
            for needle in needles:
                if needle in data:
                    raise SystemExit(f'{path.relative_to(target)} contains a build path ({needle.decode()})')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dsp', type=Path, default=ROOT / 'build-wclap/wclap/module.wasm')
    parser.add_argument('--output', type=Path, default=ROOT / 'build-wclap')
    args = parser.parse_args()
    target = args.output / NAME
    epoch = assemble(target, args.dsp)
    check_paths(target)
    tarball = args.output / (NAME + '.tar.gz')
    archive(target, tarball, epoch)
    files = [p for p in target.rglob('*') if p.is_file()]
    print(json.dumps({
        'bundle': str(target), 'archive': str(tarball),
        'sha256': hashlib.sha256(tarball.read_bytes()).hexdigest(),
        'archiveBytes': tarball.stat().st_size, 'files': len(files),
        'bytes': sum(p.stat().st_size for p in files),
        'moduleSha256': hashlib.sha256((target / 'module.wasm').read_bytes()).hexdigest(),
    }, indent=2))


if __name__ == '__main__':
    main()
