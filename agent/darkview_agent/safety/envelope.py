"""The safety envelope — the numbers that stop the telescope destroying itself.

Every function here is pure: same inputs, same output, no I/O, and no clock read.
Time is always passed in. That is not stylistic. These are the rules that decide
whether a telescope is allowed to move, so they must be exhaustively testable,
and a function that reads the clock cannot be tested at a boundary.

No command reaches a device without passing through here. The cloud validates
first; this validates again, independently, and a cloud-approved command that
fails here is refused here.

`SafetyEnvelopeConfig`, `HorizonMaskEntry`, `AzimuthSector` and
`CommandRejectionReason` are imported from the generated contract models and are
never redefined.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from contracts.models import CommandRejectionReason, SafetyEnvelopeConfig
from darkview_agent.safety import sun
from darkview_agent.safety.sun import SiteLocation


@dataclass(frozen=True)
class Verdict:
    """The envelope's answer. A refusal always names a contract reason."""

    permitted: bool
    reason: CommandRejectionReason | None = None
    detail: str = ""

    def __post_init__(self) -> None:
        if self.permitted and self.reason is not None:
            raise ValueError("a permitted verdict cannot carry a rejection reason")
        if not self.permitted and self.reason is None:
            raise ValueError("a refusal must name a rejection reason")


PERMITTED = Verdict(permitted=True)


def _refuse(reason: CommandRejectionReason, detail: str) -> Verdict:
    return Verdict(permitted=False, reason=reason, detail=detail)


def is_measured(config: SafetyEnvelopeConfig | None) -> bool:
    """True only when MAX_ALT_SAFE has been physically measured.

    A missing config and a config with `max_altitude_degrees is None` are both
    UNMEASURED. There is no third state and no default value.
    """
    return config is not None and config.max_altitude_degrees is not None


def normalise_azimuth(azimuth_degrees: float) -> float:
    """Wrap a bearing into 0..360."""
    return azimuth_degrees % 360.0


def azimuth_in_sector(azimuth_degrees: float, from_degrees: float, to_degrees: float) -> bool:
    """Inclusive start, exclusive end, clockwise from north.

    Handles a sector that wraps through north, such as 350..10, which a naive
    `from <= a < to` comparison gets exactly backwards.
    """
    azimuth = normalise_azimuth(azimuth_degrees)
    start = normalise_azimuth(from_degrees)
    end = normalise_azimuth(to_degrees)

    if start == end:
        return False
    if start < end:
        return start <= azimuth < end
    return azimuth >= start or azimuth < end


def horizon_minimum_altitude(
    azimuth_degrees: float, mask: list  # list[HorizonMaskEntry]
) -> float | None:
    """The surveyed minimum altitude at this bearing.

    The compass survey samples bearings; between samples the horizon is
    interpolated linearly, wrapping across north. Returns None when no survey
    exists, in which case the mask imposes no constraint and the minimum
    altitude alone applies.
    """
    if not mask:
        return None

    azimuth = normalise_azimuth(azimuth_degrees)
    entries = sorted(mask, key=lambda entry: normalise_azimuth(entry.azimuth_degrees))

    if len(entries) == 1:
        return float(entries[0].min_altitude_degrees)

    for index, entry in enumerate(entries):
        entry_azimuth = normalise_azimuth(entry.azimuth_degrees)
        if entry_azimuth == azimuth:
            return float(entry.min_altitude_degrees)
        if entry_azimuth > azimuth:
            previous = entries[index - 1]
            previous_azimuth = normalise_azimuth(previous.azimuth_degrees)
            if index == 0:
                # Before the first sample: interpolate from the last, across north.
                previous = entries[-1]
                previous_azimuth = normalise_azimuth(previous.azimuth_degrees) - 360.0
            span = entry_azimuth - previous_azimuth
            fraction = 0.0 if span == 0 else (azimuth - previous_azimuth) / span
            return float(
                previous.min_altitude_degrees
                + (entry.min_altitude_degrees - previous.min_altitude_degrees) * fraction
            )

    # Past the last sample: interpolate to the first, across north.
    last, first = entries[-1], entries[0]
    last_azimuth = normalise_azimuth(last.azimuth_degrees)
    first_azimuth = normalise_azimuth(first.azimuth_degrees) + 360.0
    span = first_azimuth - last_azimuth
    fraction = 0.0 if span == 0 else (azimuth - last_azimuth) / span
    return float(
        last.min_altitude_degrees
        + (first.min_altitude_degrees - last.min_altitude_degrees) * fraction
    )


