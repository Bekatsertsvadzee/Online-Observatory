# Darkview observatory network: future architecture

## Current scope

Darkview currently represents one active site: **Darkview Tbilisi Observatory**. It is a first-party node operated by Darkview. No external observatory partner is represented as active, approved, or available for booking.

The `/network` page describes a future reviewed partner program. It is not a telescope marketplace, partner application form, hardware auto-discovery service, or payment product.

## Data model foundation

`ObservatoryNetworkNode` connects the network-specific approval layer to existing physical records:

| Concern                          | Current model                           |
| -------------------------------- | --------------------------------------- |
| Responsible owner                | `ObservatoryNetworkNode.ownerId → User` |
| Physical site and coordinates    | `observatoryId → Observatory`           |
| Primary telescope                | `primaryTelescopeId → Telescope`        |
| First-party or partner operation | `kind`                                  |
| Review state                     | `approvalStatus`, `approvedAt`          |
| Declared observing capability    | `capabilities`                          |
| Recurring supply windows         | `NetworkAvailabilityWindow`             |
| Existing reservations            | `Reservation`                           |

Coordinates remain on `Observatory`, equipment remains on `Telescope` and `Camera`, and mission provenance continues to reference the exact observatory and telescope used. This avoids duplicating physical configuration inside the network layer.

Availability windows describe when a node may accept work. They do not guarantee that a target is safe or visible. Final mission eligibility must still be calculated from local weather, target altitude, Sun avoidance, equipment state, existing reservations, and the observatory's configured limits.

Commission and payment terms are deliberately absent from the production node schema. If a commercial partner program is approved later, it should use a separate, versioned agreement model with effective dates, currency, settlement rules, tax identity, and audit history. Commercial terms must never weaken safety or mission authorization.

## Manual partner review

A future partner node should move through explicit states:

1. `DRAFT` — an internal record exists but cannot receive missions.
2. `UNDER_REVIEW` — Darkview is verifying ownership, site identity, equipment, software integration, and operating procedures.
3. `APPROVED` — the node may be considered by the scheduler when it is otherwise ready and available.
4. `SUSPENDED` — the node is excluded from new scheduling while an operational, safety, or compliance issue is reviewed.

Approval is a manual Darkview operator decision. A submitted record, detected telescope, or successful network request must never approve a node automatically.

Before approval, Darkview should verify:

- the responsible owner and physical site;
- geographic coordinates and timezone;
- telescope, camera, enclosure, and local computer configuration;
- supported target classes and imaging limits;
- recurring availability and maintenance exclusions;
- a documented server-side `ObservatoryAdapter` implementation;
- local safety enforcement and loss-of-connection behavior;
- command idempotency, mission leases, telemetry, event provenance, and audit logging.

Browser clients must never receive partner telescope credentials or communicate directly with partner hardware.

## Future scheduling flow

Scheduling across independent observatories can remain an extension of the existing mission model:

1. **Describe the mission.** Resolve the target, requested duration, observation quality threshold, processing requirement, and acceptable time range.
2. **Find eligible nodes.** Query only `APPROVED` nodes, then filter by declared capabilities, compatible telescope/camera configuration, geographic visibility, altitude, Sun avoidance, readiness, and availability windows.
3. **Rank candidates.** Rank eligible nodes using expected visibility, altitude, weather confidence, equipment suitability, queue pressure, and manually configured quality. Commercial terms should not override safety or minimum quality.
4. **Reserve atomically.** Create a reservation against one observatory and telescope while checking for conflicts. A database transaction or equivalent scheduling lock must prevent double-booking.
5. **Confirm locally.** Before mission start, ask the node adapter for current readiness. A configured availability window is not proof that hardware is online.
6. **Issue a protected mission lease.** Bind the mission, user, node, telescope, and expiration. Only the mission owner or an authorized operator may request telescope-affecting commands.
7. **Execute through the adapter.** The cloud sends expiring, idempotent commands to the selected node's server-side adapter. The browser remains a viewing and request interface.
8. **Record provenance.** Mission events and captures retain the selected observatory, telescope, command IDs, timestamps, simulator/real source, and audit records.

If a node becomes unavailable before execution, the scheduler may release the reservation and evaluate another eligible node. An active hardware mission should not be silently moved between observatories. Reassignment must create a clear new reservation and event history so users and operators can see what changed.

## Availability and exceptions

Recurring `NetworkAvailabilityWindow` records are the baseline. A production scheduler will eventually also need dated exceptions for maintenance, weather holds, private sessions, operator blocks, and site-specific closures. Those exceptions should be introduced when real multi-site scheduling begins rather than guessed now.

All availability input must be validated at the server boundary:

- weekday must be within the supported calendar range;
- start and end minutes must be valid local-day values;
- overlapping windows should be normalized or rejected;
- the observatory timezone controls conversion to UTC;
- reservations remain the source of truth for occupied intervals.

## What is intentionally not implemented

- no external partner accounts or application workflow;
- no automatic CPWI, ASCOM, Alpaca, or device discovery onboarding;
- no public telescope listings, bidding, or marketplace search;
- no partner prices, commissions, payouts, invoices, or payment processing;
- no automatic approval based on self-reported capabilities;
- no browser-to-hardware credentials or unrestricted mount controls.

The next implementation step should happen only after a real candidate observatory, documented hardware API, operating agreement, and review process are available.
