"""Putting one capture asset into object storage, off the run loop.

ADR-012 gives the observatory no bucket credential. Its entire authority over
storage is a presigned URL the cloud mints for one key, one method and a few
minutes, so this file does exactly one thing with it: PUT the bytes and forget it.

**It runs on its own thread, and that is the point.** Everything else in the
agent is a polled state machine driven by `pump()`, single-threaded, and the run
loop takes the watchdog's device lock on every pass. A capture is a few hundred
kilobytes over an observatory uplink -- seconds when it goes well, and unbounded
when it does not. Uploading inside `pump()` would put a network stall between a
heartbeat and a Park, which is the one place in this agent where a delay is not
allowed to be somebody else's problem.

So the loop submits and walks away. Finished uploads are collected on a later
pass through `take_results`, in the same shape as everything else the loop reads.

**The URL is a credential and is never logged.** It carries the signature that
authorises the write. `urllib` puts the URL into the text of most of the errors
it raises, so every message that leaves this file goes through `_scrub` first --
the same rule `link/websocket.py` applies to the device token, for the same
reason: log files get copied into issue reports.

stdlib `urllib`, not a new dependency. The request is one PUT with two headers
and no redirect, retry or auth handling worth importing a library for.
"""

from __future__ import annotations

import logging
import queue
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime

from contracts.models import CaptureAssetKind

logger = logging.getLogger("darkview.agent.upload")

#: How long one PUT may take before it is abandoned.
#:
#: Generous, because an observatory uplink is not a datacentre link and a capture
#: is not small. Bounded, because a socket with no timeout waits forever and this
#: thread would never come back to report the failure.
DEFAULT_TIMEOUT_SECONDS = 120.0

#: How many times one asset is retried before it is given up on.
#:
#: The grant expires, so retrying is only ever worth doing inside its window --
#: `_expired` is checked before every attempt, and a lapsed grant fails
#: immediately rather than burning the remaining tries against a URL that can no
#: longer be honoured.
DEFAULT_MAX_ATTEMPTS = 3


@dataclass(frozen=True)
class UploadJob:
    """One asset, and the grant that permits it to be written."""

    mission_id: str
    command_id: str
    kind: CaptureAssetKind
    storage_key: str
    url: str
    method: str
    expires_at: datetime
    payload: bytes
    content_type: str

    def __post_init__(self) -> None:
        if self.method != "PUT":
            # The contract fixes it at PUT. A grant naming anything else is not a
            # grant this agent knows how to use, and guessing would mean sending
            # a capture with a verb the signature does not cover.
            raise ValueError(f"an upload grant must name PUT, not {self.method}")
        if self.expires_at.tzinfo is None:
            raise ValueError("expiresAt must be timezone-aware")
        if not self.payload:
            raise ValueError("refusing to upload an empty payload")


@dataclass(frozen=True)
class UploadResult:
    """What became of one job. `error` is already scrubbed of the URL."""

    mission_id: str
    command_id: str
    kind: CaptureAssetKind
    storage_key: str
    ok: bool
    error: str | None = None


def _scrub(text: str, url: str) -> str:
    """Take the presigned URL out of a message before anything can log it."""
    if not url:
        return text
    scrubbed = text.replace(url, "[PRESIGNED-URL]")
    # The query string alone is the signature, and some errors carry it without
    # the scheme and host in front. Removed separately rather than trusting the
    # whole-URL replacement above to have caught every rendering of it.
    _, separator, query = url.partition("?")
    if separator and query:
        scrubbed = scrubbed.replace(query, "[REDACTED]")
    return scrubbed


