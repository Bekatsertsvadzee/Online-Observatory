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
is a file rather than a service, so it does not touch the rule in `docs/ENGINEERING.md`
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

from contracts.models import AgentPosture, DisarmReason, SafetyEnvelopeConfig, WeatherState
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
    command_id  TEXT PRIMARY KEY,
    decided_at  TEXT NOT NULL,
    -- When the agent finished acting on it. NULL means the verdict was reached
    -- and the agent stopped before carrying it out; see `_forget_undecided`.
    executed_at TEXT
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

-- Arm and disarm requests from the operator's command line (ADR-024). The file is
-- the channel: the observatory accepts no inbound connection, not even from its
-- own machine. Append-only for the audit log's reason -- who armed a telescope
-- nobody was watching is not something anyone may revise afterwards.
CREATE TABLE IF NOT EXISTS posture_request (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_at TEXT NOT NULL,
    run_id       TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('ARM', 'DISARM')),
    operator     TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS posture_request_is_append_only
BEFORE UPDATE ON posture_request
BEGIN
    SELECT RAISE(ABORT, 'posture requests are append-only');
END;
"""

OWNERSHIP_KEY = "ownership"
MISSION_KEY = "mission"
ENVELOPE_KEY = "safety_envelope"
WEATHER_KEY = "weather"
RUN_KEY = "run"


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


@dataclass(frozen=True)
class StoredRun:
    """The running agent process, as the arming command line needs to see it.

    Written by the agent, read by `arm-unattended` and `disarm`. An arming names a
    run id, and a restarted agent has a new one, so an arming can never outlive
    the process it was made for.
    """

    run_id: uuid.UUID
    posture: AgentPosture
    disarm_reason: DisarmReason | None
    started_at: datetime


@dataclass(frozen=True)
class PostureRequest:
    """One ARM or DISARM, as the operator wrote it."""

    id: int
    requested_at: datetime
    run_id: uuid.UUID | None
    action: str
    operator: str


class StateStore:
    """The agent's durable memory. One SQLite file, opened for the process."""

    def __init__(self, path: str | Path, *, maintain: bool = True) -> None:
        """Open the file. `maintain=False` is for a second process on a running agent.

        The start-up maintenance forgets commands decided but never carried out,
        which is right for the process that is starting and wrong for anybody
        else: run beside a live agent, it would delete the row of a command that
        agent is carrying out at that moment. The arming command line opens with
        `maintain=False`.
        """
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
            if maintain:
                self._add_missing_columns()
                self._forget_unexecuted_commands()
            self._connection.commit()

    def _add_missing_columns(self) -> None:
        """`CREATE TABLE IF NOT EXISTS` does nothing to a table that already
        exists, so a file written by an older agent keeps the older shape."""
        columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(seen_command)")
        }
        if "executed_at" not in columns:
            self._connection.execute("ALTER TABLE seen_command ADD COLUMN executed_at TEXT")
            # Everything already in the table was decided by an agent that had no
            # notion of the difference, and the only safe reading of those rows is
            # the one that keeps refusing them: they were carried out.
            self._connection.execute(
                "UPDATE seen_command SET executed_at = decided_at WHERE executed_at IS NULL"
            )

    def _forget_unexecuted_commands(self) -> None:
        """Drop commands this agent decided but never carried out.

        `docs/observatory-protocol.md` asks that a command be "neither replayed
        nor lost". The seen-set alone gives the first half: a retry is refused as
        a duplicate. It also gave away the second half, because the row was
        written before the command ran -- so an agent that died in that window
        came back refusing, as already done, the one GOTO nobody ever performed.

        A row with no `executed_at` is a decision that had no effect on anything.
        Forgetting it lets the cloud's retry run, which is what a retry is for. A
        command that did touch the mount keeps its row and is still refused.
        """
        deleted = self._connection.execute(
            "DELETE FROM seen_command WHERE executed_at IS NULL"
        ).rowcount
        if deleted:
            logger.warning(
                "forgetting %d command(s) decided but never carried out; a retry "
                "will be accepted",
                deleted,
            )

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

        The row is written before the command runs, deliberately -- a crash
        between the two must not replay a slew. `mark_executed` closes it, and a
        row left open is dropped at the next start rather than standing in for a
        command that never happened.
        """
        with self._lock:
            self._connection.execute(
                "INSERT OR IGNORE INTO seen_command (command_id, decided_at) VALUES (?, ?)",
                (command_id, _iso(at)),
            )
            self._connection.commit()

    def mark_executed(self, command_id: str, at: datetime) -> None:
        """Record that the agent finished acting on this command.

        Refusals count: a refused command has been fully dealt with and there is
        nothing a restart could usefully redo.
        """
        with self._lock:
            self._connection.execute(
                "UPDATE seen_command SET executed_at = ? WHERE command_id = ? "
                "AND executed_at IS NULL",
                (_iso(at), command_id),
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
    # The weather
    # ------------------------------------------------------------------

    def save_weather(self, weather: WeatherState) -> None:
        """Keep the operator's hold across a restart.

        The same argument as the envelope, one step further. An agent that
        rebooted under a hold and came back with no memory of it would accept the
        next command it was sent, and the operator who closed the observatory has
        no way of learning that it reopened itself.
        """
        self._put(WEATHER_KEY, json.loads(weather.model_dump_json(by_alias=True)))

    def load_weather(self) -> WeatherState | None:
        stored = self._get(WEATHER_KEY)
        if stored is None:
            return None
        try:
            return WeatherState.model_validate(stored)
        except Exception:
            # Discarded rather than repaired, and the agent is then in the state
            # every agent is in on its first boot: it has not been told. Unlike
            # the envelope there is nothing safe to invent here -- a fabricated
            # hold would be a statement about the sky that nobody made -- and the
            # cloud re-sends the weather on every reconnect, so the gap is one
            # reconnect wide.
            logger.error("the stored weather is unreadable; discarding it")
            self._delete(WEATHER_KEY)
            return None

    # ------------------------------------------------------------------
    # Posture (ADR-024)
    # ------------------------------------------------------------------

    def save_run(self, run: StoredRun) -> None:
        self._put(
            RUN_KEY,
            {
                "runId": str(run.run_id),
                "posture": run.posture.value,
                "disarmReason": run.disarm_reason.value if run.disarm_reason else None,
                "startedAt": _iso(run.started_at),
            },
        )

    def load_run(self) -> StoredRun | None:
        stored = self._get(RUN_KEY)
        if stored is None:
            return None
        try:
            started_at = _parse(stored["startedAt"])
            assert started_at is not None
            reason = stored.get("disarmReason")
            return StoredRun(
                run_id=uuid.UUID(stored["runId"]),
                posture=AgentPosture(stored["posture"]),
                disarm_reason=DisarmReason(reason) if reason else None,
                started_at=started_at,
            )
        except (AssertionError, KeyError, TypeError, ValueError):
            # Only the command line reads this, and an unreadable run is a run it
            # cannot arm. Nothing is discarded: the agent rewrites it on its next
            # posture change, and a fabricated one could only be wrong.
            logger.error("the stored run is unreadable")
            return None

    def append_posture_request(
        self, run_id: uuid.UUID, action: str, operator: str, at: datetime
    ) -> None:
        with self._lock:
            self._connection.execute(
                "INSERT INTO posture_request (requested_at, run_id, action, operator) "
                "VALUES (?, ?, ?, ?)",
                (_iso(at), str(run_id), action, operator),
            )
            self._connection.commit()

    def posture_requests_after(self, last_id: int) -> list[PostureRequest]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM posture_request WHERE id > ? ORDER BY id", (last_id,)
            ).fetchall()
        return [_to_posture_request(row) for row in rows]

    def last_posture_request_id(self) -> int:
        """Where a starting agent begins reading. Earlier rows were for earlier runs."""
        with self._lock:
            row = self._connection.execute(
                "SELECT COALESCE(MAX(id), 0) FROM posture_request"
            ).fetchone()
        return int(row[0])

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


def _to_posture_request(row: sqlite3.Row) -> PostureRequest:
    requested_at = _parse(row["requested_at"])
    assert requested_at is not None
    try:
        run_id: uuid.UUID | None = uuid.UUID(row["run_id"])
    except ValueError:
        run_id = None
    return PostureRequest(
        id=int(row["id"]),
        requested_at=requested_at,
        run_id=run_id,
        action=row["action"],
        operator=row["operator"],
    )
