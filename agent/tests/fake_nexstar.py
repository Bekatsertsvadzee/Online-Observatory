"""A NexStar hand controller on a fake serial port.

Two motor axes that move at whatever rate `P,3` last set, integrated on a
`ManualClock`, and a focus motor at AUX 0x12. The rates persist until replaced,
as on the real hand controller -- which is why a test that jumps the clock must
let the driver's control loop run inside the jump: the fake does that, in steps of
the loop's period, by calling `controller` (the driver's `tick`) between them. It
stands in for the driver's thread, which tests do not start.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from darkview_agent.clock import ManualClock
from darkview_agent.devices.nexstar import TICK_SECONDS, NexStarLink, NexStarMount
from darkview_agent.devices.nexstar_focuser import NexStarFocuser
from darkview_agent.safety.sun import SiteLocation

SITE = SiteLocation(latitude_degrees=41.7151, longitude_degrees=44.8271)

#: Identity model: mount axes equal sky altitude and azimuth.
IDENTITY_POINTS = [{"name": "Vega", "maz": 60.0, "malt": 40.0, "az": 60.0, "alt": 40.0}]


class FakeNexStarPort:
    def __init__(self, clock: ManualClock | None = None) -> None:
        self.clock = clock or ManualClock()
        self.axes = {16: 0.0, 17: 0.0}
        self.rates = {16: 0.0, 17: 0.0}
        self.focus = 20000
        self.focus_goal: int | None = None
        self.focus_limits = (1000, 41000)
        self.focus_steps_per_second = 500
        self.controller: Callable[[], None] | None = None
        self.writes: list[bytes] = []
        self.unplugged = False
        self.silent = False
        self.closed = False
        self.rate_sign = {16: 1, 17: 1}
        """-1 wires an axis backwards, as a model with the wrong sign would see it."""
        self._reply = b""
        self._last = self.clock.monotonic()
        self._stepping = False

    # pyserial's surface
    def reset_input_buffer(self) -> None:
        self._reply = b""

    def write(self, data: bytes) -> int:
        if self.unplugged:
            raise OSError("device not configured")
        self._catch_up()
        self.writes.append(bytes(data))
        self._reply = b"" if self.silent else self._answer(bytes(data))
        return len(data)

    def read(self, size: int) -> bytes:
        reply, self._reply = self._reply[:size], self._reply[size:]
        return reply

    def close(self) -> None:
        self.closed = True

    # the hand controller
    def _catch_up(self) -> None:
        if self._stepping:
            return
        self._stepping = True
        try:
            while self.clock.monotonic() - self._last > 1e-9:
                step = min(TICK_SECONDS, self.clock.monotonic() - self._last)
                self._move(step)
                self._last += step
                if self.controller is not None:
                    self.controller()
        finally:
            self._stepping = False

    def _move(self, seconds: float) -> None:
        for axis in (16, 17):
            self.axes[axis] += self.rate_sign[axis] * self.rates[axis] * seconds
        if self.focus_goal is not None:
            distance = self.focus_goal - self.focus
            travel = int(self.focus_steps_per_second * seconds)
            if abs(distance) <= travel:
                self.focus, self.focus_goal = self.focus_goal, None
            else:
                self.focus += travel if distance > 0 else -travel

    def _answer(self, data: bytes) -> bytes:
        if data == b"z":
            azimuth = int((self.axes[16] % 360.0) / 360.0 * 2**32) & 0xFFFFFFFF
            altitude = int((self.axes[17] % 360.0) / 360.0 * 2**32) & 0xFFFFFFFF
            return f"{azimuth:08X},{altitude:08X}#".encode()
        if len(data) == 8 and data[0] == 80:
            device, command = data[2], data[3]
            if data[1] == 3 and device in (16, 17) and command in (6, 7):
                value = (data[4] << 8 | data[5]) / 4 / 3600
                self.rates[device] = value if command == 6 else -value
                return b"#"
            if device == 0x12:
                return self._focuser(command, data[4:7])
        return b""

    def _focuser(self, command: int, payload: bytes) -> bytes:
        if command == 0xFE:
            return b"\x01\x02#"
        if command == 0x2C:
            low, high = self.focus_limits
            return low.to_bytes(4, "big", signed=True) + high.to_bytes(4, "big", signed=True) + b"#"
        if command == 0x01:
            return self.focus.to_bytes(3, "big") + b"#"
        if command == 0x13:
            return (b"\xff" if self.focus_goal is None else b"\x00") + b"#"
        if command == 0x02:
            self.focus_goal = int.from_bytes(payload, "big")
            return b"#"
        if command == 0x24:
            self.focus_goal = None
            return b"#"
        return b""

    def rate_commands(self) -> list[bytes]:
        return [w for w in self.writes if w[:2] == bytes([80, 3])]


def write_model(path: Path, points=None, **extra) -> Path:
    path.write_text(json.dumps({"points": IDENTITY_POINTS if points is None else points, **extra}))
    return path


def nexstar_mount(port: FakeNexStarPort, model_path: Path, now=None) -> NexStarMount:
    kwargs = {"now": now} if now else {}
    mount = NexStarMount(
        NexStarLink(lambda: port),
        model_path,
        SITE,
        clock=port.clock,
        sleep=port.clock.advance,
        run_loop=False,
        **kwargs,
    )
    port.controller = mount.tick
    return mount


def nexstar_focuser(port: FakeNexStarPort) -> NexStarFocuser:
    return NexStarFocuser(NexStarLink(lambda: port))
