"""`AstapSolver` -- plate solving with the ASTAP command-line solver (DV-030).

The frame is written as a FITS file to a private temporary directory, ASTAP is
run on it as a child process with a hint and a timeout, and the `.ini` it writes
beside the image is read for the answer. Nothing is sent anywhere and nothing
listens: ASTAP is a local program solving against a star database on local disk.

Written against ASTAP's documented command line (https://www.hnsky.org/astap.htm,
"Command line"), and not yet run against the ASTAP build and star database on the
observatory mini-PC. That happens at first light, DV-035.

**FITS is written here, not by a library.** A primary HDU holding one 16-bit
image is an 80-character header in 2880-byte blocks followed by big-endian
samples (FITS Standard 4.0, sections 3-5). Taking astropy for that one write would
bring a large scientific stack into an agent that otherwise needs none of it.
Unsigned 16-bit is stored the standard way: BITPIX 16 with BZERO 32768.

**The solve blocks the caller.** The mission runner calls `solve` inside the
supervisor's pass, and the link's heartbeat waits for that pass. The timeout is
kept well under the watchdog's heartbeat-loss limit so a stuck ASTAP cannot look
like a dead link. Moving the solve off the pass is a runner change, not this one.
"""

from __future__ import annotations

import logging
import math
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from darkview_agent.devices.frame import Frame
from darkview_agent.mission.solver import PlateSolver, SolveResult

logger = logging.getLogger("darkview.agent.astap")

#: Under the watchdog's 15 s heartbeat-loss fallback, with room for the exposure
#: and the pass around it.
DEFAULT_TIMEOUT_SECONDS = 10.0

#: How far from the hint ASTAP searches. A mount whose GOTO is off by more than
#: this has a pointing problem a plate solve should not paper over.
DEFAULT_SEARCH_RADIUS_DEGREES = 5.0

FITS_BLOCK = 2880
FITS_CARD = 80


def fits_bytes(frame: Frame) -> bytes:
    cards = [
        _card("SIMPLE", "T"),
        _card("BITPIX", "16"),
        _card("NAXIS", "2"),
        _card("NAXIS1", str(frame.width_px)),
        _card("NAXIS2", str(frame.height_px)),
        _card("BZERO", "32768"),
        _card("BSCALE", "1"),
        _card("EXPTIME", repr(frame.exposure_milliseconds / 1000.0)),
        _card("GAIN", str(frame.gain)),
        _card("DATE-OBS", f"'{frame.captured_at.strftime('%Y-%m-%dT%H:%M:%S.%f')}'"),
        "END".ljust(FITS_CARD),
    ]
    header = "".join(cards).encode("ascii")
    header += b" " * (-len(header) % FITS_BLOCK)

    signed = (frame.pixels.astype(np.int32) - 32768).astype(">i2")
    data = signed.tobytes()
    data += b"\0" * (-len(data) % FITS_BLOCK)
    return header + data


def _card(keyword: str, value: str) -> str:
    """Fixed format: a string starts in column 11, anything else ends in column 30."""
    aligned = value if value.startswith("'") else f"{value:>20}"
    return f"{keyword:<8}= {aligned}".ljust(FITS_CARD)


def read_solution(ini: Path) -> SolveResult | None:
    """`PLTSOLVD=T` with a centre in CRVAL1 (RA, degrees) and CRVAL2 (Dec, degrees)."""
    values: dict[str, str] = {}
    for line in ini.read_text(encoding="utf-8", errors="replace").splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key.strip().upper()] = value.strip()

    if values.get("PLTSOLVD") != "T":
        return None
    try:
        right_ascension = float(values["CRVAL1"])
        declination = float(values["CRVAL2"])
    except (KeyError, ValueError):
        logger.error("ASTAP reported a solve with no readable centre")
        return None
    if not (
        math.isfinite(right_ascension)
        and math.isfinite(declination)
        and 0.0 <= right_ascension < 360.0
        and -90.0 <= declination <= 90.0
    ):
        logger.error(
            "ASTAP reported a centre outside the sky: %s, %s", right_ascension, declination
        )
        return None
    return SolveResult(
        right_ascension_hours=right_ascension / 15.0, declination_degrees=declination
    )


class AstapSolver(PlateSolver):
    def __init__(
        self,
        executable: Path,
        field_height_degrees: float,
        *,
        search_radius_degrees: float = DEFAULT_SEARCH_RADIUS_DEGREES,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if field_height_degrees <= 0:
            raise ValueError("field_height_degrees must be greater than zero")
        self._executable = executable
        self._field_height = field_height_degrees
        self._search_radius = search_radius_degrees
        self._timeout = timeout_seconds
        self._hint: tuple[float, float] | None = None

    def set_commanded_position(self, ra_hours: float, dec_degrees: float) -> None:
        """Where the mount was sent. ASTAP searches around it instead of the whole sky."""
        self._hint = (ra_hours, dec_degrees)

    def command(self, image: Path) -> list[str]:
        arguments = [
            str(self._executable),
            "-f",
            str(image),
            "-fov",
            f"{self._field_height:.4f}",
        ]
        if self._hint is not None:
            ra_hours, dec_degrees = self._hint
            arguments += [
                "-ra",
                f"{ra_hours:.6f}",
                # ASTAP takes the declination as south polar distance.
                "-spd",
                f"{dec_degrees + 90.0:.6f}",
                "-r",
                f"{self._search_radius:.2f}",
            ]
        return arguments

    def solve(self, frame: Frame) -> SolveResult | None:
        """None for every way a solve does not produce a position.

        A failed solve is a normal outcome the runner retries, so nothing here
        raises for one: not a sparse field, not a timeout, not a missing binary.
        Each is logged with its cause, because "the solve failed" three times over
        explains nothing to the operator reading why a mission ended.
        """
        with tempfile.TemporaryDirectory(prefix="darkview-solve-") as directory:
            image = Path(directory) / "frame.fits"
            image.write_bytes(fits_bytes(frame))
            try:
                completed = subprocess.run(
                    self.command(image),
                    capture_output=True,
                    timeout=self._timeout,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                logger.warning("ASTAP did not finish within %.0fs", self._timeout)
                return None
            except OSError as error:
                logger.error("ASTAP could not be started: %s", error)
                return None

            ini = image.with_suffix(".ini")
            if completed.returncode != 0 or not ini.is_file():
                logger.warning(
                    "ASTAP did not solve the frame (exit %s): %s",
                    completed.returncode,
                    completed.stdout.decode("utf-8", errors="replace").strip()[-200:],
                )
                return None
            return read_solution(ini)
