# ADR-021 — Colour frames from a one-shot colour camera

- **Date:** 2026-09-17
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Approved:** 2026-09-17
- **Arises from:** issue #113, found while writing `ZwoCamera` (DV-029)
- **Blocks:** DV-035 first light, and every frame a customer would see
- **Relates to:** ADR-001 (direct SDK control), ADR-011 (live view transport),
  ADR-012 (capture storage)

## Context

The ASI585MC is a **one-shot colour** camera. Its sensor has a colour filter over
every photosite in a repeating 2×2 pattern, so a raw frame is not a picture: it is
a mosaic in which each pixel carries one of red, green or blue. Turning that into
an image is *debayering* (demosaicing), and it is not optional — an undebayered
frame shown to a person is a grey checkerboard, and a stacked one is worse.

`ZwoCamera` returns the sensor's raw RAW16 frame, which is correct: that is the
data, and throwing colour away at the driver would be a decision made by accident.
But **nothing downstream knows the frame is a mosaic**, and every consumer treats a
`Frame` as a single-channel image:

| Where | What it does today | What a mosaic does to it |
| --- | --- | --- |
| `stream/mjpeg.py` (DV-032) | Stretches and encodes as an 8-bit greyscale JPEG | The live view — the product — is grey and visibly checkered |
| `capture/stack.py` (DV-033) | Aligns on a whole-pixel shift and averages | **An odd-pixel shift swaps the colour channels.** Red is averaged onto green, and the stack degrades as it "improves" |
| `solve/astap.py` (DV-030) | Writes the frame to FITS for ASTAP | Solvable in practice, but the FITS claims to be mono and says nothing about the pattern |
| `capture/deliverable.py` (DV-061) | Renders the delivered image | The customer keeps a grey checkerboard |

None of this shows on the simulator, because `SimCamera` renders a genuinely
monochrome star field. It would appear for the first time on the first real frame,
which is the worst possible moment: at first light, with an operator present, in
the one part of the system the whole product exists to deliver.

Three facts constrain the answer.

**Alignment in the mosaic domain must move in even pixel steps.** The colour
pattern repeats every two pixels, so a one-pixel correction lands red on green. A
stack that aligns on the mosaic must quantise its shifts to two pixels; one that
aligns after debayering need not.

**Debayering costs CPU on a machine that has little.** The mini-PC is an N95 with
8 GB (ADR-001). A full-frame 3840×2160 debayer is tens of milliseconds and a
three-channel float accumulator at that size is roughly 200 MB, against 66 MB for
a single-channel one.

**Phase 1 is a live view, not astrophotography.** `CLAUDE.md` is explicit. The
image a customer watches has to look right; it does not have to survive
photometric scrutiny.

## Decision

**1. The raw mosaic stays raw all the way through stacking.** The camera driver
returns what the sensor produced and nothing debayers on the way in. `Frame` gains
one field, `bayer_pattern` — `RGGB`, `BGGR`, `GRBG`, `GBRG`, or `None` for a
genuinely mono frame — reported by the camera and carried with the data, exactly as
`mode` already is. A simulated frame keeps `None` and behaves as it does today.

**2. Debayering happens at the presentation boundary, and only there.** One module
owns it, and the two places a person sees a frame call it: the live view before it
stretches and encodes, and the deliverable before it renders. Nothing else in the
agent handles colour.

**3. Stacking aligns to even pixel offsets when the frame is a mosaic.** The
existing whole-pixel alignment is rounded to a multiple of two so that red stays on
red. A one-pixel residual is below the seeing disc and far below what a live view
resolves.

**4. Plate solving keeps the mosaic and declares it.** The FITS written for ASTAP
carries `BAYERPAT`, the keyword ASTAP's documentation names for a colour frame, so
the solver stops describing a mosaic as mono. Whether ASTAP solves an OSC frame
better with it is for first light to say; declaring what the data is costs nothing
either way.

**5. The stored FITS, when DV-061 stores one, keeps the mosaic** with its
`BAYERPAT`, and the delivered JPEG or PNG keeps the debayered image. The mosaic is
the measurement; the picture is the rendering; the astronomer gets the first and
the customer gets the second.

**6. No contract change.** `bayer_pattern` is an agent-internal property of a
frame. Nothing crossing a process boundary carries it today, and nothing needs to:
what the cloud receives is an encoded image, already debayered. **If it turns out
the cloud must know** — to re-render a FITS, say — that is a contract issue against
`contracts/openapi.yaml` and not a thing to add locally.

## Why this route

Debayering early, in the driver, would be less code: every consumer would receive
RGB and none of them would need to know anything. It was rejected for three
reasons. It triples the stack's memory on the machine with the least of it. It
debayers every sub-frame rather than every displayed frame, which at a frame a
second and one displayed stack a second is strictly more work. And it destroys the
raw data at the earliest possible point, which ADR-001 chose direct SDK control
precisely to avoid.

Stacking on the mosaic and debayering once at the end keeps the accumulator
single-channel, keeps every stored measurement raw, and confines colour to one
module that two callers use.

The cost is the even-shift constraint, and it is real: sub-pixel alignment is not
available in the mosaic domain. Phase 1 does not need it. If a later phase does,
the alignment moves after the debayer and this record is superseded.

## Alternatives considered

**Debayer in `ZwoCamera`.** Rejected above.

**Debayer in the live view only, and deliver the mosaic.** Rejected: the customer's
kept image is the thing they paid for.

**Take a colour-aware imaging library (OpenCV, colour-demosaicing).** Rejected for
now. Bilinear debayering is a handful of numpy slices, and ADR-001's reasoning
about what runs on the mini-PC applies to dependencies as well as processes. If
first light shows bilinear is not good enough — colour fringing on bright stars is
the thing to look for — a library is a contained change inside the one module.

**Set the camera to give a debayered frame.** The SDK offers RGB24 output. Rejected:
it debayers on the camera's terms, at 8 bits per channel, discarding the 12-bit
depth that live stacking averages to recover.

## Consequences

- `Frame` gains `bayer_pattern`; `SimCamera` leaves it `None` and nothing about the
  simulator changes.
- `ZwoCamera` reports the pattern the SDK gives for the sensor. **Which pattern the
  ASI585MC reports is unverified** — it is read from the camera at open, not
  hard-coded, and first light confirms it is the right way up.
- `capture/stack.py` quantises its correction to two pixels for a mosaic frame.
- A new `capture/colour.py` owns debayering; `stream/mjpeg.py` and
  `capture/deliverable.py` call it.
- `solve/astap.py` writes `BAYERPAT` when the frame has one.
- **Orientation is not settled by this record.** Whether a debayered frame comes out
  the right way up, and whether the pattern needs flipping for the row order the
  FITS uses, is a first-light question. Getting it wrong swaps red and blue, which
  is obvious the moment anybody looks at a real star field and invisible until then.

## Work this implies

Not scheduled here; the maintainer's to size and open.

1. `Frame.bayer_pattern`, and `ZwoCamera` reporting it. Small.
2. `capture/colour.py` with a bilinear debayer, tested on a synthetic mosaic built
   from a known RGB image. Medium.
3. Live view and deliverable calling it. Small.
4. Even-shift alignment in `LiveStack`, with a test that an odd shift no longer
   swaps channels. Small.
5. `BAYERPAT` in the solver's FITS. Small.
6. First light: confirm the pattern, the orientation and that colour looks right on
   a real star field. Attended — part of DV-035.
