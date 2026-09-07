"""The live view: what reaches the wire, and what deliberately does not.

DV-032. The rules worth pinning are the ones a plausible change would break --
that a frame is stretched before it is encoded, that a live frame is dropped
rather than queued, and that the header describes the image actually sent rather
than the sensor it came off.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

import numpy as np
import pytest

from contracts.models import ObservatoryMode
from darkview_agent.clock import ManualClock
from darkview_agent.devices.frame import Frame
from darkview_agent.devices.starfield import render
from darkview_agent.stream.mjpeg import (
    LiveView,
    StreamSettings,
    encode_frame,
    live_frame_header,
    stretch_to_8bit,
)

MISSION = str(uuid4())
AT = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)


def a_frame(width: int = 640, height: int = 480, **overrides) -> Frame:
    pixels = render(width, height, 45.0, 120.0, 500.0, 120)
    return Frame(
        pixels=pixels,
        exposure_milliseconds=500.0,
        gain=120,
        captured_at=AT,
        mode=ObservatoryMode.simulated,
        **overrides,
    )


class RecordingSend:
    """Stands in for the link. Records what it was handed."""

    def __init__(self, online: bool = True) -> None:
        self.online = online
        self.sent: list[tuple[dict, bytes]] = []

    def __call__(self, header: dict, payload: bytes) -> bool:
        if not self.online:
            return False
        self.sent.append((header, payload))
        return True


class TestTheStretch:
    def test_a_linear_frame_would_be_almost_black_without_it(self):
        pixels = a_frame().pixels

        # The sky is a few hundred ADU in a 16-bit container. Shown as-is, a live
        # view of a real night sky is a black rectangle, which is the whole reason
        # this step exists rather than a plain 16-to-8-bit shift.
        naive = (pixels >> 8).astype(np.uint8)
        assert int(np.median(naive)) < 8

        stretched = stretch_to_8bit(pixels, StreamSettings())
        assert int(np.median(stretched)) > 8

    @pytest.mark.parametrize("size", [(320, 240), (640, 480), (1280, 720)])
    def test_the_background_lands_in_the_same_place_whatever_the_frame(self, size):
        settings = StreamSettings()
        stretched = stretch_to_8bit(a_frame(*size).pixels, settings)

        # The property that matters, and the one a percentile stretch could not
        # hold: the same sky at three sizes came out with backgrounds of 3, 12 and
        # 32 out of 255 before this was anchored to the median. A live view whose
        # brightness moves with the star field is a live view that flickers.
        expected = settings.target_background * 255
        assert int(np.median(stretched)) == pytest.approx(expected, abs=8)

    def test_stars_still_reach_the_top_of_the_range(self):
        stretched = stretch_to_8bit(a_frame().pixels, StreamSettings())

        # Lifting the background must not come at the cost of the thing the
        # customer is looking at.
        assert stretched.max() > 230
        assert stretched.dtype == np.uint8

    def test_a_darker_target_produces_a_darker_sky(self):
        pixels = a_frame().pixels

        dark = stretch_to_8bit(pixels, StreamSettings(target_background=0.10))
        bright = stretch_to_8bit(pixels, StreamSettings(target_background=0.35))

        assert int(np.median(dark)) < int(np.median(bright))

    def test_a_frame_with_no_dynamic_range_is_black_rather_than_a_division_by_zero(self):
        flat = np.full((16, 16), 65535, dtype=np.uint16)

        stretched = stretch_to_8bit(flat, StreamSettings())

        assert stretched.max() == 0

    def test_one_hot_pixel_does_not_decide_the_background(self):
        pixels = a_frame(64, 64).pixels.copy()
        without = stretch_to_8bit(pixels, StreamSettings())

        pixels[0, 0] = 65535
        with_hot_pixel = stretch_to_8bit(pixels, StreamSettings())

        # Anchoring to the median and the MAD is why. A single dead pixel deciding
        # the scale would darken the entire sky.
        assert int(np.median(with_hot_pixel)) == pytest.approx(
            int(np.median(without)), abs=2
        )


class TestEncoding:
    def test_it_produces_a_jpeg(self):
        encoded = encode_frame(a_frame())

        assert encoded.payload[:2] == b"\xff\xd8"
        assert encoded.byte_length == len(encoded.payload)

    def test_it_scales_a_large_frame_down_to_the_configured_edge(self):
        encoded = encode_frame(a_frame(1920, 1080), StreamSettings(max_edge_px=800))

        assert max(encoded.width_px, encoded.height_px) == 800
        # Aspect ratio survives: 1920x1080 is 16:9 and so is 800x450.
        assert encoded.height_px == 450

    def test_it_leaves_a_frame_already_small_enough_alone(self):
        encoded = encode_frame(a_frame(320, 240), StreamSettings(max_edge_px=800))

        assert (encoded.width_px, encoded.height_px) == (320, 240)

    def test_settings_that_could_not_work_are_refused_on_construction(self):
        with pytest.raises(ValueError):
            StreamSettings(max_edge_px=0)
        with pytest.raises(ValueError):
            StreamSettings(quality=99)
        with pytest.raises(ValueError):
            StreamSettings(target_background=0.0)
        with pytest.raises(ValueError):
            StreamSettings(shadow_sigma=-1.0)


class TestTheHeader:
    def test_it_describes_the_image_sent_not_the_sensor_it_came_off(self):
        frame = a_frame(1920, 1080)
        encoded = encode_frame(frame, StreamSettings(max_edge_px=800))

        header = live_frame_header(MISSION, frame, encoded, sequence=7)

        # What the viewer has to allocate is the encoded size. Reporting the
        # sensor's would have every client rendering into the wrong buffer.
        assert header["widthPx"] == 800
        assert header["heightPx"] != 1080
        assert header["byteLength"] == len(encoded.payload)

    def test_it_carries_the_frame_s_own_provenance(self):
        frame = a_frame()

        header = live_frame_header(MISSION, frame, encode_frame(frame), sequence=0)

        # `CLAUDE.md`: simulator output is never presented as real telescope
        # output. The surest way to break that is to let anything other than the
        # frame decide what the frame is.
        assert header["mode"] == "SIMULATED"
        assert header["capturedAt"] == "2026-06-21T22:00:00Z"

    def test_it_is_the_shape_the_contract_declares(self):
        frame = a_frame()
        header = live_frame_header(MISSION, frame, encode_frame(frame), sequence=3)

        required = {
            "type",
            "messageId",
            "sentAt",
            "missionId",
            "sequence",
            "capturedAt",
            "encoding",
            "widthPx",
            "heightPx",
            "byteLength",
            "exposureMilliseconds",
            "gain",
            "mode",
        }
        assert required <= set(header)
        assert header["type"] == "AGENT_LIVE_FRAME"
        assert header["encoding"] == "JPEG"
        # It has to survive being JSON, which is how it reaches the wire.
        assert json.loads(json.dumps(header))["sequence"] == 3


class TestWhatReachesTheWire:
    def test_a_frame_goes_out_with_its_bytes(self):
        send = RecordingSend()
        view = LiveView(send=send, clock=ManualClock())

        assert view.offer(MISSION, a_frame()) is True
        header, payload = send.sent[0]
        assert header["missionId"] == MISSION
        assert payload[:2] == b"\xff\xd8"

    def test_frames_are_numbered_in_order(self):
        clock = ManualClock()
        send = RecordingSend()
        view = LiveView(send=send, clock=clock, min_interval_seconds=1.0)

        for _ in range(3):
            view.offer(MISSION, a_frame())
            clock.advance(1.0)

        assert [header["sequence"] for header, _ in send.sent] == [0, 1, 2]

    def test_a_frame_offered_too_soon_is_dropped(self):
        clock = ManualClock()
        send = RecordingSend()
        view = LiveView(send=send, clock=clock, min_interval_seconds=1.0)

        assert view.offer(MISSION, a_frame()) is True
        clock.advance(0.2)
        assert view.offer(MISSION, a_frame()) is False
        clock.advance(0.9)
        assert view.offer(MISSION, a_frame()) is True

        assert len(send.sent) == 2

    def test_a_dropped_frame_does_not_consume_a_sequence_number(self):
        clock = ManualClock()
        send = RecordingSend()
        view = LiveView(send=send, clock=clock, min_interval_seconds=1.0)

        view.offer(MISSION, a_frame())
        clock.advance(0.1)
        view.offer(MISSION, a_frame())
        clock.advance(1.0)
        view.offer(MISSION, a_frame())

        # A gap in the sequence would tell a viewer frames were lost in transit,
        # which is a different thing from never having been sent.
        assert [header["sequence"] for header, _ in send.sent] == [0, 1]

    def test_a_frame_with_no_mission_is_dropped(self):
        send = RecordingSend()
        view = LiveView(send=send, clock=ManualClock())

        # LiveFrameHeader.missionId is required, and nobody is watching a
        # telescope that is not running a mission for anyone.
        assert view.offer(None, a_frame()) is False
        assert send.sent == []

    def test_a_frame_is_dropped_rather_than_kept_when_the_link_is_down(self):
        clock = ManualClock()
        send = RecordingSend(online=False)
        view = LiveView(send=send, clock=clock, min_interval_seconds=1.0)

        assert view.offer(MISSION, a_frame()) is False

        # And the next frame is offered immediately rather than waiting out an
        # interval it never used. Nothing was queued: a live view that replays a
        # backlog after a reconnect shows the sky as it was.
        send.online = True
        assert view.offer(MISSION, a_frame()) is True
        assert send.sent[0][0]["sequence"] == 0
