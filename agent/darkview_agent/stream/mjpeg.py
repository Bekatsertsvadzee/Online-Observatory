"""The live view: one exposure, encoded for a browser.

Phase 1 is EAA. What the customer watches is a short exposure shown as it comes
off the sensor, not a long-exposure astrophotograph, and this module is the step
between the two: 16-bit linear sensor data in, JPEG bytes out.

The stretch is the part that matters. A linear 16-bit frame displayed as-is is
very nearly black -- the sky is a few hundred ADU and the stars are a handful of
pixels near full well, so a plain 16-to-8-bit shift throws away everything a
person came to see. So the frame is stretched before encoding, and this file is
where that decision lives rather than being scattered through the run loop.

None of the numbers below are measured. ADR-011 is explicit that frame rate,
resolution and JPEG quality are DV-032's to measure "against the real ASI585MC
and the real uplink", and that hardware does not exist yet. They are defaults
chosen to look right against `SimCamera`, they are all configurable, and the
qualification run replaces them. They are not safety values -- nothing here can
move a telescope -- so unlike MAX_ALT_SAFE a provisional value is allowed to
ship, but it must not be mistaken for a measurement.
"""

from __future__ import annotations

import io
import uuid
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from PIL import Image

from darkview_agent.clock import Clock, SystemClock, wire_timestamp
from darkview_agent.devices.frame import Frame

#: The long edge a live frame is scaled to before encoding.
#:
#: The ASI585MC is 3840x2160. Sending that at any useful rate is more bandwidth
#: than an observatory uplink should be assumed to have, and more resolution than
#: a live view in a browser window can show. PROVISIONAL -- see the module note.
DEFAULT_MAX_EDGE_PX = 1024

#: JPEG quality. High enough that stretching does not turn faint stars into
#: blocking artefacts, low enough to keep a frame small. PROVISIONAL.
#:
#: Sensor noise, not signal, is what a stretched frame mostly costs to encode --
#: a star field is high-frequency almost everywhere, which is the worst case for
#: JPEG. Measured against `SimCamera` at 1920x1080, one frame:
#:
#:     edge 1280 q82 -> 381 KB     edge 1024 q82 -> 223 KB     edge 800 q82 -> 123 KB
#:     edge 1280 q70 -> 293 KB     edge 1024 q70 -> 165 KB     edge 800 q70 ->  87 KB
#:
#: 1024 at 70 is about 165 KB, so roughly 1.3 Mbit/s at one frame a second. That
#: is a simulator measurement and not the real sensor, whose noise characteristics
#: decide this: DV-035 re-measures it at first light.
DEFAULT_QUALITY = 70

#: Where the sky background lands, as a fraction of full scale.
#:
#: The stretch is anchored to this rather than to a percentile of the pixel
#: values, which is what keeps a live view looking the same from frame to frame.
#: Dark, because the sky is dark and the brand is, but not black: a view that
#: clips its own noise floor reads as a dead sensor rather than as a night.
DEFAULT_TARGET_BACKGROUND = 0.20

#: How far below the median the black point sits, in robust standard deviations.
#:
#: MAD rather than the standard deviation, because a star field is not normally
#: distributed and a handful of bright stars would drag a plain sigma upwards. At
#: 2.8 the noise floor stays visible instead of being clipped to black.
DEFAULT_SHADOW_SIGMA = 2.8


@dataclass(frozen=True)
class StreamSettings:
    """How a frame is prepared for the wire. All provisional; see the module note."""

    max_edge_px: int = DEFAULT_MAX_EDGE_PX
    quality: int = DEFAULT_QUALITY
    target_background: float = DEFAULT_TARGET_BACKGROUND
    shadow_sigma: float = DEFAULT_SHADOW_SIGMA

    def __post_init__(self) -> None:
        if self.max_edge_px <= 0:
            raise ValueError("max_edge_px must be greater than zero")
        if not 1 <= self.quality <= 95:
            # Above 95 Pillow's JPEG output grows sharply for no visible gain.
            raise ValueError("quality must be between 1 and 95")
        if not 0.0 < self.target_background < 1.0:
            raise ValueError("target_background must be between 0 and 1")
        if self.shadow_sigma < 0:
            raise ValueError("shadow_sigma must not be negative")


@dataclass(frozen=True)
class EncodedFrame:
    """JPEG bytes and the shape they were encoded at."""

    payload: bytes
    width_px: int
    height_px: int

    @property
    def byte_length(self) -> int:
        return len(self.payload)


def _midtone_transfer(midtone: float, values: np.ndarray) -> np.ndarray:
    """The MTF curve: lifts the faint end hard, leaves the bright end alone."""
    return ((midtone - 1.0) * values) / (
        (2.0 * midtone - 1.0) * values - midtone
    )


