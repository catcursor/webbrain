#!/usr/bin/env python3
"""Package the working-tree extensions, without developer or private files."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist' / 'self-hosted'
VERSION = json.loads((ROOT / 'package.json').read_text())['version']


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    outputs = []
    for browser, suffix in [('chrome', 'zip'), ('firefox', 'xpi')]:
        source = ROOT / 'src' / browser
        manifest = json.loads((source / 'manifest.json').read_text())
        if manifest['version'] != VERSION:
            raise ValueError(f'{browser} manifest version differs from package.json')
        name = f'webbrain-{browser}-selfhosted-{VERSION}.{suffix}'
        output = OUT / name
        # Use tracked files plus the fork's explicitly added source/test files.
        tracked = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', f'src/{browser}'], cwd=ROOT, text=True).splitlines()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for relative in sorted(set(tracked)):
                path = ROOT / relative
                if not path.exists():
                    # Deleted tracked files are omitted; sparse checkouts must
                    # restore their source dependencies before making a release.
                    if relative.endswith('/skills/freeskillz-xyz.md'):
                        continue
                    raise FileNotFoundError(f'Missing source file: {relative}')
                if path.is_symlink() or not path.is_file():
                    raise ValueError(f'Only regular source files are packaged: {relative}')
                archive.write(path, path.relative_to(source).as_posix())
            if 'LICENSE' not in archive.namelist():
                archive.write(ROOT / 'LICENSE', 'LICENSE')
            archive.writestr('SELF_HOSTED_BUILD.txt', f'WebBrain self-hosted build {VERSION}\nSource revision: {revision}\nRepository: https://github.com/catcursor/webbrain\nFirefox package is unsigned.\n')
        with zipfile.ZipFile(output) as archive:
            assert archive.testzip() is None
            assert json.loads(archive.read('manifest.json'))['version'] == VERSION
            assert not any(name.startswith('/') or '..' in Path(name).parts for name in archive.namelist())
            assert 'skills/freeskillz-xyz.md' not in archive.namelist()
            assert 'src/providers/self-hosted.js' in archive.namelist()
        outputs.append(output)
    revision_file = OUT / 'SOURCE_REVISION.txt'
    revision_file.write_text(revision + '\n')
    outputs.append(revision_file)
    (OUT / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in outputs))
    for path in outputs:
        print(f'{path.name}: {path.stat().st_size:,} bytes')


if __name__ == '__main__':
    build()
