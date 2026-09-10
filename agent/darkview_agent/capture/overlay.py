"""The caption burned into a delivered capture.

`CaptureAssetKind` says IMAGE is "the delivered, stretched, watermarked image"
and UNMARKED is "the stored copy without the overlay". Uploading an unmarked JPEG
as IMAGE would make that distinction a lie in the one direction that matters, so
the overlay lives here and IMAGE is the only asset that gets it.

Two things go on the picture and nothing else.

**What it is.** The date, the integration, and the instrument. A capture leaves
the Collection and ends up somewhere with no caption around it, and an image of
the sky with no provenance is indistinguishable from any other image of the sky.

**Whether it is real.** A frame carries its own `mode`, and a simulated frame is
marked SIMULATED on the face of the image. `CLAUDE.md` forbids presenting
simulator output as real telescope output; a field in a database row does not
survive a screenshot, and this does.

The styling is Brand Identity System v2.0 -- Photon Blue on Darkview Night, one
line, bottom left, no HUD decoration and no frame. It is a caption, not a
graphic: the picture is what the customer came for.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

from contracts.models import ObservatoryMode

#: Brand Identity System v2.0.
PHOTON_BLUE = (92, 200, 255)
PRIMARY_TEXT = (242, 245, 247)
#: Darkview Night, as the caption's backing. Drawn at partial opacity so a star
#: behind the caption is dimmed rather than erased.
DARKVIEW_NIGHT = (5, 8, 13)

#: How tall the caption is, as a fraction of the image's short edge. Scaled
#: rather than fixed so a thumbnail and a full-size image carry the same caption
#: at the same relative weight.
CAPTION_HEIGHT_FRACTION = 0.055
MIN_CAPTION_HEIGHT_PX = 14

#: Below this the bundled face stops being legible at all.
MIN_TEXT_HEIGHT_PX = 8

#: The smallest image worth captioning. Below this the text would be illegible
#: and would cover the picture, so the overlay is skipped -- a thumbnail is
#: shown beside the captioned image it links to, never on its own.
MIN_CAPTIONABLE_EDGE_PX = 200


@dataclass(frozen=True)
class Caption:
    """What the overlay says. Assembled by the caller from the finished capture."""

    captured_at: datetime
    integration_seconds: float
    frames_stacked: int
    mode: ObservatoryMode
    optical_config: str

    @property
    def is_simulated(self) -> bool:
        return self.mode is ObservatoryMode.simulated

    def text(self) -> str:
        """One line. Read left to right: when, how much, through what."""
        stamp = self.captured_at.strftime("%Y-%m-%d %H:%M UTC")
        integration = f"{self.integration_seconds:.0f}s ({self.frames_stacked} frames)"
        return f"DARKVIEW   {stamp}   {integration}   {self.optical_config}"


def _font(height_px: int):
    """A font that exists everywhere, at the size the bar needs.

    Pillow's bundled face, deliberately. Shipping a TrueType file with the agent
    would mean picking one that renders identically on the observatory mini-PC
    and in CI, and the caption is six words -- not worth a font asset that could
    differ between the machine that draws it and the machine that reviewed it.

    `load_default(size=...)` returns the bundled face scaled; the unscaled call
    returns a fixed bitmap font about eleven pixels tall, which on a 2048-pixel
    image is a caption nobody can read. Older Pillow has no `size` parameter, so
    the unscaled font is the fallback rather than a crash.
    """
    try:
        return ImageFont.load_default(size=height_px)
    except TypeError:  # pragma: no cover - Pillow older than 10.1
        return ImageFont.load_default()


def apply(image: Image.Image, caption: Caption) -> Image.Image:
    """Return a captioned copy of `image`. The original is not modified.

    Returns RGB whatever went in: the caption is coloured, and a grayscale
    capture with a blue caption is still an RGB image. Callers that want the
    picture without the caption encode before calling this rather than trying to
    take it off afterwards, which is what UNMARKED means.
    """
    rendered = image.convert("RGB")

    short_edge = min(rendered.width, rendered.height)
    if short_edge < MIN_CAPTIONABLE_EDGE_PX:
        return rendered

    bar_height = max(
        MIN_CAPTION_HEIGHT_PX, int(short_edge * CAPTION_HEIGHT_FRACTION)
    )
    padding = max(4, bar_height // 4)
    # The text sits inside the bar with the padding above and below it.
    text_height = max(MIN_TEXT_HEIGHT_PX, bar_height - 2 * padding)

    # Drawn onto its own layer and composited, so the backing bar can be
    # semi-transparent. Drawing it straight onto the image would mean choosing
    # between a solid black band across the picture and text with no contrast
    # against whatever happens to be behind it.
    layer = Image.new("RGBA", rendered.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rectangle(
        [(0, rendered.height - bar_height), (rendered.width, rendered.height)],
        fill=(*DARKVIEW_NIGHT, 190),
    )

    font = _font(text_height)
    baseline = rendered.height - bar_height + padding
    draw.text((padding, baseline), caption.text(), font=font, fill=(*PRIMARY_TEXT, 255))

    if caption.is_simulated:
        # Right-aligned, in the accent colour, on the same line. Not a corner
        # badge and not a diagonal watermark: it has to survive a crop of the
        # sky, and the caption is the part a crop keeps.
        marker = "SIMULATED"
        width = int(draw.textlength(marker, font=font))
        draw.text(
            (rendered.width - width - padding, baseline),
            marker,
            font=font,
            fill=(*PHOTON_BLUE, 255),
        )

    return Image.alpha_composite(rendered.convert("RGBA"), layer).convert("RGB")


__all__ = ["Caption", "apply"]