def stretch_to_8bit(pixels: np.ndarray, settings: StreamSettings) -> np.ndarray:
    """Map a linear 16-bit frame onto the 0-255 a display can show.

    A midtone transfer function anchored to the frame's own median, which is the
    autostretch every EAA tool uses and the reason a live view looks the same from
    one frame to the next. The alternative -- scaling between two percentiles --
    was tried first and is not good enough: the percentiles move with the star
    field, so the same sky rendered at two sizes came out with backgrounds of 3
    and 32 out of 255, one of them a black rectangle.

    Anchoring the *median* instead fixes the background wherever the stars happen
    to fall. Measured against `SimCamera` at four frame sizes, the background
    lands on the target every time and the stars still reach the top of the range.

    A frame with no spread at all -- a closed shutter, a disconnected sensor --
    makes the shadow point meet full scale, and that returns flat black, which is
    what such a frame is.
    """
    values = pixels.astype(np.float32) / 65535.0

    median = float(np.median(values))
    # 1.4826 turns the median absolute deviation into a standard-deviation
    # equivalent for normally distributed noise, which the sky background is even
    # though the stars on top of it are not.
    deviation = float(np.median(np.abs(values - median))) * 1.4826

    shadows = min(max(median - settings.shadow_sigma * deviation, 0.0), 1.0)
    headroom = 1.0 - shadows
    if headroom <= 0.0:
        return np.zeros(pixels.shape, dtype=np.uint8)

    clipped = np.clip((values - shadows) / headroom, 0.0, 1.0)

    # Where the median sits once the shadows are clipped, and the midtone that
    # moves it to the target background. Solved rather than searched for:
    # MTF(m, x) = t rearranges to this.
    anchor = min(max((median - shadows) / headroom, 1e-6), 1.0 - 1e-6)
    target = settings.target_background
    midtone = (anchor * (1.0 - target)) / (anchor - 2.0 * target * anchor + target)
    midtone = min(max(midtone, 1e-6), 1.0 - 1e-6)

    return np.clip(_midtone_transfer(midtone, clipped) * 255.0, 0.0, 255.0).astype(
        np.uint8
    )


def encode_frame(frame: Frame, settings: StreamSettings | None = None) -> EncodedFrame:
    """One exposure as JPEG bytes, stretched and scaled down."""
    resolved = settings or StreamSettings()

    # No `mode=`: Pillow infers "L" from a 2-D uint8 array, and passing it is
    # deprecated in 11 and removed in 13.
    image = Image.fromarray(stretch_to_8bit(frame.pixels, resolved))

    longest = max(image.width, image.height)
    if longest > resolved.max_edge_px:
        ratio = resolved.max_edge_px / longest
        # Scaling down a stretched star field: LANCZOS keeps point sources looking
        # like point sources instead of smearing them into the background.
        image = image.resize(
            (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
            Image.LANCZOS,
        )

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=resolved.quality, optimize=True)

    return EncodedFrame(
        payload=buffer.getvalue(),
        width_px=image.width,
        height_px=image.height,
    )


#: The shortest gap between two frames on the wire.
#:
#: A rate cap, not a schedule. The camera decides how often a frame exists -- a
#: two-second exposure produces one every two seconds and this never sees a
#: reason to act -- and this only stops a short exposure from filling the uplink.
#: PROVISIONAL, like everything else here: the real figure is whatever the
#: observatory's upstream bandwidth turns out to be, measured at DV-035.
DEFAULT_MIN_INTERVAL_SECONDS = 1.0


class LiveView:
    """Turns frames into `AGENT_LIVE_FRAME` messages, at a bounded rate.

    Encoding costs real CPU on a mini-PC that is also running a mission, so the
    rate cap is checked *before* the encode rather than after: a frame that will
    not be sent is never encoded.

    A dropped frame is not an error and is not logged at anything above debug.
    Dropping is how a live view stays live -- ADR-011 puts the same rule on the
    cloud, which keeps only the latest frame per mission. What must never happen
    is the opposite: a queue of stale frames arriving late and showing a customer
    the sky as it was while they nudge a telescope in real time.
    """

    def __init__(
        self,
        send: Callable[[dict, bytes], bool],
        clock: Clock | None = None,
        settings: StreamSettings | None = None,
        min_interval_seconds: float = DEFAULT_MIN_INTERVAL_SECONDS,
    ) -> None:
        self._send = send
        self._clock = clock or SystemClock()
        self._settings = settings or StreamSettings()
        self._min_interval_seconds = min_interval_seconds
        self._sequence = 0
        self._last_sent_at: float | None = None

    @property
    def sequence(self) -> int:
        """How many frames have gone out. The next one carries this number."""
        return self._sequence

    def offer(self, mission_id: str | None, frame: Frame) -> bool:
        """Offer one frame to the live view. Returns whether it went out.

        A frame with no mission is dropped: `LiveFrameHeader.missionId` is
        required, and there is nobody watching a telescope that is not running a
        mission for anyone.
        """
        if mission_id is None:
            return False

        now = self._clock.monotonic()
        if (
            self._last_sent_at is not None
            and now - self._last_sent_at < self._min_interval_seconds
        ):
            return False

        encoded = encode_frame(frame, self._settings)
        header = live_frame_header(mission_id, frame, encoded, self._sequence)

        if not self._send(header, encoded.payload):
            # The link is down. Not an error here: the session says so, and the
            # next frame is a second away.
            return False

        self._sequence += 1
        self._last_sent_at = now
        return True


def live_frame_header(
    mission_id: str, frame: Frame, encoded: EncodedFrame, sequence: int
) -> dict:
    """The contract's LiveFrameHeader for one encoded frame.

    `widthPx` and `heightPx` describe the **encoded** image, not the sensor: they
    are what the viewer has to allocate, and the frame was scaled down on the way
    here. `mode` comes off the frame rather than from configuration, because a
    frame carries its own provenance -- `CLAUDE.md` is explicit that simulator
    output is never presented as real telescope output, and the surest way to
    break that is to let something other than the frame decide what it is.
    """
    return {
        "type": "AGENT_LIVE_FRAME",
        "messageId": str(uuid.uuid4()),
        "sentAt": wire_timestamp(),
        "missionId": mission_id,
        "sequence": sequence,
        "capturedAt": wire_timestamp(frame.captured_at),
        "encoding": "JPEG",
        "widthPx": encoded.width_px,
        "heightPx": encoded.height_px,
        "byteLength": encoded.byte_length,
        "exposureMilliseconds": frame.exposure_milliseconds,
        "gain": frame.gain,
        "mode": frame.mode.value,
        "stackedFrames": frame.stacked_frames,
    }
