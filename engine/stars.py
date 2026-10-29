"""User bookmarks live separately from disposable event indexes."""
import sqlite3
from contextlib import closing
from pathlib import Path


class Stars:
    def __init__(self, data):
        self.path = Path(data) / 'battle-stars.sqlite3'
        with closing(sqlite3.connect(self.path, timeout=30)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS stars(scope TEXT,id TEXT,PRIMARY KEY(scope,id))')

    def ids(self, scope):
        with closing(sqlite3.connect(self.path, timeout=30)) as db:
            return {r[0] for r in db.execute('SELECT id FROM stars WHERE scope=?', (scope,))}

    def set(self, scope, key, starred):
        if type(starred) is not bool: raise ValueError('收藏状态须为开启或关闭')
        with closing(sqlite3.connect(self.path, timeout=30)) as db, db:
            old = bool(db.execute('SELECT 1 FROM stars WHERE scope=? AND id=?', (scope, key)).fetchone())
            if starred: db.execute('INSERT OR IGNORE INTO stars VALUES(?,?)', (scope, key))
            else: db.execute('DELETE FROM stars WHERE scope=? AND id=?', (scope, key))
        return {'ok': True, 'key': key, 'starred': starred, 'changed': old != starred}
