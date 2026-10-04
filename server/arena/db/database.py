from pathlib import Path

import aiosqlite

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


class Database:
    """SQLite connection with numbered migrations tracked in `PRAGMA user_version`."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None

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
        await self._migrate()

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