def evaluate_pointing(
    config: SafetyEnvelopeConfig | None,
    site: SiteLocation | None,
    at_time: datetime,
    altitude_degrees: float,
    azimuth_degrees: float,
    operator_override: bool = False,
) -> Verdict:
    """Decide whether the telescope may point here, at this instant.

    Checks run most-fundamental first, so the reason returned is the most
    important thing wrong rather than whichever rule happened to be tested last.

    `operator_override` permits attended terrestrial testing during daylight. It
    has no effect on the Sun exclusion, which cannot be disabled, bypassed or
    widened by any flag, override or configuration value.
    """
    # 1. Unmeasured beats everything. Without a measured MAX_ALT_SAFE nothing moves.
    if not is_measured(config):
        return _refuse(
            CommandRejectionReason.safety_envelope_unmeasured,
            "MAX_ALT_SAFE is UNMEASURED. It is measured from the physical optical "
            "train during mount qualification, never guessed and never defaulted.",
        )
    assert config is not None and config.max_altitude_degrees is not None

    # 2. Where we are must be known before the Sun can be computed. Fail closed:
    #    an unknown site cannot prove the pointing is clear of the Sun.
    if site is None:
        return _refuse(
            CommandRejectionReason.safety_sun_exclusion,
            "Observatory coordinates are not configured, so the Sun's position "
            "cannot be computed. Sun avoidance is never assumed.",
        )

    solar = sun.position(at_time, site)

    # 3. Sun exclusion. Not overridable, by anything, ever.
    separation = sun.angular_separation(
        altitude_degrees, azimuth_degrees, solar.altitude_degrees, solar.azimuth_degrees
    )
    if separation < config.sun_exclusion_degrees:
        return _refuse(
            CommandRejectionReason.safety_sun_exclusion,
            f"Pointing is {separation:.2f} degrees from the Sun; the exclusion is "
            f"{config.sun_exclusion_degrees:.2f} degrees. This cannot be overridden.",
        )

    # 4. Daylight lock. Overridable for attended terrestrial testing, and even
    #    then the Sun exclusion above has already been enforced.
    if (
        solar.altitude_degrees > config.daylight_lock_sun_altitude_degrees
        and not operator_override
    ):
        return _refuse(
            CommandRejectionReason.safety_daylight_lock,
            f"The Sun is at {solar.altitude_degrees:.2f} degrees altitude; the "
            f"daylight lock is {config.daylight_lock_sun_altitude_degrees:.2f}.",
        )

    # 5. Altitude limits.
    if altitude_degrees < config.min_altitude_degrees:
        return _refuse(
            CommandRejectionReason.safety_below_min_altitude,
            f"Altitude {altitude_degrees:.2f} is below the minimum "
            f"{config.min_altitude_degrees:.2f}.",
        )
    if altitude_degrees > config.max_altitude_degrees:
        return _refuse(
            CommandRejectionReason.safety_above_max_altitude,
            f"Altitude {altitude_degrees:.2f} is above the measured MAX_ALT_SAFE "
            f"{config.max_altitude_degrees:.2f}.",
        )

    # 6. Horizon mask from the compass survey.
    surveyed_minimum = horizon_minimum_altitude(azimuth_degrees, config.horizon_mask)
    if surveyed_minimum is not None and altitude_degrees < surveyed_minimum:
        return _refuse(
            CommandRejectionReason.safety_horizon_mask,
            f"Altitude {altitude_degrees:.2f} at bearing "
            f"{normalise_azimuth(azimuth_degrees):.2f} is below the surveyed horizon "
            f"{surveyed_minimum:.2f}.",
        )

    # 7. Cable-wrap exclusion sectors.
    for sector in config.forbidden_azimuth_sectors:
        if azimuth_in_sector(azimuth_degrees, sector.from_degrees, sector.to_degrees):
            return _refuse(
                CommandRejectionReason.safety_forbidden_azimuth,
                f"Bearing {normalise_azimuth(azimuth_degrees):.2f} is inside the "
                f"forbidden sector {sector.from_degrees:.2f}..{sector.to_degrees:.2f}.",
            )

    return PERMITTED


def evaluate_nudge(
    config: SafetyEnvelopeConfig | None,
    cumulative_offset_degrees: float,
    requested_step_degrees: float,
) -> Verdict:
    """Decide whether a customer nudge is within bounds.

    A nudge is a discrete bounded step. No continuous slew is ever exposed to a
    customer, so there is no rate to police here beyond the step size itself.
    """
    if not is_measured(config):
        return _refuse(
            CommandRejectionReason.safety_envelope_unmeasured,
            "MAX_ALT_SAFE is UNMEASURED; no motion is permitted.",
        )
    assert config is not None

    if requested_step_degrees < 0:
        return _refuse(
            CommandRejectionReason.safety_nudge_limit_exceeded,
            "A nudge step must not be negative; direction is carried separately.",
        )

    if requested_step_degrees > config.nudge_rate_degrees_per_second:
        return _refuse(
            CommandRejectionReason.safety_slew_rate,
            f"Nudge step {requested_step_degrees:.4f} exceeds the permitted step "
            f"{config.nudge_rate_degrees_per_second:.4f}.",
        )

    projected = abs(cumulative_offset_degrees) + requested_step_degrees
    if projected > config.nudge_max_degrees:
        return _refuse(
            CommandRejectionReason.safety_nudge_limit_exceeded,
            f"Cumulative nudge would reach {projected:.4f}, beyond the limit "
            f"{config.nudge_max_degrees:.4f}. The control re-centres instead.",
        )

    return PERMITTED


@dataclass(frozen=True)
class SafetyEnvelope:
    """The agent's local copy of the envelope, bound to its site.

    A thin wrapper over the pure functions above, so callers do not have to carry
    the config and site around separately. All the logic lives in the functions;
    this holds no rules of its own.
    """

    config: SafetyEnvelopeConfig | None = None
    site: SiteLocation | None = None

    @property
    def is_measured(self) -> bool:
        return is_measured(self.config)

    def evaluate_pointing(
        self,
        at_time: datetime,
        altitude_degrees: float,
        azimuth_degrees: float,
        operator_override: bool = False,
    ) -> Verdict:
        return evaluate_pointing(
            self.config,
            self.site,
            at_time,
            altitude_degrees,
            azimuth_degrees,
            operator_override,
        )

    def evaluate_nudge(
        self, cumulative_offset_degrees: float, requested_step_degrees: float
    ) -> Verdict:
        return evaluate_nudge(self.config, cumulative_offset_degrees, requested_step_degrees)
