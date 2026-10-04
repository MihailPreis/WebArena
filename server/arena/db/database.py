import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import aiosqlite

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


class Database:
    """SQLite connection with numbered migrations tracked in `PRAGMA user_version`."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None
        self._write_lock = asyncio.Lock()

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database is not connected")
        return self._conn

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode = WAL")
        await self._conn.execute("PRAGMA foreign_keys = ON")
        # Wait instead of failing if another process (a backup, a shell) holds the file.
        await self._conn.execute("PRAGMA busy_timeout = 5000")
        await self._migrate()

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[aiosqlite.Connection]:
        """Runs writes as one unit: committed together, or rolled back together on error.

        All writes go through here. They share one connection, so without the lock
        one coroutine's commit could cut another's transaction in half.
        """
        async with self._write_lock:
            try:
                yield self.conn
            except BaseException:
                await self.conn.rollback()
                raise
            await self.conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def _migrate(self) -> None:
        cursor = await self.conn.execute("PRAGMA user_version")
        row = await cursor.fetchone()
        current = int(row[0]) if row else 0
        for file in sorted(MIGRATIONS_DIR.glob("*.sql")):
            number = int(file.name.split("_", 1)[0])
            if number <= current:
                continue
            sql = file.read_text(encoding="utf-8")
            # The version bump is part of the transaction, so a failed migration leaves no trace.
            await self.conn.executescript(
                f"BEGIN;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;"
            )
