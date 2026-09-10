"""The finished stack, as the files a customer keeps.

The live view and the capture are the same pixels prepared for different jobs,
and this is the second job. `stream/mjpeg.py` optimises a frame for a socket it
has to fit on once a second; this optimises the same frame for something somebody
downloads once and keeps -- bigger, better quality, and captioned.

Two assets, both derived from one stack:

| Kind | What it is |
| --- | --- |
| IMAGE | The delivered picture. Captioned, so it carries its own provenance. |
| UNMARKED | The same picture without the caption, as `CaptureAssetKind` defines it. |

**No THUMBNAIL, and not by choice.** `AGENT_CAPTURE_READY` carries
`imageStorageKey`, `unmarkedStorageKey` and `fitsStorageKey` and has no field for
a thumbnail, so there is no way to tell the cloud that one was written. Rendering
and uploading an object nothing can name would leave an orphan in the bucket and
`thumbnailUrl` null anyway. It needs a contract change, not a line here.

FITS is not produced either. It is the real linear frame data, the contract makes
it nullable, and writing one means a FITS library and a header convention that
has to agree with whatever a customer opens it in -- separate work rather than a
line in this file. `fitsStorageKey` stays null, which is honest; inventing a key
for an object nothing wrote would not be.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image

from darkview_agent.capture.overlay import Caption
from darkview_agent.capture.overlay import apply as apply_caption
from darkview_agent.devices.frame import Frame
from darkview_agent.stream.mjpeg import StreamSettings, stretch_to_8bit

#: The long edge of the delivered image.
#:
#: Larger than the live view's 1024, because this one is downloaded rather than
#: streamed and the bandwidth argument that bounds a live frame does not apply.
#: Still bounded: the ASI585MC's full 3840 of a stretched star field is a large
#: JPEG, and the extra pixels past this are sensor noise rather than detail the
#: optical train resolved. PROVISIONAL -- DV-035 measures what the C6 actually
#: delivers and replaces it.
DEFAULT_IMAGE_MAX_EDGE_PX = 2048

#: JPEG quality for the delivered image. Higher than the live view's 70: this is
#: the artefact the customer keeps, and it is encoded once.
DEFAULT_IMAGE_QUALITY = 90

CONTENT_TYPE = "image/jpeg"


@dataclass(frozen=True)
class RenderedAsset:
    """Encoded bytes and the shape they were encoded at."""

    payload: bytes
    width_px: int
    height_px: int
    content_type: str = CONTENT_TYPE


@dataclass(frozen=True)
class Deliverable:
    """Everything one finished capture produced."""

    image: RenderedAsset
    unmarked: RenderedAsset


def _fit(image: Image.Image, max_edge_px: int) -> Image.Image:
    longest = max(image.width, image.height)
    if longest <= max_edge_px:
        return image
    ratio = max_edge_px / longest
    # LANCZOS for the same reason the live view uses it: a downscaled star field
    # keeps point sources looking like point sources.
    return image.resize(
        (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
        Image.LANCZOS,
    )


def _encode(image: Image.Image, quality: int) -> RenderedAsset:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True)
    return RenderedAsset(
        payload=buffer.getvalue(), width_px=image.width, height_px=image.height
    )


def render(
    frame: Frame,
    caption: Caption,
    settings: StreamSettings | None = None,
    image_max_edge_px: int = DEFAULT_IMAGE_MAX_EDGE_PX,
    image_quality: int = DEFAULT_IMAGE_QUALITY,
) -> Deliverable:
    """Turn one stacked frame into the assets that get uploaded.

    The stretch is the live view's, deliberately. A customer who watched a stack
    build for a minute and then received a differently-stretched picture of it
    would have been shown something other than what they captured, and the
    autostretch is the whole reason the live view looks stable while it improves.

    Both assets are the same pixels at the same size, and differ only by the
    caption. That is what `CaptureAssetKind` says UNMARKED is -- "the stored copy
    without the overlay" -- so a smaller or differently-stretched second file
    would be a different picture rather than the same one uncaptioned.
    """
    stretched = Image.fromarray(stretch_to_8bit(frame.pixels, settings or StreamSettings()))
    full = _fit(stretched, image_max_edge_px)

    return Deliverable(
        image=_encode(apply_caption(full, caption), image_quality),
        unmarked=_encode(full.convert("RGB"), image_quality),
    )


__all__ = [
    "CONTENT_TYPE",
    "DEFAULT_IMAGE_MAX_EDGE_PX",
    "DEFAULT_IMAGE_QUALITY",
    "Deliverable",
    "RenderedAsset",
    "render",
]
