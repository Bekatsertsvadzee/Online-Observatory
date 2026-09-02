from darkview_agent.clock import ManualClock
from darkview_agent.devices.simulated import SimFocuser


def connected_focuser(clock: ManualClock, position: int = 15000) -> SimFocuser:
    focuser = SimFocuser(clock=clock, position=position)
    focuser.connect()
    return focuser


def test_travel_takes_time_proportional_to_distance():
    clock = ManualClock()
    focuser = connected_focuser(clock)

    focuser.move_to(15000 + int(SimFocuser.STEPS_PER_SECOND * 2))
    clock.advance(1.0)
    assert focuser.status().moving is True

    clock.advance(1.1)
    assert focuser.status().moving is False


def test_reversing_direction_costs_backlash():
    """A reversal takes longer than the same distance travelled in one direction.

    Autofocus that ignores this converges to the wrong position on real hardware.
    DV-031 needs somewhere to prove it handles the reversal before the motor exists.
    """
    distance = 900

    forward_clock = ManualClock()
    forward = connected_focuser(forward_clock)
    forward.move_to(15000 + distance)
    forward_clock.advance(600.0)
    # Continue in the same direction: no backlash.
    forward.move_to(15000 + distance * 2)
    forward_duration = distance / SimFocuser.STEPS_PER_SECOND

    reverse_clock = ManualClock()
    reverse = connected_focuser(reverse_clock)
    reverse.move_to(15000 + distance)
    reverse_clock.advance(600.0)
    # Reverse: pays the backlash first.
    reverse.move_to(15000)

    forward_clock.advance(forward_duration + 0.01)
    reverse_clock.advance(forward_duration + 0.01)

    assert forward.status().moving is False, "same-direction move should have finished"
    assert reverse.status().moving is True, "reversal should still be taking up backlash"


def test_backlash_does_not_change_the_final_position():
    """Backlash costs time, not accuracy. The focuser still lands where told."""
    clock = ManualClock()
    focuser = connected_focuser(clock)

    focuser.move_to(16000)
    clock.advance(600.0)
    focuser.move_to(14000)
    clock.advance(600.0)

    assert focuser.status().position == 14000


def test_halt_stops_where_it_is():
    clock = ManualClock()
    focuser = connected_focuser(clock)

    focuser.move_to(25000)
    clock.advance(2.0)
    moving_position = focuser.status().position
    assert 15000 < moving_position < 25000

    focuser.halt()

    stopped = focuser.status()
    assert stopped.moving is False
    assert stopped.position == moving_position


def test_first_move_pays_no_backlash():
    """There is no previous direction to reverse from."""
    clock = ManualClock()
    focuser = connected_focuser(clock)
    distance = 900

    focuser.move_to(15000 + distance)
    clock.advance(distance / SimFocuser.STEPS_PER_SECOND + 0.01)

    assert focuser.status().moving is False


def test_moving_to_the_current_position_completes_immediately():
    clock = ManualClock()
    focuser = connected_focuser(clock)

    focuser.move_to(15000)
    clock.advance(0.001)

    assert focuser.status().moving is False
    assert focuser.status().position == 15000
