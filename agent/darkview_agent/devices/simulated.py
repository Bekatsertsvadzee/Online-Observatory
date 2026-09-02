"""Simulated devices — the default implementation.

These are deliberately minimal. They exist so the agent can start, select drivers
and be tested without hardware. DV-022 gives them real behaviour: slew timing,
tracking, frame generation.
"""

from __future__ import annotations

from darkview_agent.devices.base import CameraDriver, FocuserDriver, MountDriver


class SimMount(MountDriver):
    def __init__(self) -> None:
        self.connected = False
        self.parked = True

    def connect(self) -> None:
        self.connected = True

    def disconnect(self) -> None:
        self.connected = False

    def park(self) -> None:
        self.parked = True


class SimCamera(CameraDriver):
    def __init__(self) -> None:
        self.connected = False

    def connect(self) -> None:
        self.connected = True

    def disconnect(self) -> None:
        self.connected = False


class SimFocuser(FocuserDriver):
    def __init__(self) -> None:
        self.connected = False

    def connect(self) -> None:
        self.connected = True

    def disconnect(self) -> None:
        self.connected = False
