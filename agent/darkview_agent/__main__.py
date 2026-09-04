"""Start the Observatory Agent.

    python -m darkview_agent

Everything that decides anything lives elsewhere. This file reads configuration,
assembles the supervisor, starts the watchdog on its own thread, and turns the
main loop until it is asked to stop. It is deliberately the only part of the
agent that touches `sleep`, signals or `os.environ`, because it is the only part
that cannot be driven by a test at a chosen instant.

Two refusals to start, both fail-closed:

- REAL drivers without an attending operator. `load_config` raises; nothing here
  can override it.
- No observatory id, cloud URL or device token. An agent that cannot dial out
  cannot be told to park by anyone, and one sitting on a rooftop with a
  telescope and no way to be reached is the situation to avoid, not to tolerate.

On shutdown the mount is parked. A clean stop is still a stop, and the mount does
not know the difference between an operator pressing Ctrl-C and a crash.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading
from types import FrameType

from darkview_agent import runtime
from darkview_agent.config import AgentConfig, ConfigurationError, load_config
from darkview_agent.link.session import LinkState, ProtocolVersionRefused
from darkview_agent.link.websocket import build_connector
from darkview_agent.safety.envelope import SafetyEnvelope
from darkview_agent.safety.watchdog import WatchdogThread
from darkview_agent.supervisor import DEFAULT_LOOP_INTERVAL_SECONDS, build_supervisor

logger = logging.getLogger("darkview.agent")


def run(config: AgentConfig, stop: threading.Event) -> None:
    """Turn the main loop until `stop` is set, then park."""
    envelope = SafetyEnvelope(site=config.site)
    devices = runtime.start(config, envelope)

    if config.site is None:
        logger.warning(
            "no site coordinates configured — the Sun's position cannot be computed, "
            "so every slew will be refused until DARKVIEW_AGENT_SITE_LATITUDE and "
            "DARKVIEW_AGENT_SITE_LONGITUDE are set"
        )

    assert config.cloud_url is not None and config.device_token is not None
    supervisor = build_supervisor(
        config=config,
        devices=devices,
        connect=build_connector(config.cloud_url, config.device_token),
        envelope=envelope,
    )

    watchdog = WatchdogThread(supervisor.watchdog)
    watchdog.start()
    logger.info("agent running; watchdog thread up")

    try:
        while not stop.is_set():
            try:
                supervisor.pump()
            except ProtocolVersionRefused as error:
                # Terminal, and deliberately not retried. The cloud speaks a
                # protocol this build does not, and a half-understood message set
                # on a link that drives a telescope is worse than no link.
                logger.error("cloud refused this agent's protocol: %s", error)
                break
            except Exception:
                # A supervisor that dies on one bad message leaves a telescope
                # under nothing but the watchdog. Log it and keep pumping; the
                # watchdog is the backstop, not the plan.
                logger.exception("supervisor pass failed; continuing")

            if supervisor.link.state is LinkState.REFUSED:
                logger.error("the link is refused and will not be retried; stopping")
                break

            stop.wait(DEFAULT_LOOP_INTERVAL_SECONDS)
    finally:
        logger.info("stopping: parking the mount")
        watchdog.stop()
        with supervisor.watchdog.device_lock:
            try:
                devices.mount.park()
            except Exception as error:
                logger.error("could not park the mount on shutdown: %s", error)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    try:
        config = load_config()
    except ConfigurationError as error:
        logger.error("%s", error)
        return 2

    if not config.can_dial_out:
        logger.error(
            "refusing to start: set DARKVIEW_AGENT_OBSERVATORY_ID, "
            "DARKVIEW_AGENT_CLOUD_URL and DARKVIEW_AGENT_DEVICE_TOKEN. An agent that "
            "cannot reach the cloud cannot be told to stop."
        )
        return 2

    stop = threading.Event()

    def request_stop(signal_number: int, _frame: FrameType | None) -> None:
        logger.info("received signal %s", signal_number)
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    run(config, stop)
    return 0


if __name__ == "__main__":
    sys.exit(main())
