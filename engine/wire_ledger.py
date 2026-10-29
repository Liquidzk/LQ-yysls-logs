"""Lossless framed event storage; legacy JSONL and live append are supported."""
from collections import OrderedDict
import hashlib
import json
from pathlib import Path
import struct
import zlib

MAX_FRAME = 8 * 1024 * 1024
MAX_LINE = 4 * 1024 * 1024
HEADER = struct.Struct('<4sII')


def ledger_path(root, name):
    raw = Path(root) / name
    compressed = raw.with_name(raw.name + '.ylz')
    return compressed if compressed.is_file() else raw


def fingerprint(path):
    stat = path.stat()
    with path.open('rb') as stream:
        prefix = stream.read(min(64, stat.st_size))
    return f'{path.name}:{stat.st_dev}:{stat.st_ino}:{hashlib.sha256(prefix).hexdigest()}'


def read_frame(stream):
    header = stream.read(HEADER.size)
    if len(header) < HEADER.size:
        return None  # the live producer has not completed this frame yet
    magic, packed, decoded = HEADER.unpack(header)
    if magic != b'YLZ1' or not 0 < decoded <= MAX_FRAME or not 0 < packed <= MAX_FRAME + 65536:
        raise ValueError('压缩记录块头损坏，未跳过该块')
    payload = stream.read(packed)
    if len(payload) < packed: return None
    try:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(payload, decoded + 1)
        if len(raw) != decoded or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or not raw.endswith(b'\n'):
            raise ValueError('压缩记录块不完整或长度不符')
    except zlib.error as exc:
        raise ValueError('压缩记录校验失败，未跳过该块') from exc
    return raw


def iter_records(path, offset=0, budget=32 * 1024 * 1024):
    """Yield (next checkpoint, block offset, start, length, bytes).

    Complete frames are the checkpoint unit. The budget counts decoded bytes.
    """
    consumed = 0
    compressed = path.suffix == '.ylz'
    with path.open('rb') as stream:
        stream.seek(offset)
        while consumed < budget:
            block = stream.tell()
            if compressed:
                raw = read_frame(stream)
                if raw is None: return
                end, start = stream.tell(), 0
                for line in raw.splitlines(keepends=True):
                    if not line.endswith(b'\n') or len(line) > MAX_LINE:
                        raise ValueError('捕获记录包含无效或超大行')
                    yield end, block, start, len(line), line
                    start += len(line)
                consumed += len(raw)
            else:
                line = stream.readline(MAX_LINE + 1)
                if len(line) > MAX_LINE: raise ValueError('捕获记录包含超大行，无法解析')
                if not line.endswith(b'\n'): return
                yield stream.tell(), -1, block, len(line), line
                consumed += len(line)


class LedgerReader:
    """Request-local bounded cache, never shared across concurrent requests."""
    def __init__(self, root):
        self.root = Path(root)
        self.files = {}
        self.blocks = OrderedDict()
        self.cache_bytes = 0

    def __enter__(self): return self

    def __exit__(self, *_):
        for file in self.files.values(): file.close()

    def event(self, row):
        # Stream names come from the fixed allowlist, never from requests.
        name = row['stream'] + ('.ylz' if row['block'] >= 0 else '')
        if name not in self.files: self.files[name] = (self.root / name).open('rb')
        file = self.files[name]
        start, length = row['position'], row['length']
        if row['block'] >= 0:
            key = (name, row['block'])
            raw = self.blocks.get(key)
            if raw is None:
                file.seek(row['block']); raw = read_frame(file)
                if raw is None: raise ValueError('已索引的压缩块缺失，请重新载入记录')
                while self.blocks and self.cache_bytes + len(raw) > 16 * 1024 * 1024:
                    _, removed = self.blocks.popitem(last=False); self.cache_bytes -= len(removed)
                self.blocks[key] = raw; self.cache_bytes += len(raw)
            self.blocks.move_to_end(key)
            line = raw[start:start + length]
        else:
            file.seek(start); line = file.read(length)
        if len(line) != length or not line.endswith(b'\n'):
            raise ValueError('已索引的事件缺失，请重新载入记录')
        return json.loads(line)
