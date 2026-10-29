"""Prepare public archives from a verified local build, without personal data."""
import argparse
import hashlib
import io
import json
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd)


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def public_files(build):
    # Only the shipped program trees are candidates. Never copy an entire worktree.
    roots = {'locales', 'resources'}
    files = {'燕云Logs.exe', '检查当前游戏版本.cmd', '使用说明.txt',
             'LICENSE', 'LICENSES.chromium.html', 'version',
             'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak',
             'd3dcompiler_47.dll', 'dxcompiler.dll', 'electron_wer.dll',
             'ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin',
             'v8_context_snapshot.bin', 'vk_swiftshader_icd.json',
             'vk_swiftshader.dll', 'vulkan-1.dll'}
    forbidden = {'.git', '.local', 'captures', 'sessions', 'data', 'compatibility'}
    for file in sorted(build.rglob('*')):
        if not file.is_file():
            continue
        relative = file.relative_to(build)
        parts = set(part.lower() for part in relative.parts)
        if file.name == 'desktop.local.json' or '__pycache__' in parts or file.suffix == '.pyc':
            continue
        if (parts & forbidden or file.suffix.lower() in {'.log', '.pcap', '.pcapng', '.tsv', '.jsonl', '.ylz', '.sqlite', '.sqlite3', '.db'}
                or file.name.lower() in {'identity-cache.json', 'control.json', 'service.json', 'state.bin'}):
            raise RuntimeError(f'Private/runtime data found in build: {relative}')
        if relative.parts[0] not in roots and relative.as_posix() not in files:
            raise RuntimeError(f'Unreviewed top-level build file: {relative}')
        if file.is_symlink() or not file.resolve().is_relative_to(build):
            raise RuntimeError(f'Build file escapes directory: {relative}')
        yield file, relative.as_posix()


def verify_sources(build):
    # The active installation may have received a hotfix after its initial build.
    for source_root, target_root in [
        (ROOT / 'collector/tools', build / 'resources/collector/tools'),
        (ROOT / 'collector/config', build / 'resources/collector/config'),
        (ROOT / 'vendor/kagerou/yanyun', build / 'resources/kagerou/yanyun'),
        (ROOT / 'engine/web', build / 'resources/engine/_internal/web'),
    ]:
        for source in source_root.rglob('*'):
            if not source.is_file() or '__pycache__' in source.parts or 'node_modules' in source.parts:
                continue
            target = target_root / source.relative_to(source_root)
            if not target.is_file() or sha256(source) != sha256(target):
                raise RuntimeError(f'Build is outdated: {target.relative_to(build)}')


def source_archive(destination, version):
    prefix = f'LQ-yysls-logs-{version}/'
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as out:
        for repo, folder in [(ROOT, ''), (ROOT / 'vendor/kagerou', 'vendor/kagerou/')]:
            archive = git('archive', '--format=zip', 'HEAD', cwd=repo)
            with zipfile.ZipFile(io.BytesIO(archive)) as source:
                for entry in source.infolist():
                    if not entry.is_dir():
                        out.writestr(prefix + folder + entry.filename, source.read(entry))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    build = (args.build or ROOT / f'release/v{version}/LQ-yysls-logs-win32-x64').resolve()
    output = (args.output or ROOT / f'release/github/v{version}').resolve()
    for repo in [ROOT, ROOT / 'vendor/kagerou']:
        if git('status', '--porcelain', cwd=repo).strip():
            raise RuntimeError('Commit source changes before preparing a release')
    commit = git('rev-parse', 'HEAD').decode().strip()
    overlay = git('rev-parse', 'HEAD', cwd=ROOT / 'vendor/kagerou').decode().strip()
    pinned = git('ls-tree', 'HEAD', 'vendor/kagerou').decode().split()[2]
    if overlay != pinned:
        raise RuntimeError('Kagerou checkout does not match the source commit')
    if output.is_relative_to(build):
        raise RuntimeError('Output must be outside the input build')
    verify_sources(build)
    entries = list(public_files(build))
    output.mkdir(parents=True, exist_ok=True)
    binary = output / f'LQ-yysls-logs-v{version}-win-x64.zip'
    source = output / f'LQ-yysls-logs-v{version}-source.zip'
    manifest = {'version': version, 'sourceCommit': commit, 'kagerouCommit': overlay,
                'personalConfigurationIncluded': False,
                'files': {relative: sha256(file) for file, relative in entries}}
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    prefix = 'LQ-yysls-logs-win32-x64/'
    with zipfile.ZipFile(binary, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file, relative in entries:
            archive.write(file, prefix + relative)
        archive.write(ROOT / 'COPYING', prefix + 'COPYING')
        archive.writestr(prefix + 'release-manifest.json', manifest_text)
    source_archive(source, version)
    for file in [binary, source]:
        with zipfile.ZipFile(file) as archive:
            if archive.testzip() is not None:
                raise RuntimeError(f'Archive checksum failed: {file.name}')
    (output / 'release-manifest.json').write_text(manifest_text, encoding='utf-8')
    assets = [binary, source, output / 'release-manifest.json']
    (output / 'SHA256SUMS.txt').write_text(
        ''.join(f'{sha256(file)}  {file.name}\n' for file in assets), encoding='utf-8')
    print(json.dumps({'output': str(output), 'sourceCommit': commit,
                      'assets': [{'name': file.name, 'bytes': file.stat().st_size} for file in assets]}, indent=2))


if __name__ == '__main__':
    main()
