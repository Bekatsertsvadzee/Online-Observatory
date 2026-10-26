"""DV-031: what `AlpacaFocuser` adds beyond the shared conformance suite.

The conformance suite proves it keeps the `FocuserDriver` interface. These prove
the parts only an Alpaca focuser has: loopback only, a relative-only focuser
refused, temperature compensation turned off, moves split at MaxIncrement, and
Alpaca on the wire.
"""

from __future__ import annotations

import pytest

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.clock import ManualClock
from darkview_agent.devices.alpaca_focuser import AlpacaFocuser
from darkview_agent.devices.base import DeviceError, NotConnectedError
from tests.fake_alpaca import FakeAlpacaFocuser, alpaca_focuser


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock()


@pytest.fixture
def fake(clock) -> FakeAlpacaFocuser:
    return FakeAlpacaFocuser(clock)


@pytest.fixture
def focuser(fake) -> AlpacaFocuser:
    return alpaca_focuser(fake)


@pytest.mark.parametrize("host", ["192.168.1.20", "0.0.0.0", "localhost", ""])
def test_a_host_that_is_not_a_loopback_address_is_refused(host):
    with pytest.raises(ValueError):
        AlpacaFocuser(host, 11111)


def test_a_loopback_focuser_is_real():
    assert AlpacaFocuser("127.0.0.1", 11111).mode is ObservatoryMode.real


def test_it_speaks_to_the_configured_focuser_number():
    seen = []

    def transport(method, path, params, timeout):
        seen.append(path)
        return 200, b'{"ErrorNumber": 0, "ErrorMessage": "", "Value": true}'

    AlpacaFocuser("127.0.0.1", 11111, 2, transport=transport).connect()
    assert seen and all(path.startswith("/api/v1/focuser/2/") for path in seen)


def test_a_relative_only_focuser_is_refused_and_released(fake, focuser):
    fake.absolute = False

    with pytest.raises(DeviceError, match="relative-only"):
        focuser.connect()

    assert focuser.status().connected is False
    assert fake.connected is False


def test_status_before_connecting_touches_nothing(fake, focuser):
    assert focuser.status().health is DeviceHealth.disconnected
    assert fake.requests == []


def test_the_travel_is_the_driver_s_max_step(clock):
    fake = FakeAlpacaFocuser(clock, max_step=12000)
    focuser = alpaca_focuser(fake)
    focuser.connect()

    assert focuser.status().max_position == 12000
    with pytest.raises(ValueError):
        focuser.move_to(12001)
    assert fake.puts("move") == []


def test_temperature_compensation_is_turned_off_on_connect(fake, focuser):
    fake.tempcomp = True

    focuser.connect()

    assert fake.tempcomp is False
    assert fake.puts("tempcomp") == [{"TempComp": "False"}]


def test_a_focuser_without_temperature_compensation_still_connects(fake, focuser):
    fake.tempcomp = None

    focuser.connect()

    assert focuser.status().connected is True
    assert fake.puts("tempcomp") == []


def test_a_move_is_an_absolute_position_on_the_wire(clock, fake, focuser):
    focuser.connect()
    focuser.move_to(16000)

    assert fake.puts("move") == [{"Position": "16000"}]
    assert focuser.status().moving is True
    clock.advance(600.0)
    assert focuser.status().position == 16000


def test_a_move_longer_than_max_increment_is_made_in_steps(clock):
    fake = FakeAlpacaFocuser(clock, max_increment=1000)
    focuser = alpaca_focuser(fake)
    focuser.connect()

    focuser.move_to(17500)
    for _ in range(5):
        clock.advance(600.0)
        focuser.status()

    status = focuser.status()
    assert status.position == 17500
    assert status.moving is False
    assert [int(p["Position"]) for p in fake.puts("move")] == [16000, 17000, 17500]


def test_halt_stops_the_motor_and_cancels_the_remaining_steps(clock):
    fake = FakeAlpacaFocuser(clock, max_increment=1000)
    focuser = alpaca_focuser(fake)
    focuser.connect()

    focuser.move_to(18000)
    focuser.halt()
    clock.advance(600.0)

    assert focuser.status().moving is False
    assert fake.puts("halt") == [{}]
    assert len(fake.puts("move")) == 1


def test_halt_before_connecting_touches_nothing(fake, focuser):
    focuser.halt()
    assert fake.requests == []


def test_a_driver_that_dropped_its_connection_raises_rather_than_reporting_still(fake, focuser):
    focuser.connect()
    fake.connected = False

    with pytest.raises(NotConnectedError):
        focuser.status()


def test_an_unreachable_bridge_is_a_device_error(fake, focuser):
    fake.unreachable = True
    with pytest.raises(DeviceError):
        focuser.connect()


def test_disconnect_halts_and_releases_the_driver(fake, focuser):
    focuser.connect()
    focuser.disconnect()

    assert fake.connected is False
    assert fake.puts("halt") == [{}]
    assert fake.puts("connected")[-1] == {"Connected": "False"}
