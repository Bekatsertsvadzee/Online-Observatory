"""ADR-064: off unless configured, and nothing personal or secret is sent."""

from __future__ import annotations

import pytest

from darkview_agent.monitoring import SCRUBBED, scrub_event, scrub_text, start_monitoring


def test_monitoring_is_off_without_a_dsn() -> None:
    assert start_monitoring({}) is False
    assert start_monitoring({"SENTRY_DSN": "  "}) is False


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ("no account for nika@example.com", "nika@example.com"),
        ("Authorization: Bearer abc.def-ghi", "abc.def-ghi"),
        ("DARKVIEW_AGENT_DEVICE_TOKEN=dv_live_abcdef", "dv_live_abcdef"),
        ("grant 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "9f86d0"),
    ],
)
def test_secrets_are_scrubbed_from_text(text: str, secret: str) -> None:
    scrubbed = scrub_text(text)
    assert secret not in scrubbed
    assert SCRUBBED in scrubbed


def test_fault_details_survive() -> None:
    text = "mission 3f1c2a9e-5b6d-4c7e-8f90-a1b2c3d4e5f6 failed: SLEW_TIMEOUT"
    assert scrub_text(text) == text


def test_event_loses_user_request_and_secret_keys() -> None:
    event = scrub_event(
        {
            "message": "upload refused for a@b.co",
            "user": {"id": "1"},
            "server_name": "observatory-mini-pc",
            "request": {"url": "https://x"},
            "exception": {"values": [{"type": "RuntimeError", "value": "token=abc refused"}]},
            "breadcrumbs": {
                "values": [{"message": "dial", "data": {"device_token": "t", "url": "wss://x"}}]
            },
            "extra": {"config": {"device_token": "t", "observatory_id": "o"}},
        }
    )
    assert event == {
        "message": f"upload refused for {SCRUBBED}",
        "exception": {"values": [{"type": "RuntimeError", "value": f"token={SCRUBBED} refused"}]},
        "breadcrumbs": {
            "values": [{"message": "dial", "data": {"device_token": SCRUBBED, "url": "wss://x"}}]
        },
        "extra": {"config": {"device_token": SCRUBBED, "observatory_id": "o"}},
    }
