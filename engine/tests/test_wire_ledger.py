import io
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
import zlib
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wire_ledger import iter_records, read_frame, MAX_FRAME
from wire_store import WireStore


def frame(raw):
    packed = zlib.compress(raw, 3)
    return struct.pack('<4sII', b'YLZ1', len(packed), len(raw)) + packed


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.store = WireStore(self.base / 'data', self.base / 'captures')
        self.root = self.store.root / 'sessions' / 'one' / 'capture'
        self.root.mkdir(parents=True)
        self.key = self.store.key(self.root)
        self.line = (json.dumps({'observedAt': '2026-01-01T00:00:10Z', 'sourceActorHash': 'a',
                                'rawSkillId': 1, 'amount': 20, 'extra': '崩解'}, ensure_ascii=False) + '\n').encode()

    def test_live_partial_frame_resume_and_same_time_duplicates(self):
        path = self.root / 'damage-events.jsonl.ylz'
        chunk = frame(self.line)
        path.write_bytes(chunk + chunk[:14])
        self.assertEqual(self.store.report(self.key)['counts']['hit'], 1)
        with path.open('ab') as stream: stream.write(chunk[14:])
        report = self.store.report(self.key)
        self.assertEqual(report['counts']['hit'], 2)
        self.assertEqual(report['observedSkills'][0]['amount'], 40)
        self.assertEqual(report['events'][0]['data']['extra'], '崩解')
        self.assertEqual(self.store.report(self.key)['counts']['hit'], 2)
        with self.store.connect() as db:
            self.assertNotIn('payload', [r[1] for r in db.execute('PRAGMA table_info(events)')])

    def test_corrupt_checksum_and_oversized_frame_do_not_advance_checkpoint(self):
        path = self.root / 'damage-events.jsonl.ylz'; good = frame(self.line)
        path.write_bytes(good); self.store.sync(self.root)
        bad = bytearray(good); bad[-1] ^= 1
        with path.open('ab') as stream: stream.write(bad)
        with self.assertRaisesRegex(ValueError, '校验失败'): self.store.sync(self.root)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT offset FROM streams').fetchone()[0], len(good))
        with self.assertRaises(ValueError): read_frame(io.BytesIO(struct.pack('<4sII', b'YLZ1', 1, MAX_FRAME + 1)))
        bomb = zlib.compress(b'x' * 100000)
        with self.assertRaises(ValueError): read_frame(io.BytesIO(struct.pack('<4sII', b'YLZ1', len(bomb), 2) + bomb))

    def test_closed_torn_tail_keeps_preceding_events_and_reports_gap(self):
        (self.root / 'damage-events.jsonl.ylz').write_bytes(frame(self.line) + b'YLZ')
        (self.root / 'completion.json').write_text('{}')
        report = self.store.report(self.key)
        self.assertEqual(report['counts']['hit'], 1)
        self.assertEqual(report['skippedRows'], 1)
        self.assertFalse(report['indexing'])

    def test_numeric_index_matches_legacy_sqlite_json_precision(self):
        amount = 488663.69999999995
        line = json.dumps({'observedAt':'2026-01-01T00:00:10Z','amount':amount}) + '\n'
        (self.root / 'damage-events.jsonl.ylz').write_bytes(frame(line.encode()))
        with sqlite3.connect(':memory:') as db:
            expected = db.execute("SELECT json_extract(?, '$.amount')", (line,)).fetchone()[0]
        self.assertEqual(self.store.report(self.key)['observedSkills'][0]['amount'], expected)

    def test_conversion_rebuilds_locations_without_duplicating_legacy_rows(self):
        raw = self.root / 'damage-events.jsonl'; raw.write_bytes(self.line * 5)
        before = self.store.report(self.key)
        raw.with_name(raw.name + '.ylz').write_bytes(frame(self.line * 5))
        self.assertEqual(self.store.report(self.key), before)
        # Removing the redundant legacy file cannot affect the new locations.
        raw.unlink()
        self.assertEqual(self.store.report(self.key), before)

    def test_replacement_same_size_is_reindexed(self):
        path = self.root / 'damage-events.jsonl'
        path.write_bytes(self.line); self.store.sync(self.root)
        path.write_bytes(self.line.replace(b'20', b'30'))
        self.assertEqual(self.store.report(self.key)['events'][0]['data']['amount'], 30)

    def test_budget_stops_only_at_frame_boundary(self):
        path = self.root / 'damage-events.jsonl.ylz'
        first = frame(self.line * 5); path.write_bytes(first + frame(self.line))
        rows = list(iter_records(path, budget=1))
        self.assertEqual(len(rows), 5); self.assertEqual(rows[-1][0], len(first))
        self.assertEqual(len(list(iter_records(path, offset=rows[-1][0]))), 1)

    def test_compressed_only_import_and_reprocessed_actions(self):
        (self.root / 'statistics.jsonl.ylz').write_bytes(frame(b'{"observedAt":"2026-01-01T00:00:10Z","actors":[]}\n'))
        self.store.add_source(self.root.parent)
        self.assertIn(self.root, self.store.roots())
        (self.root / 'action-events.jsonl.ylz').write_bytes(frame(self.line * 2))
        self.assertEqual(self.store.report(self.key)['counts']['action'], 2)
        (self.root / 'action-reprocessed.jsonl.ylz').write_bytes(frame(self.line * 3))
        self.assertEqual(self.store.report(self.key)['counts']['action'], 3)


if __name__ == '__main__': unittest.main()
