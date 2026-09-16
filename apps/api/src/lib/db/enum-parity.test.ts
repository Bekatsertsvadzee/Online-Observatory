import { describe, expect, it } from "vitest";

import * as contract from "@darkview/contracts";
import * as db from "@darkview/db/enums";

/**
 * contracts/openapi.yaml is the single source of truth for every payload crossing a
 * process boundary. Where the database stores one of those values, the Prisma enum
 * and the generated contract enum must agree exactly -- same members, same spelling.
 *
 * A divergence here is not cosmetic. It is a value the API can emit and the database
 * cannot store, or the reverse, discovered at runtime instead of in CI.
 */
const SHARED_ENUMS = [
  "AuditCategory",
  "BookingLossCause",
  "BookingStatus",
  "CaptureAssetKind",
  "CaptureVisibility",
  "CommandType",
  "Currency",
  "ForecastSource",
  "ImagingProfile",
  "Locale",
  "MissionEventSource",
  "MissionFailureReason",
  "MissionState",
  "ObservatoryMode",
  "ObserverPackStatus",
  "OpticalConfig",
  "PaymentProvider",
  "PaymentStatus",
  "SessionRole",
  "SlotUnavailableReason",
  "SolarSystemBody",
  "TargetPositionSource",
  "TargetType",
  "UserRole",
  "WeatherStatus",
] as const;

/**
 * Prisma enums with no contract counterpart. Each is internal to the database and
 * never crosses a process boundary, or belongs to the surface frozen by ADR-003.
 * Adding a name here is a decision, not a formality.
 */
const DATABASE_ONLY = new Set([
  "AuthEventType",
  "CaptureAccessStatus",
  "CollectionKind",
  "CreditLedgerReason",
  // DV-064: the email outbox. Read by the realtime service's dispatcher; no
  // client is told either value.
  "EmailNotificationKind",
  "EmailNotificationStatus",
  // DV-111: NONE is the database remembering a slot was evaluated. The contract's
  // BookingEntitlement.status carries the three values a customer is shown.
  "BookingEntitlementOutcome",
  // DV-112: EXPIRED is derived from expiresAt and never stored, so the contract's
  // GiftVoucherStatus has one value the database does not.
  "GiftVoucherStatus",
  "EquipmentStatus",
  "MissionJoinPolicy",
  "MissionParticipantStatus",
  "MissionSharingMode",
  "NetworkNodeApprovalStatus",
  "NetworkNodeKind",
  "ObservatoryCommandStatus",
  "ObservatoryStatus",
  // What a payment bought. The settlement path reads it; no client is told,
  // and PaymentIntent is the same shape either way.
  "PaymentPurpose",
  "PrivateSessionStatus",
  "ProcessingPreset",
  "SubscriptionPlan",
  "SubscriptionStatus",
]);

const members = (enumObject: Record<string, string>) =>
  Object.values(enumObject).sort();

describe("Prisma enums match the contract", () => {
  it.each(SHARED_ENUMS)("%s has identical members", (name) => {
    const fromDb = db[name as keyof typeof db];
    const fromContract = contract[name as keyof typeof contract];

    expect(fromDb, `${name} is missing from the Prisma schema`).toBeDefined();
    expect(fromContract, `${name} is missing from the contract`).toBeDefined();

    expect(members(fromDb as Record<string, string>)).toEqual(
      members(fromContract as Record<string, string>),
    );
  });

  it("accounts for every Prisma enum", () => {
    const prismaEnums = Object.keys(db).filter(
      (key) => typeof db[key as keyof typeof db] === "object",
    );
    const accounted = new Set<string>([...SHARED_ENUMS, ...DATABASE_ONLY]);
    const unaccounted = prismaEnums.filter((name) => !accounted.has(name));

    expect(
      unaccounted,
      "a new Prisma enum must be declared shared with the contract or database-only",
    ).toEqual([]);
  });
});
