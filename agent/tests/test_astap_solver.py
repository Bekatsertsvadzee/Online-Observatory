"""DV-030: `AstapSolver` against a stand-in ASTAP.

No ASTAP binary or star database is available in CI, and none is needed to prove
what this code owns: the FITS it hands over is valid, the command line carries the
hint in ASTAP's units, the answer is read from the `.ini` ASTAP writes, and every
way a solve can fail comes back as None rather than an exception. The stand-in is
a real executable run as a real child process; what it cannot prove -- that ASTAP
solves a real frame -- is DV-035's, at first light.
"""

from __future__ import annotations

import json
import stat
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest

from contracts.models import ObservatoryMode
from darkview_agent.devices.frame import Frame
from darkview_agent.solve.astap import (
    FITS_BLOCK,
    AstapSolver,
    fits_bytes,
    read_solution,
)

STAND_IN = r"""
import json, sys, time
from pathlib import Path

arguments = sys.argv[1:]
options = dict(zip(arguments[0::2], arguments[1::2]))
behaviour = json.loads(Path(__file__).with_suffix(".json").read_text())
Path(__file__).with_suffix(".args").write_text(json.dumps(arguments))

image = Path(options["-f"])
header = image.read_bytes()[:2880].decode("ascii")
cards = {header[i:i + 8].strip(): header[i + 10:i + 80].strip() for i in range(0, 2880, 80)}
assert cards["SIMPLE"] == "T" and cards["BITPIX"] == "16", cards

time.sleep(behaviour.get("sleep", 0))
if behaviour.get("ini") is not None:
    image.with_suffix(".ini").write_text(behaviour["ini"])
sys.exit(behaviour.get("exit", 0))
"""


def _frame(width: int = 64, height: int = 48) -> Frame:
    pixels = np.arange(width * height, dtype=np.uint32).reshape(height, width) * 20
    return Frame(
        pixels=(pixels % 65536).astype(np.uint16),
        exposure_milliseconds=2000.0,
        gain=180,
        captured_at=datetime(2026, 9, 17, 20, 15, 30, tzinfo=UTC),
        mode=ObservatoryMode.simulated,
    )


@pytest.fixture
def astap(tmp_path):
    """Returns (executable, configure). `configure` sets how the next run behaves."""
    script = tmp_path / "astap.py"
    script.write_text(STAND_IN, encoding="utf-8")
    executable = tmp_path / "astap"
    executable.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
    executable.chmod(executable.stat().st_mode | stat.S_IEXEC)

    def configure(**behaviour) -> None:
        script.with_suffix(".json").write_text(json.dumps(behaviour))

    def arguments() -> list[str]:
        return json.loads(script.with_suffix(".args").read_text())

    configure(ini=None, exit=1)
    return executable, configure, arguments


SOLVED_INI = "PLTSOLVD=T\nCRVAL1=83.8221\nCRVAL2=-5.3911\nCDELT1=0.00011\nWARNING=\n"


# --------------------------------------------------------------------------
# FITS
# --------------------------------------------------------------------------


def test_the_fits_file_is_whole_blocks_with_a_parseable_header():
    frame = _frame()
    written = fits_bytes(frame)

    assert len(written) % FITS_BLOCK == 0
    header = written[:FITS_BLOCK].decode("ascii")
    cards = [header[i : i + 80] for i in range(0, FITS_BLOCK, 80)]
    assert cards[0].startswith("SIMPLE  =                    T")
    assert cards[1][:8] == "BITPIX  " and cards[1][10:30].strip() == "16"
    assert any(card.startswith("NAXIS1  =                   64") for card in cards)
    assert any(card.startswith("NAXIS2  =                   48") for card in cards)
    assert any(card.startswith("DATE-OBS= '2026-09-17T20:15:30") for card in cards)
    assert any(card.rstrip() == "END" for card in cards)


def test_the_samples_round_trip_through_bzero():
    """Unsigned 16-bit stored as signed with BZERO 32768, big-endian, row for row."""
    frame = _frame()
    written = fits_bytes(frame)

    samples = np.frombuffer(
        written[FITS_BLOCK : FITS_BLOCK + frame.width_px * frame.height_px * 2], dtype=">i2"
    )
    restored = (samples.astype(np.int32) + 32768).astype(np.uint16)
    np.testing.assert_array_equal(restored.reshape(frame.pixels.shape), frame.pixels)


def test_the_extremes_of_the_sensor_range_survive():
    pixels = np.array([[0, 65535], [32768, 1]], dtype=np.uint16)
    frame = Frame(
        pixels=pixels,
        exposure_milliseconds=1.0,
        gain=0,
        captured_at=datetime(2026, 9, 17, tzinfo=UTC),
        mode=ObservatoryMode.simulated,
    )
    samples = np.frombuffer(fits_bytes(frame)[FITS_BLOCK : FITS_BLOCK + 8], dtype=">i2")
    assert (samples.astype(np.int32) + 32768).tolist() == [0, 65535, 32768, 1]


