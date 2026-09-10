"""The agent half of DV-061: a stacked capture becomes an object in the bucket.

Until now CAPTURE was refused as unimplementable, PROCESSING was a stub that
transitioned straight to COMPLETE, and nothing in the agent had ever sent an
`AGENT_UPLOAD_GRANT_REQUEST` or an `AGENT_CAPTURE_READY`. The cloud half of the
path has existed since ADR-012 landed and had nothing to talk to.

Every protection this file describes was verified by removing it and confirming
the named test fails. They are listed in the branch's evidence note.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import numpy as np
import pytest
from PIL import Image

from contracts.models import (
    AgentCaptureReady,
    AgentUploadGrantRequest,
    CaptureAssetKind,
    ImagingProfile,
    MissionState,
    ObservatoryMode,
    OpticalConfig,
)
from darkview_agent.capture import profiles
from darkview_agent.capture.deliverable import render
from darkview_agent.capture.overlay import Caption
from darkview_agent.capture.overlay import apply as apply_caption
from darkview_agent.capture.upload import Uploader, UploadJob, UploadResult
from darkview_agent.devices.frame import Frame
from tests import command_fixtures as commands
from tests.agent_harness import build_agent, run_to

GRANT_EXPIRY = datetime(2026, 6, 21, 22, 30, tzinfo=UTC)


class SyncUploader:
    """The `Uploader` interface, without a thread.

    The real one is deliberately asynchronous, which is what makes it safe to
    call from the run loop and useless for asserting on a single pump. Its
    threading is covered on its own below; everything about the supervisor's
    behaviour is driven through this.
    """

    def __init__(self, fail: set[CaptureAssetKind] | None = None) -> None:
        self.fail = fail or set()
        self.jobs: list[UploadJob] = []
        self._results: list[UploadResult] = []
        self.started = False

    def start(self) -> None:
        self.started = True

    def stop(self, timeout_seconds: float = 5.0) -> None:
        self.started = False

    def submit(self, job: UploadJob) -> None:
        self.jobs.append(job)
        ok = job.kind not in self.fail
        self._results.append(
            UploadResult(
                mission_id=job.mission_id,
                command_id=job.command_id,
                kind=job.kind,
                storage_key=job.storage_key,
                ok=ok,
                error=None if ok else "refused by the test double",
            )
        )

    def take_results(self) -> list[UploadResult]:
        drained, self._results = self._results, []
        return drained

    def job_for(self, kind: CaptureAssetKind) -> UploadJob:
        for job in self.jobs:
            if job.kind is kind:
                return job
        raise AssertionError(f"no upload was submitted for {kind.value}")


def frame(mode: ObservatoryMode = ObservatoryMode.simulated) -> Frame:
    pixels = (
        np.random.default_rng(11).normal(600, 60, (240, 320)).clip(0, 65535)
    ).astype(np.uint16)
    return Frame(
        pixels=pixels,
        exposure_milliseconds=2000.0,
        gain=200,
        captured_at=datetime(2026, 6, 21, 22, 5, tzinfo=UTC),
        mode=mode,
        stacked_frames=12,
    )


def caption(mode: ObservatoryMode = ObservatoryMode.simulated) -> Caption:
    return Caption(
        captured_at=datetime(2026, 6, 21, 22, 5, tzinfo=UTC),
        integration_seconds=24.0,
        frames_stacked=12,
        mode=mode,
        optical_config="F10_NATIVE",
    )


def grant(
    request: dict,
    *,
    storage_key: str | None = None,
    url: str = "https://bucket.invalid/o?X-Amz-Signature=SIGNATURE",
    method: str = "PUT",
    mission_id: str | None = None,
    expires_at: datetime = GRANT_EXPIRY,
) -> dict:
    """A CLOUD_UPLOAD_GRANT answering one AGENT_UPLOAD_GRANT_REQUEST."""
    return {
        "type": "CLOUD_UPLOAD_GRANT",
        "messageId": str(uuid4()),
        "sentAt": datetime(2026, 6, 21, 22, 6, tzinfo=UTC).isoformat(),
        "missionId": mission_id or request["missionId"],
        "commandId": request["commandId"],
        "kind": request["kind"],
        "storageKey": storage_key
        or f"captures/observatory/{request['commandId']}/{request['kind']}",
        "url": url,
        "method": method,
        "expiresAt": expires_at.isoformat(),
    }


def capture_through_processing(agent, uploader: SyncUploader) -> list[dict]:
    """Own, slew, request a capture, and run the mission out. Returns the requests."""
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)
    # Three frames rather than the fixture's thirty. What the run is made of is
    # the profile table's business and is tested there; every test below is
    # about what happens to the picture afterwards.
    ack = agent.command(
        commands.capture(
            payload=dict(commands.capture_payload(), requestedFrames=3),
            issued_at=agent.wall.now,
        )
    )
    assert ack["status"] == "ACCEPTED", ack
    run_to(agent, MissionState.complete)
    agent.pump()
    return agent.sent("AGENT_UPLOAD_GRANT_REQUEST")


# --------------------------------------------------------------------------
# The profile table
# --------------------------------------------------------------------------


def test_every_imaging_profile_has_settings():
    """A profile with no row would be a KeyError in the middle of a mission."""
    for profile in ImagingProfile:
        assert profiles.PROFILES[profile].exposure_milliseconds > 0


def test_an_explicit_frame_count_beats_a_target_integration():
    """Both may be sent. The more specific of the two decides."""
    settings = profiles.resolve(
        ImagingProfile.globular_cluster,
        requested_frames=7,
        target_integration_seconds=600.0,
    )
    assert settings.frames == 7


def test_a_target_integration_rounds_up_rather_than_under_delivering():
    """10 seconds of a 3-second sub is four frames, not three."""
    settings = profiles.resolve(
        ImagingProfile.planetary_nebula, target_integration_seconds=10.0
    )
    assert settings.frames == 4


def test_a_frame_count_above_the_ceiling_is_clamped_not_refused():
    """The bound is on how long the agent holds the telescope, not on the customer."""
    settings = profiles.resolve(ImagingProfile.lunar, requested_frames=100_000)
    assert settings.frames == profiles.MAX_FRAMES


# --------------------------------------------------------------------------
# The overlay
# --------------------------------------------------------------------------


def test_a_simulated_capture_is_marked_simulated_on_the_image():
    """CLAUDE.md: simulator output is never presented as real telescope output.

    A database column does not survive a screenshot. This does.
    """
    plain = Image.new("L", (800, 600), 40)
    marked = apply_caption(plain, caption(ObservatoryMode.simulated))
    unmarked = apply_caption(plain, caption(ObservatoryMode.real))

    assert marked.tobytes() != unmarked.tobytes()
    assert caption(ObservatoryMode.simulated).is_simulated
    assert not caption(ObservatoryMode.real).is_simulated


def test_the_caption_says_when_how_much_and_through_what():
    text = caption().text()
    assert "2026-06-21" in text
    assert "24s (12 frames)" in text
    assert "F10_NATIVE" in text


def test_the_image_carries_the_caption_and_the_unmarked_copy_does_not():
    """What `CaptureAssetKind` means by IMAGE and UNMARKED, held to."""
    deliverable = render(frame(), caption())

    assert deliverable.image.payload != deliverable.unmarked.payload
    # The same picture, not a different one: only the caption differs.
    assert deliverable.image.width_px == deliverable.unmarked.width_px
    assert deliverable.image.height_px == deliverable.unmarked.height_px


# --------------------------------------------------------------------------
# The uploader
# --------------------------------------------------------------------------


def job(**kwargs) -> UploadJob:
    defaults = dict(
        mission_id=str(uuid4()),
        command_id=str(uuid4()),
        kind=CaptureAssetKind.image,
        storage_key="captures/o/m/c/IMAGE",
        url="https://bucket.invalid/o?X-Amz-Signature=SIGNATURE",
        method="PUT",
        expires_at=GRANT_EXPIRY,
        payload=b"jpeg-bytes",
        content_type="image/jpeg",
    )
    return UploadJob(**{**defaults, **kwargs})


def test_a_grant_naming_anything_but_put_is_refused():
    """The contract fixes the method. A signature covers one verb."""
    with pytest.raises(ValueError, match="PUT"):
        job(method="POST")


def test_an_empty_payload_is_refused():
    with pytest.raises(ValueError, match="empty payload"):
        job(payload=b"")


def test_a_lapsed_grant_is_not_attempted():
    """Retrying against an expired signature burns tries on a refusal."""
    attempts: list[UploadJob] = []
    uploader = Uploader(
        put=lambda j, t: attempts.append(j),
        now=lambda: GRANT_EXPIRY + timedelta(seconds=1),
    )
    result = uploader._attempt(job())

    assert attempts == []
    assert not result.ok
    assert "expired" in result.error


def test_a_failing_upload_is_retried_and_then_given_up_on():
    calls: list[int] = []

    def boom(j, t):
        calls.append(1)
        raise OSError("connection reset")

    uploader = Uploader(put=boom, now=lambda: GRANT_EXPIRY - timedelta(minutes=5), max_attempts=3)
    result = uploader._attempt(job())

    assert len(calls) == 3
    assert not result.ok


def test_the_presigned_url_never_reaches_a_log_or_an_error(caplog):
    """The URL is the whole of the observatory's authority over storage.

    `link/websocket.py` applies the same rule to the device token, for the same
    reason: log files get copied into issue reports.
    """
    def boom(j, t):
        raise OSError(f"could not reach {j.url}")

    # Both halves of `_scrub`, because a presigned URL does not have to put its
    # authority in the query string: SigV4 does, but a grant is whatever the
    # cloud's storage provider mints, and one that signs in the path would
    # otherwise be caught only by the whole-URL replacement.
    signed_in_query = "https://bucket.invalid/o?X-Amz-Signature=DO-NOT-LOG-THIS"
    signed_in_path = "https://bucket.invalid/DO-NOT-LOG-THIS/object.jpg"

    for secret in (signed_in_query, signed_in_path):
        caplog.clear()
        uploader = Uploader(
            put=boom, now=lambda: GRANT_EXPIRY - timedelta(minutes=5), max_attempts=1
        )
        with caplog.at_level(logging.DEBUG):
            result = uploader._attempt(job(url=secret))

        assert "DO-NOT-LOG-THIS" not in (result.error or ""), secret
        assert "DO-NOT-LOG-THIS" not in caplog.text, secret
        assert secret not in caplog.text, secret


def test_a_signature_is_scrubbed_even_without_the_url_in_front_of_it():
    """The second half of `_scrub`, and the case it exists for.

    A library does not have to hand back the URL it was given. `urllib` renders
    a redirected or re-encoded URL differently, and an error that quotes only
    the query string carries the whole signature with none of the text the
    whole-URL replacement is looking for.
    """
    from darkview_agent.capture.upload import _scrub

    url = "https://bucket.invalid/o?X-Amz-Signature=DO-NOT-LOG-THIS"
    quoted_query_only = "refused: X-Amz-Signature=DO-NOT-LOG-THIS"

    assert "DO-NOT-LOG-THIS" not in _scrub(quoted_query_only, url)


def test_the_worker_thread_reports_what_it_did():
    """The whole point of the thread: submit now, collect on a later pass."""
    uploader = Uploader(put=lambda j, t: None, now=lambda: GRANT_EXPIRY - timedelta(minutes=5))
    uploader.start()
    try:
        uploader.submit(job())
        for _ in range(200):
            results = uploader.take_results()
            if results:
                break
            # The worker is a real thread. Yielding is what lets it run.
            time.sleep(0.01)
        else:  # pragma: no cover - a stuck worker
            raise AssertionError("the worker never reported")
    finally:
        uploader.stop()

    assert results[0].ok
    assert uploader.in_flight == 0


# --------------------------------------------------------------------------
# The supervisor, end to end against the simulator
# --------------------------------------------------------------------------


def test_capture_is_no_longer_refused_as_unimplementable():
    """The refusal this branch removed. It named DV-033 and DV-061."""
    from darkview_agent.supervisor import UNIMPLEMENTED_COMMANDS

    assert "CAPTURE" not in UNIMPLEMENTED_COMMANDS


def test_a_capture_runs_and_reports_the_key_the_cloud_derived():
    """The whole path: stack, ask, upload, report.

    The reported key is the cloud's own, echoed back off the grant. The agent
    never constructs one, which is what makes `CaptureAsset.storageKey`
    trustworthy (ADR-012).
    """
    uploader = SyncUploader()
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    requests = capture_through_processing(agent, uploader)
    assert {request["kind"] for request in requests} == {"IMAGE", "UNMARKED"}

    for request in requests:
        agent.deliver(grant(request))
    agent.pump()

    ready = agent.sent("AGENT_CAPTURE_READY")
    assert len(ready) == 1
    reported = ready[0]

    image_grant = uploader.job_for(CaptureAssetKind.image)
    assert reported["imageStorageKey"] == image_grant.storage_key
    assert reported["unmarkedStorageKey"] == uploader.job_for(
        CaptureAssetKind.unmarked
    ).storage_key
    assert reported["fitsStorageKey"] is None
    assert reported["framesStacked"] > 0
    assert reported["mode"] == ObservatoryMode.simulated.value
    agent.close()


def test_the_agent_never_proposes_a_storage_key():
    """`AgentUploadGrantRequest` has no key field, and `additionalProperties: false`
    turns an agent that invents one into a validation failure rather than a
    decision the cloud has to make. This holds the agent to the same rule."""
    uploader = SyncUploader()
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    requests = capture_through_processing(agent, uploader)

    for request in requests:
        assert "storageKey" not in request
        assert "url" not in request
        # Validates, which is the stronger statement: extra='forbid' means any
        # field the agent added would be refused here.
        AgentUploadGrantRequest.model_validate(request)
    agent.close()


def test_both_messages_validate_against_the_generated_contract_models():
    """Contracts are the single source of truth. These are generated from the spec."""
    uploader = SyncUploader()
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    requests = capture_through_processing(agent, uploader)
    for request in requests:
        agent.deliver(grant(request))
    agent.pump()

    ready = AgentCaptureReady.model_validate(agent.sent("AGENT_CAPTURE_READY")[0])
    assert ready.optical_config is OpticalConfig.f10_native
    assert ready.integration_seconds > 0
    assert ready.image_storage_key
    agent.close()


def test_a_grant_naming_a_different_mission_is_discarded():
    """A grant is authority to write. It is checked against the capture it claims
    to answer before any bytes leave the observatory."""
    uploader = SyncUploader()
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    requests = capture_through_processing(agent, uploader)
    for request in requests:
        agent.deliver(grant(request, mission_id=str(uuid4())))
    agent.pump()

    assert uploader.jobs == []
    assert agent.sent("AGENT_CAPTURE_READY") == []
    agent.close()


def test_a_grant_for_an_unknown_capture_is_discarded():
    uploader = SyncUploader()
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    requests = capture_through_processing(agent, uploader)
    stray = dict(requests[0], commandId=str(uuid4()))
    agent.deliver(grant(stray))
    agent.pump()

    assert uploader.jobs == []
    agent.close()


def test_a_capture_whose_image_failed_to_upload_is_not_reported():
    """`imageStorageKey` is required, so there is no honest message to send.

    Announcing the capture anyway would put a download that 404s in the
    customer's Collection -- the exact thing the nullable optional keys avoid.
    """
    uploader = SyncUploader(fail={CaptureAssetKind.image})
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    requests = capture_through_processing(agent, uploader)
    for request in requests:
        agent.deliver(grant(request))
    agent.pump()

    assert agent.sent("AGENT_CAPTURE_READY") == []
    assert agent.supervisor.audit.events_of_kind("CAPTURE_LOST")
    agent.close()


def test_a_capture_whose_unmarked_copy_failed_is_still_reported():
    """UNMARKED is nullable. Losing it costs the optional asset, not the capture."""
    uploader = SyncUploader(fail={CaptureAssetKind.unmarked})
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    requests = capture_through_processing(agent, uploader)
    for request in requests:
        agent.deliver(grant(request))
    agent.pump()

    ready = agent.sent("AGENT_CAPTURE_READY")
    assert len(ready) == 1
    assert ready[0]["imageStorageKey"]
    assert ready[0]["unmarkedStorageKey"] is None
    agent.close()


def test_the_observing_wait_lapses_at_the_production_default():
    """The one test that pays for the real dwell, so the number is not fiction.

    Every other test shortens it -- see `build_agent`. This one holds the default
    to its meaning: the wait ends on its own, and the mission goes on to finish.
    """
    from darkview_agent.mission.runner import DEFAULT_OBSERVING_SECONDS

    agent = build_agent(
        max_altitude_degrees=70.0,
        uploader=SyncUploader(),
        observing_seconds=DEFAULT_OBSERVING_SECONDS,
    )
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)

    # Well short of the dwell: still waiting for somebody to press Capture.
    agent.advance(DEFAULT_OBSERVING_SECONDS / 3, steps=2)
    assert agent.supervisor.runner.state is MissionState.observing

    agent.advance(DEFAULT_OBSERVING_SECONDS, steps=2)
    assert agent.supervisor.runner.state is not MissionState.observing
    agent.close()


def test_a_mission_nobody_captured_delivers_nothing():
    """OBSERVING lapses, the machine still completes, and no object is written."""
    uploader = SyncUploader()
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.complete)
    agent.pump()

    assert agent.sent("AGENT_UPLOAD_GRANT_REQUEST") == []
    assert agent.sent("AGENT_CAPTURE_READY") == []
    assert agent.supervisor.runner.state is MissionState.complete
    agent.close()


def test_a_capture_with_no_mission_running_is_refused():
    agent = build_agent(max_altitude_degrees=70.0, uploader=SyncUploader())
    agent.own()

    ack = agent.command(commands.capture(issued_at=agent.wall.now))

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "NO_ACTIVE_MISSION"
    agent.close()


def test_a_second_capture_once_the_run_has_started_is_refused():
    """Changing the exposure halfway leaves a stack averaged from two of them."""
    uploader = SyncUploader()
    agent = build_agent(max_altitude_degrees=70.0, uploader=uploader)

    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)
    assert agent.command(commands.capture(issued_at=agent.wall.now))["status"] == "ACCEPTED"
    run_to(agent, MissionState.capturing)

    ack = agent.command(commands.capture(issued_at=agent.wall.now))

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "DEVICE_UNAVAILABLE"
    agent.close()
