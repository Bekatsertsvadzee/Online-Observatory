# ADR-020 — Operators issue, rotate and revoke a node's device token

- **Date:** 2026-09-15
- **Status:** APPROVED
- **Decided by:** project maintainer, in session (direction: operator-issued, available
  from registration, shown once and stored hashed, with rotate and an unmetered revoke)
- **Approved:** 2026-09-15, as written
- **Arises from:** issue #86, found while scoping DV-123 (#87)
- **Relates to:** `ADR-013` (partner observatories), `ADR-009` (command relay), DV-115
  (abuse controls)

## Context

The Observatory Agent authenticates with one credential: a device token, presented as
`Authorization: Bearer` on its outbound handshake. The realtime service compares its
SHA-256 with `Observatory.deviceTokenHash`, and a null hash admits no agent.

DV-120 registers a partner observatory with that hash null, on purpose. Nothing then set
it. The development seed was the only writer, so a partner could register, be approved and
install the agent (DV-123), and never connect. ADR-013's emergency stop -- "revoke its token
in one row" -- existed only as a database edit.

## Decision

1. **Only an operator issues, rotates or revokes.** The token is what lets a telescope
   somebody else owns onto the network, so issuing one is an operator act, like approval.
   The owner receives it from the operator.

2. **A token can be issued at any approval state.** The owner needs a connected agent for
   `setup --check`, for the supervised first light and for proving Park, all of which come
   before approval. A token grants a connection, not operation: nothing is operated on a
   node that is not APPROVED.

3. **Shown once, stored hashed.** The token is in the issue or rotate response and nowhere
   else. Only its SHA-256 is stored -- the value the link service already compares -- and no
   audit row, log or later read carries it.

4. **Issue refuses when a token exists; rotate refuses when none does.** Two operators
   issuing at once cannot silently replace each other's token, and replacing one is always a
   named act.

5. **Rotate and revoke take effect on the live link.** A token is checked only at the
   handshake, so the same transaction notifies the realtime service (`CREDENTIAL`, ADR-009),
   which closes that observatory's link. An agent holding the old token cannot reconnect.

6. **Revoke is an emergency stop.** Never refused -- revoking a node with no token succeeds
   -- and never metered, following Park and suspension (DV-115). A live mission on the node
   is cancelled through the operator cancel path, as suspension does.

7. **Every change is audited with the operator's reason**, and appears in the node's
   review history.

## Alternatives considered

**The owner issues their own token.** Declined: it would let anybody who registers put an
agent on the network without an operator ever acting.

**No token until approval.** Declined: approval requires a supervised first light and Park
proven on the hardware, which need a connected agent.

## Consequences

- Three operator operations under `/admin/network/nodes/{nodeId}/device-token`.
- `darkview-clients` copies the spec; its operator console gains the actions.
- The development seed's fixed token is unchanged and development-only.