# --------------------------------------------------------------------------
# Reading the answer
# --------------------------------------------------------------------------


def test_a_solved_ini_gives_the_centre_in_hours_and_degrees(tmp_path):
    ini = tmp_path / "frame.ini"
    ini.write_text(SOLVED_INI)

    result = read_solution(ini)

    assert result is not None
    assert result.right_ascension_hours == pytest.approx(83.8221 / 15.0)
    assert result.declination_degrees == pytest.approx(-5.3911)


@pytest.mark.parametrize(
    "ini",
    [
        # An unsolved frame can still carry the hint's centre; it is not an answer.
        "PLTSOLVD=F\nCRVAL1=83.8\nCRVAL2=-5.4\nERROR=Not enough stars\n",
        "PLTSOLVD=T\nCRVAL2=-5.0\n",
        "PLTSOLVD=T\nCRVAL1=nan\nCRVAL2=-5.0\n",
        "PLTSOLVD=T\nCRVAL1=361.0\nCRVAL2=-5.0\n",
        "PLTSOLVD=T\nCRVAL1=10.0\nCRVAL2=95.0\n",
        "",
    ],
    ids=["not-solved", "no-ra", "nan", "ra-past-360", "dec-past-pole", "empty"],
)
def test_anything_short_of_a_usable_centre_is_no_solution(tmp_path, ini):
    path = tmp_path / "frame.ini"
    path.write_text(ini)
    assert read_solution(path) is None


# --------------------------------------------------------------------------
# Running ASTAP
# --------------------------------------------------------------------------


def test_a_solve_runs_astap_and_returns_its_answer(astap):
    executable, configure, _ = astap
    configure(ini=SOLVED_INI, exit=0)

    result = AstapSolver(executable, field_height_degrees=0.24).solve(_frame())

    assert result is not None
    assert result.declination_degrees == pytest.approx(-5.3911)


def test_the_hint_is_passed_in_astaps_units(astap):
    executable, configure, arguments = astap
    configure(ini=SOLVED_INI, exit=0)
    solver = AstapSolver(executable, field_height_degrees=0.2394, search_radius_degrees=3.0)

    solver.set_commanded_position(5.5881, -5.3911)
    solver.solve(_frame())

    options = dict(zip(arguments()[0::2], arguments()[1::2], strict=True))
    assert float(options["-ra"]) == pytest.approx(5.5881)
    assert float(options["-spd"]) == pytest.approx(84.6089)
    assert float(options["-r"]) == pytest.approx(3.0)
    assert float(options["-fov"]) == pytest.approx(0.2394)


def test_without_a_hint_no_position_is_invented(astap):
    executable, configure, arguments = astap
    configure(ini=SOLVED_INI, exit=0)

    AstapSolver(executable, field_height_degrees=0.24).solve(_frame())

    assert "-ra" not in arguments() and "-spd" not in arguments()


def test_a_failed_solve_is_none(astap):
    executable, configure, _ = astap
    configure(ini="PLTSOLVD=F\n", exit=1)
    assert AstapSolver(executable, field_height_degrees=0.24).solve(_frame()) is None


def test_a_failing_exit_is_believed_over_the_ini(astap):
    executable, configure, _ = astap
    configure(ini=SOLVED_INI, exit=1)
    assert AstapSolver(executable, field_height_degrees=0.24).solve(_frame()) is None


def test_a_zero_exit_with_no_ini_is_none(astap):
    executable, configure, _ = astap
    configure(ini=None, exit=0)
    assert AstapSolver(executable, field_height_degrees=0.24).solve(_frame()) is None


def test_a_solve_that_overruns_its_timeout_is_none(astap):
    executable, configure, _ = astap
    configure(ini=SOLVED_INI, exit=0, sleep=5)
    solver = AstapSolver(executable, field_height_degrees=0.24, timeout_seconds=0.5)
    assert solver.solve(_frame()) is None


def test_a_missing_executable_is_none_not_an_exception(tmp_path):
    solver = AstapSolver(tmp_path / "not-installed", field_height_degrees=0.24)
    assert solver.solve(_frame()) is None


def test_the_frame_is_not_left_on_disk(astap):
    executable, configure, arguments = astap
    configure(ini=SOLVED_INI, exit=0)

    AstapSolver(executable, field_height_degrees=0.24).solve(_frame())

    image = Path(dict(zip(arguments()[0::2], arguments()[1::2], strict=True))["-f"])
    assert not image.parent.exists()


def test_a_field_height_that_is_not_positive_is_refused(tmp_path):
    with pytest.raises(ValueError):
        AstapSolver(tmp_path / "astap", field_height_degrees=0.0)
