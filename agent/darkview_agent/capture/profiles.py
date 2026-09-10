"""What each imaging profile asks of the camera.

`CapturePayload` names an `ImagingProfile` and nothing else about the exposure.
Something has to turn that name into an exposure, a gain and a number of frames,
and until now nothing did -- which is why CAPTURE was refused outright.

The numbers are per-object-class rather than per-target. A globular cluster and a
planetary nebula want different exposures; two globular clusters do not want
different ones badly enough to justify a table with a row per target that an
operator would have to maintain.

PROVISIONAL. Every figure here was chosen against `SimCamera` and the starfield
generator, not measured on an ASI585MC through a C6. They are not safety values --
nothing in this file can move a telescope -- so a provisional value is allowed to
ship, but DV-035 replaces them at first light and they must not be read as
measurements before then.
"""

from __future__ import annotations

from dataclasses import dataclass

from contracts.models import ImagingProfile

#: The most frames one CAPTURE will ever stack.
#:
#: A bound on the run, not a recommendation. Phase 1 is live view: a customer is
#: watching this happen, and a capture that ran for ten minutes because a payload
#: asked for six hundred frames would occupy the telescope for somebody else's
#: slot. The cloud bounds the request too; this is the agent's own second answer,
#: which is the rule the whole safety model is built on.
MAX_FRAMES = 120


@dataclass(frozen=True)
class Profile:
    """One imaging profile's exposure settings. PROVISIONAL -- see the module note."""

    exposure_milliseconds: float
    gain: int
    frames: int

    def __post_init__(self) -> None:
        if self.exposure_milliseconds <= 0:
            raise ValueError("exposure_milliseconds must be greater than zero")
        if self.gain < 0:
            raise ValueError("gain must not be negative")
        if not 0 < self.frames <= MAX_FRAMES:
            raise ValueError(f"frames must be between 1 and {MAX_FRAMES}")


#: Bright things get short exposures at low gain; faint extended things get
#: longer subs, more gain and more of them. The Moon at 2 seconds would be a
#: white disc, and a bright nebula at 8 milliseconds would be a black rectangle.
PROFILES: dict[ImagingProfile, Profile] = {
    ImagingProfile.lunar: Profile(exposure_milliseconds=8.0, gain=0, frames=30),
    ImagingProfile.planetary: Profile(exposure_milliseconds=15.0, gain=120, frames=60),
    ImagingProfile.double_star: Profile(exposure_milliseconds=250.0, gain=150, frames=20),
    ImagingProfile.globular_cluster: Profile(
        exposure_milliseconds=2000.0, gain=200, frames=20
    ),
    ImagingProfile.planetary_nebula: Profile(
        exposure_milliseconds=3000.0, gain=250, frames=20
    ),
    ImagingProfile.bright_nebula: Profile(
        exposure_milliseconds=4000.0, gain=300, frames=25
    ),
}


def resolve(
    profile: ImagingProfile,
    requested_frames: int | None = None,
    target_integration_seconds: float | None = None,
) -> Profile:
    """The settings for one CAPTURE, after the payload has had its say.

    The payload may ask for a frame count or for a total integration; it may not
    ask for an exposure or a gain, which belong to the profile. A request for
    both is not a conflict to resolve -- an explicit frame count is the more
    specific of the two, so it wins and the integration is what it produces.

    Anything above `MAX_FRAMES` is clamped rather than refused. The number is the
    agent's own bound on how long it will hold the telescope, and refusing a
    capture outright because somebody asked for too many frames would lose the
    customer their observation over a figure that has a perfectly good ceiling.
    """
    base = PROFILES[profile]

    if requested_frames is not None:
        frames = requested_frames
    elif target_integration_seconds is not None:
        # Rounded up: a request for 10 seconds of a 3-second sub is four frames,
        # not three. Asking for at least this much integration is the only
        # reading of the field that cannot silently under-deliver.
        frames = -(-int(target_integration_seconds * 1000) // int(base.exposure_milliseconds))
    else:
        return base

    return Profile(
        exposure_milliseconds=base.exposure_milliseconds,
        gain=base.gain,
        frames=max(1, min(frames, MAX_FRAMES)),
    )


__all__ = ["MAX_FRAMES", "PROFILES", "Profile", "resolve"]
