"""A synthetic star field.

This is not decoration. DV-030 points ASTAP at simulator output, so the field has
to look like a real short exposure: point sources with a Gaussian PSF, a
magnitude distribution that produces a few bright stars and many faint ones,
sky background, and read noise.

The field is deterministic for a given pointing. The same coordinates always
produce the same stars, and different coordinates produce different ones, so a
test can assert that the telescope actually moved by looking at what the camera
returned.
"""

from __future__ import annotations

import numpy as np

# 16-bit sensor. The ASI585MC is 12-bit, presented in a 16-bit container;
# DV-029 sets the real value from the SDK rather than assuming this one.
FULL_WELL = 65535


def _generator(altitude_degrees: float, azimuth_degrees: float) -> np.random.Generator:
    """Derive a stable seed from the pointing, quantised to 0.01 degrees.

    Quantising means a tiny nudge does not regenerate the entire sky, which is
    what you want when testing centring: the field shifts, it does not change.
    """
    altitude_key = int(round(altitude_degrees * 100))
    azimuth_key = int(round(azimuth_degrees * 100))
    seed = (altitude_key & 0xFFFFFFFF) << 32 | (azimuth_key & 0xFFFFFFFF)
    return np.random.default_rng(seed)


def render(
    width_px: int,
    height_px: int,
    altitude_degrees: float,
    azimuth_degrees: float,
    exposure_milliseconds: float,
    gain: int,
    star_count: int = 220,
) -> np.ndarray:
    """Render one exposure of the field at this pointing.

    Longer exposures and higher gain brighten stars, background and noise
    together, the way a real sensor behaves.
    """
    if width_px <= 0 or height_px <= 0:
        raise ValueError("frame dimensions must be positive")

    rng = _generator(altitude_degrees, azimuth_degrees)
    gain_factor = 1.0 + gain / 100.0
    exposure_factor = exposure_milliseconds / 1000.0

    # Sky background rises with exposure and gain. Bortle 8-9 skies are bright,
    # which is the whole reason Phase 1 is a live-view product.
    background = 900.0 * exposure_factor * gain_factor
    image = rng.normal(background, background * 0.06 + 12.0, (height_px, width_px))

    y_grid, x_grid = np.mgrid[0:height_px, 0:width_px]

    # Magnitude-like distribution: exponential gives many faint, few bright.
    brightnesses = rng.exponential(2600.0, star_count) * exposure_factor * gain_factor
    xs = rng.uniform(0, width_px, star_count)
    ys = rng.uniform(0, height_px, star_count)
    # Seeing varies slightly star to star, as it does on a real frame.
    sigmas = rng.uniform(1.3, 2.4, star_count)

    for x, y, brightness, sigma in zip(xs, ys, brightnesses, sigmas, strict=True):
        # Only render the neighbourhood of each star; a full-frame Gaussian per
        # star is needlessly slow at 220 stars.
        radius = int(np.ceil(sigma * 4))
        left, right = max(0, int(x) - radius), min(width_px, int(x) + radius + 1)
        top, bottom = max(0, int(y) - radius), min(height_px, int(y) + radius + 1)
        if left >= right or top >= bottom:
            continue

        local_x = x_grid[top:bottom, left:right]
        local_y = y_grid[top:bottom, left:right]
        squared_distance = (local_x - x) ** 2 + (local_y - y) ** 2
        image[top:bottom, left:right] += brightness * np.exp(
            -squared_distance / (2.0 * sigma**2)
        )

    # Read noise, then clip into the sensor's range.
    image += rng.normal(0.0, 8.0, image.shape)
    return np.clip(image, 0, FULL_WELL).astype(np.uint16)
