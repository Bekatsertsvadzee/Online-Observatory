"""Device interfaces.

The agent never talks to hardware directly. It talks to these, and configuration
decides which implementation it gets. The simulator is the default, always.

DV-022 fills these in. DV-020 only needs the interfaces to exist so that driver
selection can be written and tested against them.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class MountDriver(ABC):
    """A telescope mount."""

    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def disconnect(self) -> None: ...

    @abstractmethod
    def park(self) -> None:
        """Move to the park position and stop tracking. Must always be available."""


class CameraDriver(ABC):
    """An imaging camera."""

    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def disconnect(self) -> None: ...


class FocuserDriver(ABC):
    """A focus motor."""

    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def disconnect(self) -> None: ...
