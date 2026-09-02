"""Darkview Observatory Agent.

Runs on the observatory mini-PC. Dials out to the Darkview cloud over an
authenticated WebSocket, accepts no inbound connection, and independently
re-validates every command it receives before touching a device.
"""

__version__ = "0.1.0"
