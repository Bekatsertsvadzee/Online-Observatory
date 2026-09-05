"""What the agent knows about itself, on disk.

Everything the agent holds has been in memory: which commands it has already
decided, what it has audited, who owns the telescope, and the safety limits it
enforces. A restart lost all of it. That is not a gap in bookkeeping — it is the
idempotency guarantee, and `docs/observatory-protocol.md` is explicit that "a
production observatory agent must persist idempotency records and command
receipts across restarts before hardware integration is enabled". A slew
delivered twice because the agent forgot it had already run it is the single
highest-consequence duplicate in the system.

SQLite, in one file. It is in the standard library, so it adds no dependency; it
is a file rather than a service, so it does not touch the rule in `CLAUDE.md`
about not adding services; and it is transactional, which a directory of JSON
files is not. A half-written state file is exactly the artefact a crash produces
and exactly the one that must not exist. ADR-010 records the choice.

Three things shape the schema.

**The audit log is append-only, enforced by the database.** A trigger refuses
every UPDATE. The agent's audit is the account written by the machine that
actually holds the telescope, and its value comes entirely from nobody being able
to revise it afterwards. Deletion is permitted, but only as age-based retention,
which is the one operation that removes without rewriting.

**Writes are synchronous.** `PRAGMA synchronous=FULL`. The volume is a few rows
per mission, and the whole point is surviving the power cut, so trading
durability for speed here would be trading away the only thing this file is for.

**It is used from two threads.** The watchdog runs on its own thread and records
what it did before it acts, so the store is locked internally rather than
assuming a single caller.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from contracts.models import SafetyEnvelopeConfig
from darkview_agent.command.audit import AuditEvent

logger = logging.getLogger("darkview.agent.state")

#: How long a decided command is remembered. Commands expire in seconds, so this
#: is enormous headroom; it exists so the table cannot grow without bound on an
#: agent that runs for months.
SEEN_COMMAND_RETENTION_DAYS = 7

#: How long the local audit survives. Long enough that an incident is still
#: explainable when somebody gets round to asking about it.
AUDIT_RETENTION_DAYS = 90

SCHEMA = """
CREATE TABLE IF NOT EXISTS seen_command (
    command_id TEXT PRIMARY KEY,
    decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_command_decided_at ON seen_command (decided_at);

CREATE TABLE IF NOT EXISTS audit_event (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    kind        TEXT NOT NULL,
    command_id  TEXT,
    reason      TEXT,
    detail      TEXT NOT NULL DEFAULT '',
    context     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_event_occurred_at ON audit_event (occurred_at);

-- Append-only, enforced here rather than by convention. An audit nobody can
-- revise is the only kind worth keeping.
CREATE TRIGGER IF NOT EXISTS audit_event_is_append_only
BEFORE UPDATE ON audit_event
BEGIN
    SELECT RAISE(ABORT, 'the audit log is append-only');
END;

CREATE TABLE IF NOT EXISTS agent_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

OWNERSHIP_KEY = "ownership"
MISSION_KEY = "mission"
ENVELOPE_KEY = "safety_envelope"


@dataclass(frozen=True)
class StoredOwnership:
    """Who owned the telescope when the agent was last running."""

    mission_id: uuid.UUID
    session_id: uuid.UUID
    user_id: uuid.UUID
    expires_at: datetime | None
    cumulative_nudge_degrees: float


@dataclass(frozen=True)
class StoredMission:
    """A mission the agent was holding, recovered after a restart.

    Recovering it is not resuming it. The agent has lost the state machine's
    progress — which frame, which centring iteration, whether the slew had
    settled — and reconstructing that from a mission id would be guessing about a
    telescope's position. What this is for is telling the cloud, in
    `AgentHello.resumeMissionId`, that the observatory came back holding a
    mission nobody is flying, so the cloud can close it out.
    """

    mission_id: uuid.UUID
    state: str
    recorded_at: datetime


class StateStore:
    """The agent's durable memory. One SQLite file, opened for the process."""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        # check_same_thread=False with an explicit lock: the watchdog thread
        # audits what it is about to do, from a thread that did not open this.
        self._connection = sqlite3.connect(self._path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()

        with self._lock:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.executescript(SCHEMA)
            self._connection.commit()

    @property
    def path(self) -> str:
        return self._path

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    # ------------------------------------------------------------------
    # Idempotency
    # ------------------------------------------------------------------

    def has(self, command_id: str) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT 1 FROM seen_command WHERE command_id = ?", (command_id,)
            ).fetchone()
        return row is not None

    def remember(self, command_id: str, at: datetime) -> None:
        """Record that this command has been decided.

        `INSERT OR IGNORE`: deciding the same command twice is the retry this
        table exists to catch, and it must not raise on the way to being refused.
        """
        with self._lock:
            self._connection.execute(
                "INSERT OR IGNORE INTO seen_command (command_id, decided_at) VALUES (?, ?)",
                (command_id, _iso(at)),
            )
            self._connection.commit()

    def seen_count(self) -> int:
        with self._lock:
            return int(
                self._connection.execute("SELECT COUNT(*) FROM seen_command").fetchone()[0]
            )

    # ------------------------------------------------------------------
    # Audit
    # ------------------------------------------------------------------

    def append_audit(self, event: AuditEvent) -> None:
        with self._lock:
            self._connection.execute(
                "INSERT INTO audit_event "
                "(occurred_at, kind, command_id, reason, detail, context) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    _iso(event.occurred_at),
                    event.kind,
                    event.command_id,
                    event.reason,
                    event.detail,
                    json.dumps(event.context, separators=(",", ":"), default=str),
                ),
            )
            self._connection.commit()

    def audit_events(self, limit: int | None = None) -> list[AuditEvent]:
        """Everything recorded, oldest first. `limit` returns the most recent."""
        query = "SELECT * FROM audit_event ORDER BY id"
        if limit is not None:
            query = f"SELECT * FROM ({query} DESC LIMIT {int(limit)}) ORDER BY id"

        with self._lock:
            rows = self._connection.execute(query).fetchall()
        return [_to_audit_event(row) for row in rows]

    def audit_count(self) -> int:
        with self._lock:
            return int(
                self._connection.execute("SELECT COUNT(*) FROM audit_event").fetchone()[0]
            )

    # ------------------------------------------------------------------
    # Ownership
    # ------------------------------------------------------------------

    def save_ownership(self, ownership: StoredOwnership) -> None:
        self._put(
            OWNERSHIP_KEY,
            {
                "missionId": str(ownership.mission_id),
                "sessionId": str(ownership.session_id),
                "userId": str(ownership.user_id),
                "expiresAt": _iso(ownership.expires_at) if ownership.expires_at else None,
                "cumulativeNudgeDegrees": ownership.cumulative_nudge_degrees,
            },
        )

    def clear_ownership(self) -> None:
        self._delete(OWNERSHIP_KEY)

    def load_ownership(self) -> StoredOwnership | None:
        stored = self._get(OWNERSHIP_KEY)
        if stored is None:
            return None
        try:
            return StoredOwnership(
                mission_id=uuid.UUID(stored["missionId"]),
                session_id=uuid.UUID(stored["sessionId"]),
                user_id=uuid.UUID(stored["userId"]),
                expires_at=_parse(stored.get("expiresAt")),
                cumulative_nudge_degrees=float(stored.get("cumulativeNudgeDegrees", 0.0)),
            )
        except (KeyError, TypeError, ValueError):
            logger.error("stored ownership is unreadable; starting with no owner")
            self.clear_ownership()
            return None

    # ------------------------------------------------------------------
    # The held mission
    # ------------------------------------------------------------------

    def save_mission(self, mission_id: uuid.UUID, state: str, at: datetime) -> None:
        self._put(
            MISSION_KEY,
            {"missionId": str(mission_id), "state": state, "recordedAt": _iso(at)},
        )

    def clear_mission(self) -> None:
        self._delete(MISSION_KEY)

    def load_mission(self) -> StoredMission | None:
        stored = self._get(MISSION_KEY)
        if stored is None:
            return None
        try:
            recorded_at = _parse(stored["recordedAt"])
            assert recorded_at is not None
            return StoredMission(
                mission_id=uuid.UUID(stored["missionId"]),
                state=str(stored["state"]),
                recorded_at=recorded_at,
            )
        except (AssertionError, KeyError, TypeError, ValueError):
            logger.error("the stored mission is unreadable; discarding it")
            self.clear_mission()
            return None

    # ------------------------------------------------------------------
    # The safety envelope
    # ------------------------------------------------------------------

    def save_envelope(self, config: SafetyEnvelopeConfig) -> None:
        """Keep the measured limits so a reboot during an outage still has them.

        The contract: the agent "stores it locally and keeps enforcing it after
        the cloud link dies". Without this an agent that restarted while the
        network was down would come back UNMEASURED and refuse every slew until
        the cloud returned — safe, and the wrong kind of safe, because the
        limits were measured and known.
        """
        self._put(ENVELOPE_KEY, json.loads(config.model_dump_json(by_alias=True)))

    def load_envelope(self) -> SafetyEnvelopeConfig | None:
        stored = self._get(ENVELOPE_KEY)
        if stored is None:
            return None
        try:
            return SafetyEnvelopeConfig.model_validate(stored)
        except Exception:
            # Fail closed. A partially readable envelope is not a relaxed
            # envelope; it is no envelope, and no envelope refuses every slew.
            logger.error("the stored safety envelope is unreadable; discarding it")
            self._delete(ENVELOPE_KEY)
            return None

    # ------------------------------------------------------------------
    # Retention
    # ------------------------------------------------------------------

    def prune(self, now: datetime) -> tuple[int, int]:
        """Drop what is older than its retention. Returns (commands, events).

        Age-based deletion is the only removal either table permits, and the
        audit's trigger still refuses any rewrite. Removing an old record is
        retention; changing one is falsification.
        """
        commands_before = _iso(now - timedelta(days=SEEN_COMMAND_RETENTION_DAYS))
        events_before = _iso(now - timedelta(days=AUDIT_RETENTION_DAYS))

        with self._lock:
            commands = self._connection.execute(
                "DELETE FROM seen_command WHERE decided_at < ?", (commands_before,)
            ).rowcount
            events = self._connection.execute(
                "DELETE FROM audit_event WHERE occurred_at < ?", (events_before,)
            ).rowcount
            self._connection.commit()

        if commands or events:
            logger.info("pruned %d command record(s) and %d audit event(s)", commands, events)
        return commands, events

    # ------------------------------------------------------------------
    # Plumbing
    # ------------------------------------------------------------------

    def _put(self, key: str, value: dict) -> None:
        with self._lock:
            self._connection.execute(
                "INSERT INTO agent_state (key, value) VALUES (?, ?) "
                "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value, separators=(",", ":"))),
            )
            self._connection.commit()

    def _get(self, key: str) -> dict | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM agent_state WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            return None
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            logger.error("stored %s is not valid JSON; discarding it", key)
            self._delete(key)
            return None

    def _delete(self, key: str) -> None:
        with self._lock:
            self._connection.execute("DELETE FROM agent_state WHERE key = ?", (key,))
            self._connection.commit()


def _iso(moment: datetime) -> str:
    """Always UTC, always the same width, because these are compared as text."""
    aware = moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    return aware.astimezone(UTC).isoformat()


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _to_audit_event(row: sqlite3.Row) -> AuditEvent:
    occurred_at = _parse(row["occurred_at"])
    assert occurred_at is not None
    return AuditEvent(
        occurred_at=occurred_at,
        kind=row["kind"],
        command_id=row["command_id"],
        reason=row["reason"],
        detail=row["detail"],
        context=json.loads(row["context"]),
    )
