"""Guard: no default value for MAX_ALT_SAFE may exist anywhere in this repository.

Acceptance criterion 5 of DV-020.

MAX_ALT_SAFE is the altitude at which the rear of the camera train loses clearance
against the fork base. It is measured from the assembled optical train during mount
qualification (test Q7). A default value is not a convenience — it is a number that
looks measured, and a mount that trusts it drives the camera into the fork.

Earlier planning material printed 72 degrees in a table cell marked "provisional".
This test exists so that value, or any other, cannot quietly become real.
"""

from __future__ import annotations

import re
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

SEARCHED_SUFFIXES = {".py", ".ts", ".tsx", ".mjs", ".json", ".yaml", ".yml", ".sql", ".prisma"}

SKIPPED_DIRECTORIES = {
    ".git",
    ".next",
    ".venv",
    "node_modules",
    "__pycache__",
}

# A numeric literal assigned to the field, in any language we use.
#   max_altitude_degrees = 72        max_altitude_degrees: float = 72
#   maxAltitudeDegrees: 72           "maxAltitudeDegrees": 72
#   MAX_ALT_SAFE = 72
FORBIDDEN_PATTERNS = (
    re.compile(r"max_altitude_degrees\s*(?::[^=\n]+)?=\s*[-+]?\d"),
    re.compile(r"['\"]?maxAltitudeDegrees['\"]?\s*[:=]\s*[-+]?\d"),
    re.compile(r"MAX_ALT_SAFE\s*[:=]\s*[-+]?\d"),
)


def searched_files() -> list[Path]:
    found: list[Path] = []
    for path in REPOSITORY_ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in SEARCHED_SUFFIXES:
            continue
        if SKIPPED_DIRECTORIES & set(path.parts):
            continue
        if path == Path(__file__):
            continue
        found.append(path)
    return found


def test_the_guard_actually_scans_something():
    """A guard that searches nothing passes for the wrong reason."""
    files = searched_files()
    assert len(files) > 50, f"expected to scan the repository, only found {len(files)} files"
    assert any(path.suffix == ".py" for path in files)
    assert any(path.name == "openapi.yaml" for path in files)


def test_the_guard_detects_a_default_when_one_is_present():
    """Prove the patterns work, so a passing run means something."""
    for sample in (
        "max_altitude_degrees = 72",
        "max_altitude_degrees: float = 72.0",
        "maxAltitudeDegrees: 72",
        '"maxAltitudeDegrees": 68.5',
        "MAX_ALT_SAFE = 72",
    ):
        assert any(pattern.search(sample) for pattern in FORBIDDEN_PATTERNS), sample


def test_no_default_max_altitude_anywhere_in_the_repository():
    offences: list[str] = []

    for path in searched_files():
        try:
            contents = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(contents.splitlines(), start=1):
            for pattern in FORBIDDEN_PATTERNS:
                if pattern.search(line):
                    relative = path.relative_to(REPOSITORY_ROOT)
                    offences.append(f"{relative}:{number}: {line.strip()}")

    assert not offences, (
        "A default value for MAX_ALT_SAFE was introduced. It is measured from the "
        "physical optical train, never defaulted:\n  " + "\n  ".join(offences)
    )


def test_the_contract_declares_no_default_for_max_altitude():
    """The schema itself must carry no `default:` key for this field."""
    specification = (REPOSITORY_ROOT / "contracts" / "openapi.yaml").read_text(encoding="utf-8")
    lines = specification.splitlines()

    start = next(
        index for index, line in enumerate(lines) if line.strip() == "maxAltitudeDegrees:"
    )
    indent = len(lines[start]) - len(lines[start].lstrip())

    for line in lines[start + 1 :]:
        if line.strip() and (len(line) - len(line.lstrip())) <= indent:
            break
        assert not line.strip().startswith("default:"), (
            "contracts/openapi.yaml gives maxAltitudeDegrees a default. "
            "It is nullable on purpose: null means UNMEASURED."
        )