class Uploader:
    """A worker thread that PUTs capture assets and reports what happened.

    Constructed with its `put` so a test can drive every outcome -- success, an
    HTTP refusal, a timeout, a lapsed grant -- without a socket. The default is
    the real one.
    """

    def __init__(
        self,
        put=None,
        now=None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    ) -> None:
        self._put = put or _http_put
        self._now = now or (lambda: datetime.now(UTC))
        self._timeout_seconds = timeout_seconds
        self._max_attempts = max_attempts

        self._jobs: queue.Queue[UploadJob | None] = queue.Queue()
        self._results: queue.Queue[UploadResult] = queue.Queue()
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()
        self._in_flight = 0
        self._in_flight_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the worker. Idempotent, so a restarted supervisor is harmless."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stopping.clear()
        # A daemon thread: an upload in progress must not keep the agent alive
        # after the process has been told to stop. The capture is lost, and a
        # lost capture is better than an observatory that will not shut down.
        self._thread = threading.Thread(
            target=self._run, name="darkview-upload", daemon=True
        )
        self._thread.start()

    def stop(self, timeout_seconds: float = 5.0) -> None:
        """Ask the worker to finish the job in hand and exit."""
        if self._thread is None:
            return
        self._stopping.set()
        self._jobs.put(None)
        self._thread.join(timeout=timeout_seconds)
        self._thread = None

    # ------------------------------------------------------------------
    # The run loop's side
    # ------------------------------------------------------------------

    def submit(self, job: UploadJob) -> None:
        """Hand one asset to the worker. Never blocks and never raises."""
        with self._in_flight_lock:
            self._in_flight += 1
        self._jobs.put(job)

    def take_results(self) -> list[UploadResult]:
        """Everything that finished since the last call."""
        drained: list[UploadResult] = []
        while True:
            try:
                drained.append(self._results.get_nowait())
            except queue.Empty:
                return drained

    @property
    def in_flight(self) -> int:
        """Jobs submitted and not yet reported."""
        with self._in_flight_lock:
            return self._in_flight

    # ------------------------------------------------------------------
    # The worker's side
    # ------------------------------------------------------------------

    def _run(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            try:
                self._results.put(self._attempt(job))
            finally:
                with self._in_flight_lock:
                    self._in_flight -= 1
            if self._stopping.is_set() and self._jobs.empty():
                return

    def _attempt(self, job: UploadJob) -> UploadResult:
        last_error = "no attempt was made"

        for attempt in range(1, self._max_attempts + 1):
            if self._expired(job):
                last_error = "the upload grant expired before the asset was written"
                break
            try:
                self._put(job, self._timeout_seconds)
            except Exception as error:  # noqa: BLE001 - reported, never raised onward
                last_error = _scrub(f"{type(error).__name__}: {error}", job.url)
                logger.warning(
                    "upload of %s attempt %d/%d failed: %s",
                    job.storage_key,
                    attempt,
                    self._max_attempts,
                    last_error,
                )
                continue

            logger.info("uploaded %s (%d bytes)", job.storage_key, len(job.payload))
            return UploadResult(
                mission_id=job.mission_id,
                command_id=job.command_id,
                kind=job.kind,
                storage_key=job.storage_key,
                ok=True,
            )

        logger.error("giving up on %s: %s", job.storage_key, last_error)
        return UploadResult(
            mission_id=job.mission_id,
            command_id=job.command_id,
            kind=job.kind,
            storage_key=job.storage_key,
            ok=False,
            error=last_error,
        )

    def _expired(self, job: UploadJob) -> bool:
        return self._now() >= job.expires_at


def _http_put(job: UploadJob, timeout_seconds: float) -> None:
    """The real PUT. Raises on anything that is not a 2xx."""
    request = urllib.request.Request(
        job.url,
        data=job.payload,
        method="PUT",
        headers={
            "Content-Type": job.content_type,
            "Content-Length": str(len(job.payload)),
        },
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        if not 200 <= response.status < 300:  # pragma: no cover - urlopen raises first
            raise urllib.error.HTTPError(
                "[PRESIGNED-URL]", response.status, response.reason, response.headers, None
            )


__all__ = [
    "DEFAULT_MAX_ATTEMPTS",
    "DEFAULT_TIMEOUT_SECONDS",
    "UploadJob",
    "UploadResult",
    "Uploader",
]
