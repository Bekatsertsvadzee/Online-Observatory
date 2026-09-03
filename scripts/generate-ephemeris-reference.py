"""Generate the independent ephemeris reference used by the cloud's tests.

DV-053 criteria 3 and 4 require the cloud's altitude, azimuth and Sun geometry to
be checked against an independent source. This is that source: the Observatory
Agent's own implementation, which is a different algorithm (NOAA/Meeus, written
by hand) in a different language from the cloud's astronomy-engine.

Two implementations that agree are evidence. One implementation used twice is not,
which is why the cloud does not simply import the agent's numbers.

Run from the repository root:
    agent/.venv/bin/python scripts/generate-ephemeris-reference.py
"""

from __future__ import annotations

import json
import pathlib
import sys
from datetime import UTC, datetime

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "agent"))

from darkview_agent.safety.coordinates import equatorial_to_horizontal  # noqa: E402
from darkview_agent.safety.sun import SiteLocation, position  # noqa: E402

# The Tbilisi installation site (ADR-005).
SITE = SiteLocation(latitude_degrees=41.7151, longitude_degrees=44.8271)

# Three catalogue targets, chosen to span the sky: one high northern, one
# southern, one circumpolar-ish.
TARGETS = [
    {"slug": "m13-hercules-cluster", "ra": 16.6948, "dec": 36.4599},
    {"slug": "m42-orion-nebula", "ra": 5.5881, "dec": -5.3911},
    {"slug": "albireo", "ra": 19.512, "dec": 27.9597},
]

# Three instants across different seasons and times of night.
MOMENTS = [
    "2026-09-03T20:00:00+00:00",
    "2026-12-21T22:00:00+00:00",
    "2027-03-15T02:00:00+00:00",
]


def main() -> None:
    samples = []
    for iso in MOMENTS:
        moment = datetime.fromisoformat(iso).astimezone(UTC)
        sun = position(moment, SITE)

        samples.append(
            {
                "at": iso,
                "sun": {
                    "altitudeDegrees": sun.altitude_degrees,
                    "azimuthDegrees": sun.azimuth_degrees,
                },
                "targets": [
                    {
                        "slug": target["slug"],
                        "raHours": target["ra"],
                        "decDegrees": target["dec"],
                        "altitudeDegrees": (
                            horizontal := equatorial_to_horizontal(
                                target["ra"], target["dec"], moment, SITE
                            )
                        ).altitude_degrees,
                        "azimuthDegrees": horizontal.azimuth_degrees,
                    }
                    for target in TARGETS
                ],
            }
        )

    output = {
        "source": "darkview_agent.safety -- NOAA/Meeus, independent of astronomy-engine",
        "generatedBy": "scripts/generate-ephemeris-reference.py",
        "site": {
            "latitudeDegrees": SITE.latitude_degrees,
            "longitudeDegrees": SITE.longitude_degrees,
        },
        "note": (
            "Altitudes are airless: the agent applies no refraction correction, "
            "and the cloud matches that convention for the Sun."
        ),
        "samples": samples,
    }

    destination = (
        pathlib.Path(__file__).resolve().parents[1]
        / "apps/api/src/lib/ephemeris/agent-reference.json"
    )
    destination.write_text(json.dumps(output, indent=2) + "\n")
    print(f"wrote {destination.relative_to(pathlib.Path.cwd())}")


if __name__ == "__main__":
    main()
