"""DV-028: what `AlpacaMount` adds beyond the shared conformance suite.

The conformance suite proves it keeps the `MountDriver` interface. These prove the
parts only a network driver has: it reaches loopback and nothing else, it refuses a
driver missing a capability it relies on, it survives ASCOM's rule that an alt/az
slew is invalid while tracking, and it speaks Alpaca on the wire.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

import pytest

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.clock import ManualClock
from darkview_agent.devices.alpaca import AlpacaMount, http_transport
from darkview_agent.devices.base import DeviceError, NotConnectedError
from tests.fake_alpaca import FakeAlpacaTelescope, alpaca_mount, parse_form


@pytest.fixture
def telescope() -> FakeAlpacaTelescope:
    return FakeAlpacaTelescope(ManualClock())


@pytest.fixture
def mount(telescope) -> AlpacaMount:
    return alpaca_mount(telescope)


# --------------------------------------------------------------------------
# Loopback only
# --------------------------------------------------------------------------


@pytest.mark.parametrize("host", ["192.168.1.20", "0.0.0.0", "10.0.0.5", "localhost", ""])
def test_a_host_that_is_not_a_loopback_address_is_refused(host):
    with pytest.raises(ValueError):
        AlpacaMount(host, 11111)


@pytest.mark.parametrize("host", ["127.0.0.1", "::1"])
def test_a_loopback_address_is_accepted(host):
    assert AlpacaMount(host, 11111).mode is ObservatoryMode.real


def test_the_transport_refuses_a_remote_host_on_its_own():
    with pytest.raises(ValueError):
        http_transport("203.0.113.7", 11111)


# --------------------------------------------------------------------------
# Connecting
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "capability", ["canslewaltazasync", "canpark", "canunpark", "cansettracking"]
)
def test_a_driver_missing_a_capability_is_refused_and_released(telescope, mount, capability):
    telescope.capabilities[capability] = False

    with pytest.raises(DeviceError, match=capability):
        mount.connect()

    assert mount.status().connected is False
    assert telescope.connected is False


def test_status_before_connecting_touches_nothing(telescope, mount):
    status = mount.status()
    assert status.health is DeviceHealth.disconnected
    assert telescope.requests == []


def test_a_driver_that_dropped_its_connection_does_not_report_a_finished_slew(telescope, mount):
    """Reporting slewing=False here would let a mission move on from SLEWING."""
    mount.connect()
    mount.unpark()
    mount.slew_to(40.0, 120.0)
    telescope.connected = False

    with pytest.raises(NotConnectedError):
        mount.status()


def test_an_unreachable_bridge_is_a_device_error(telescope, mount):
    mount.connect()
    telescope.unreachable = True
    with pytest.raises(DeviceError):
        mount.status()


# --------------------------------------------------------------------------
# Tracking and alt/az slews
# --------------------------------------------------------------------------


def _start_like_the_runner(mount: AlpacaMount) -> None:
    """The order `MissionRunner` uses: tracking goes on before the slew."""
    mount.connect()
    mount.unpark()
    mount.set_tracking(True)


def test_a_slew_on_a_tracking_mount_pauses_tracking_and_resumes_it_when_motion_ends(
    telescope, mount
):
    _start_like_the_runner(mount)

    mount.slew_to(50.0, 200.0)

    assert telescope.puts("tracking") == [{"Tracking": "True"}, {"Tracking": "False"}]
    assert mount.status().slewing is True
    assert mount.status().tracking is False

    telescope.clock.advance(600.0)
    status = mount.status()
    assert status.slewing is False
    assert status.tracking is True
    assert status.altitude_degrees == pytest.approx(50.0, abs=0.01)
    assert status.azimuth_degrees == pytest.approx(200.0, abs=0.01)
    assert telescope.puts("tracking")[-1] == {"Tracking": "True"}


def test_a_nudge_after_the_slew_tracks_from_the_offset_position(telescope, mount):
    """The decision DV-040 left open: the offset moves the target and stays moved."""
    _start_like_the_runner(mount)
    mount.slew_to(50.0, 200.0)
    telescope.clock.advance(600.0)
    mount.status()

    mount.slew_to(50.25, 200.0)
    telescope.clock.advance(60.0)
    status = mount.status()

    assert status.tracking is True
    assert status.altitude_degrees == pytest.approx(50.25, abs=0.01)


def test_an_abort_does_not_resume_tracking(telescope, mount):
    _start_like_the_runner(mount)
    mount.slew_to(60.0, 90.0)
    telescope.clock.advance(2.0)

    mount.abort_slew()
    telescope.clock.advance(600.0)

    assert mount.status().tracking is False


def test_a_refused_slew_restores_the_tracking_it_paused(telescope, mount):
    _start_like_the_runner(mount)
    telescope.fail_members["slewtoaltazasync"] = (0x401, "coordinates out of range")

    with pytest.raises(DeviceError, match="0x401"):
        mount.slew_to(30.0, 10.0)

    assert mount.status().tracking is True


def test_tracking_requested_during_a_paused_slew_waits_for_the_slew(telescope, mount):
    _start_like_the_runner(mount)
    mount.slew_to(45.0, 45.0)

    mount.set_tracking(True)

    assert telescope.puts("tracking")[-1] == {"Tracking": "False"}
    telescope.clock.advance(600.0)
    assert mount.status().tracking is True


# --------------------------------------------------------------------------
# Park
# --------------------------------------------------------------------------


def test_park_connects_when_this_session_never_did(telescope, mount):
    """A heartbeat loss can arrive before any mission has connected the mount."""
    telescope.mount.connect()
    telescope.mount.unpark()
    assert telescope.connected is False

    mount.park()

    assert telescope.mount.status().parked is True


def test_park_still_parks_when_the_abort_fails(telescope, mount):
    mount.connect()
    mount.unpark()
    mount.slew_to(70.0, 180.0)
    telescope.fail_members["abortslew"] = (0x4FF, "driver fault")

    mount.park()

    assert mount.status().parked is True


def test_park_cancels_a_pending_tracking_resume(telescope, mount):
    _start_like_the_runner(mount)
    mount.slew_to(70.0, 180.0)

    mount.park()
    telescope.clock.advance(600.0)

    assert mount.status().tracking is False
    assert telescope.puts("tracking")[-1] == {"Tracking": "False"}


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


def test_an_ascom_not_connected_error_is_a_not_connected_error(telescope, mount):
    mount.connect()
    telescope.fail_members["slewing"] = (0x407, "not connected")
    with pytest.raises(NotConnectedError):
        mount.status()


def test_an_http_error_is_a_device_error():
    mount = AlpacaMount(
        "127.0.0.1", 11111, transport=lambda method, path, params, timeout: (500, b"boom")
    )
    with pytest.raises(DeviceError, match="HTTP 500"):
        mount.connect()


def test_a_body_that_is_not_json_is_a_device_error():
    mount = AlpacaMount(
        "127.0.0.1", 11111, transport=lambda method, path, params, timeout: (200, b"<html>")
    )
    with pytest.raises(DeviceError, match="JSON"):
        mount.connect()


def test_park_is_given_longer_than_an_ordinary_request(telescope):
    timeouts: dict[str, float] = {}

    def recording(method, path, params, timeout):
        timeouts[path.rsplit("/", 1)[-1]] = timeout
        return telescope.transport(method, path, params, timeout)

    mount = AlpacaMount("127.0.0.1", 11111, transport=recording)
    mount.connect()
    mount.park()

    assert timeouts["park"] > timeouts["connected"]


# --------------------------------------------------------------------------
# The wire
# --------------------------------------------------------------------------


@pytest.fixture
def loopback_bridge(telescope):
    """The fake telescope behind a real HTTP server on 127.0.0.1, test-side only."""
    seen: list[tuple[str, str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self, method: str, params: dict[str, str]) -> None:
            path = urlsplit(self.path).path
            seen.append((method, path, self.headers.get("Content-Type")))
            prefix = "/api/v1/telescope/0/"
            status, body = (
                telescope.handle(method, path[len(prefix) :], params)
                if path.startswith(prefix)
                else (404, b"")
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._answer("GET", dict(parse_qsl(urlsplit(self.path).query)))

        def do_PUT(self):
            length = int(self.headers.get("Content-Length", "0"))
            self._answer("PUT", parse_form(self.rfile.read(length)))

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1], seen
    finally:
        server.shutdown()
        server.server_close()


def test_a_slew_round_trips_over_real_http(telescope, loopback_bridge):
    port, seen = loopback_bridge
    mount = AlpacaMount("127.0.0.1", port)

    mount.connect()
    mount.unpark()
    mount.slew_to(33.5, 271.25)
    telescope.clock.advance(600.0)
    status = mount.status()

    assert status.altitude_degrees == pytest.approx(33.5, abs=0.01)
    assert status.azimuth_degrees == pytest.approx(271.25, abs=0.01)
    assert telescope.puts("slewtoaltazasync") == [{"Azimuth": "271.25", "Altitude": "33.5"}]
    puts = [content_type for method, _, content_type in seen if method == "PUT"]
    assert puts and all(ct == "application/x-www-form-urlencoded" for ct in puts)


def test_a_device_number_the_bridge_does_not_serve_is_a_device_error(loopback_bridge):
    port, _ = loopback_bridge
    mount = AlpacaMount("127.0.0.1", port, device_number=3)
    with pytest.raises(DeviceError, match="HTTP 404"):
        mount.connect()


def test_a_bridge_that_is_not_running_is_a_device_error():
    mount = AlpacaMount("127.0.0.1", 1)
    with pytest.raises(DeviceError, match="did not answer"):
        mount.connect()
