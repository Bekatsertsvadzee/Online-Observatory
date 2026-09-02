"""Device interfaces.

The agent never talks to hardware directly. It talks to these, and configuration
decides which implementation it gets. The simulator is the default, always.

Every implementation declares its `mode`. A simulated device reports
ObservatoryMode.simulated, and that label travels with every status and every
frame it produces, all the way to the interface a customer sees. Nothing showing
simulated output may present it as the real sky.

Real implementations arrive in DV-028 (AlpacaMount), DV-029 (ZwoCamera) and
DV-031 (focuser). They satisfy these same interfaces and are checked by the same
conformance suite in tests/test_device_conformance.py.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.devices.frame import Frame


class DeviceError(Exception):
    """A device refused or failed an operation."""


class NotConnectedError(DeviceError):
    """An operation was attempted on a device that is not connected."""


@dataclass(frozen=True)
class MountStatus:
    connected: bool
    slewing: bool
    tracking: bool
    parked: bool
    altitude_degrees: float
    azimuth_degrees: float
    health: DeviceHealth
    mode: ObservatoryMode


@dataclass(frozen=True)
class CameraStatus:
    connected: bool
    exposing: bool
    width_px: int
    height_px: int
    health: DeviceHealth
    mode: ObservatoryMode


@dataclass(frozen=True)
class FocuserStatus:
    connected: bool
    moving: bool
    position: int
    max_position: int
    health: DeviceHealth
    mode: ObservatoryMode


class Device(ABC):
    """Common behaviour. Every driver connects, disconnects and reports itself."""

    @property
    @abstractmethod
    def mode(self) -> ObservatoryMode:
        """SIMULATED or REAL. Travels with every payload this device produces."""

    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def disconnect(self) -> None: ...

    @abstractmethod
    def status(self) -> MountStatus | CameraStatus | FocuserStatus: ...


class MountDriver(Device):
    """A telescope mount."""

    @abstractmethod
    def status(self) -> MountStatus: ...

    @abstractmethod
    def slew_to(self, altitude_degrees: float, azimuth_degrees: float) -> None:
        """Begin a slew. Returns immediately; motion progresses over time.

        Safety is not checked here. Nothing reaches a driver without passing the
        safety envelope first (DV-023). A driver that enforced its own policy
        would put a second, divergent copy of the rules in the system.
        """

    @abstractmethod
    def abort_slew(self) -> None:
        """Stop motion now. Safe to call when not slewing."""

    @abstractmethod
    def park(self) -> None:
        """Move to park and stop tracking. Must always be available."""

    @abstractmethod
    def unpark(self) -> None: ...

    @abstractmethod
    def set_tracking(self, tracking: bool) -> None: ...


class CameraDriver(Device):
    """An imaging camera."""

    @abstractmethod
    def status(self) -> CameraStatus: ...

    @abstractmethod
    def expose(self, exposure_milliseconds: float, gain: int) -> None:
        """Begin an exposure. Returns immediately."""

    @abstractmethod
    def exposure_complete(self) -> bool: ...

    @abstractmethod
    def read_frame(self) -> Frame:
        """Return the completed exposure. Raises if the exposure is still running."""

    @abstractmethod
    def abort_exposure(self) -> None: ...


class FocuserDriver(Device):
    """A focus motor."""

    @abstractmethod
    def status(self) -> FocuserStatus: ...

    @abstractmethod
    def move_to(self, position: int) -> None: ...

    @abstractmethod
    def halt(self) -> None: ...
