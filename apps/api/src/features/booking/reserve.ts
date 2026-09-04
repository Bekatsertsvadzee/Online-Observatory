import "server-only";

import type {
  Booking as ContractBooking,
  BookingWithPaymentIntent,
  CreateBookingRequest,
  ErrorCode,
  PaymentIntent,
} from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { nightWindow } from "@/lib/slots/darkness";
import { generateSlots, SLOT_DURATION_MINUTES } from "@/lib/slots/generate";

/**
 * PROVISIONAL. How long a reserved slot is held while payment is outstanding.
 *
 * No controlling document sets a hold window, so this is a judgement and not a
 * commercial decision: long enough for a customer to finish a bank redirect on a
 * phone with poor signal, short enough that an abandoned checkout does not take a
 * half hour of a short winter night off sale.
 *
 * It is deliberately not a payment-provider timeout. No provider has been chosen
 * (DV-056), and slot inventory must not wait on one. Revisit it against the
 * provider's real redirect behaviour once that exists.
 */
export const PAYMENT_HOLD_MINUTES = 15;

/**
 * Phase 1 has one payment provider in code and it is the sandbox. The real
 * provider arrives in DV-056 with its own documentation; nothing here invents an
 * API for it. The environment check lives at the route boundary, not here, so
 * that this module stays a pure domain function.
 */
const PHASE_1_PROVIDER = "SANDBOX" as const;

export type ReserveSlotFailure = {
  ok: false;
  status: 404 | 409 | 422;
  code: ErrorCode;
  message: string;
};

export type ReserveSlotSuccess = {
  ok: true;
  body: BookingWithPaymentIntent;
  /** True when an idempotency key returned an existing booking rather than making one. */
  replayed: boolean;
};

export type ReserveSlotResult = ReserveSlotSuccess | ReserveSlotFailure;

type BookingRow = {
  id: string;
  userId: string;
  targetId: string;
  slotStartAt: Date;
  durationMinutes: number;
  status: string;
  priceMinor: number;
  currency: string;
  paymentId: string | null;
  missionId: string | null;
  holdExpiresAt: Date | null;
  createdAt: Date;
};

type PaymentRow = {
  id: string;
  provider: string;
  status: string;
  redirectUrl: string | null;
};

function toContractBooking(row: BookingRow): ContractBooking {
  return {
    id: row.id,
    userId: row.userId,
    targetId: row.targetId,
    slotStartAt: row.slotStartAt.toISOString(),
    durationMinutes: row.durationMinutes,
    status: row.status as ContractBooking["status"],
    priceMinor: row.priceMinor,
    currency: row.currency as ContractBooking["currency"],
    paymentId: row.paymentId,
    missionId: row.missionId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPaymentIntent(payment: PaymentRow, expiresAt: Date | null): PaymentIntent {
  return {
    paymentId: payment.id,
    provider: payment.provider as PaymentIntent["provider"],
    status: payment.status as PaymentIntent["status"],
    redirectUrl: payment.redirectUrl,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

/** The observatory's local calendar date at an instant, as YYYY-MM-DD. */
function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function previousDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const before = new Date(Date.UTC(year, month - 1, day - 1));
  return before.toISOString().slice(0, 10);
}

/**
 * Expire every hold at this observatory that has run out of time.
 *
 * Locking the rows first is what makes this safe to run from several requests at
 * once: the losers block, then re-read, and update nothing. It deliberately does
 * *not* lock the slot itself -- there is no slot row to lock, and inventing one
 * to serialise on would move exclusivity out of the index and into the
 * application, which is exactly what DV-055 forbids.
 */
async function expireLapsedHolds(
  tx: {
    $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
    $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  },
  observatoryId: string,
  now: Date,
): Promise<void> {
  const lapsed = (await tx.$queryRaw`
    SELECT "id" FROM "Booking"
    WHERE "observatoryId" = ${observatoryId}::uuid
      AND "status" = 'PENDING_PAYMENT'
      AND "holdExpiresAt" <= ${now}
    FOR UPDATE
  `) as { id: string }[];

  if (lapsed.length === 0) return;

  await tx.$executeRaw`
    UPDATE "Booking"
    SET "status" = 'EXPIRED', "updatedAt" = ${now}
    WHERE "id" = ANY(${lapsed.map((row) => row.id)}::uuid[])
  `;
}

/**
 * Reserve one slot and open a payment intent for it.
 *
 * The exclusivity guarantee is the partial unique index
 * `Booking_held_slot_unique`, and nothing else. There is no "is this slot taken?"
 * query before the insert on purpose: such a check cannot be correct under
 * concurrency, and having one would let the reservation appear to work after the
 * index was dropped. Two simultaneous requests both insert; Postgres rejects one;
 * that rejection is the 409.
 */
export async function reserveSlot(input: {
  userId: string;
  request: CreateBookingRequest;
  idempotencyKey: string | null;
  now: Date;
}): Promise<ReserveSlotResult> {
  const database = getDatabase();
  const { userId, request, idempotencyKey, now } = input;

  if (idempotencyKey) {
    const existing = await replayByIdempotencyKey(userId, idempotencyKey);
    if (existing) return existing;
  }

  // Phase 1 is one observatory. When there is more than one this takes an id.
  const observatory = await database.observatory.findFirst({
    include: { weatherState: true },
    orderBy: { createdAt: "asc" },
  });

  if (!observatory) {
    return {
      ok: false,
      status: 409,
      code: "OBSERVATORY_OFFLINE",
      message: "No observatory is configured.",
    };
  }

  const target = await database.target.findUnique({ where: { id: request.targetId } });
  if (!target || !target.enabled) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "No such target.",
    };
  }

  const slotStartAt = new Date(request.slotStartAt);
  if (Number.isNaN(slotStartAt.getTime())) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "`slotStartAt` is not a valid instant.",
    };
  }

  const slot = findGeneratedSlot(slotStartAt, observatory, now);

  if (!slot) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message:
        "That instant is not a slot this observatory offers. Slots come from " +
        "GET /slots and start on the grid inside astronomical darkness.",
    };
  }

  if (slot.durationMinutes !== request.durationMinutes) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: `Slots are ${slot.durationMinutes} minutes.`,
    };
  }

  // The generator reports why a slot cannot be sold. ALREADY_BOOKED can never
  // appear here -- findGeneratedSlot passes no booked set, because whether the
  // slot is taken is the index's answer to give, below, and not this function's.
  switch (slot.unavailableReason) {
    case "IN_THE_PAST":
      return {
        ok: false,
        status: 409,
        code: "SLOT_UNAVAILABLE",
        message: "That slot has already started.",
      };
    case "WEATHER_HOLD":
      return {
        ok: false,
        status: 409,
        code: "WEATHER_HOLD",
        message: "The observatory is on weather hold for that night.",
      };
    case "OBSERVATORY_OFFLINE":
      return {
        ok: false,
        status: 409,
        code: "OBSERVATORY_OFFLINE",
        message: "The observatory is offline.",
      };
    default:
      break;
  }

  const telescope = await database.telescope.findFirst({
    where: { observatoryId: observatory.id },
    orderBy: { createdAt: "asc" },
  });

  if (!telescope) {
    return {
      ok: false,
      status: 409,
      code: "OBSERVATORY_OFFLINE",
      message: "The observatory has no telescope configured.",
    };
  }

  const holdExpiresAt = new Date(now.getTime() + PAYMENT_HOLD_MINUTES * 60_000);

  try {
    const created = await database.$transaction(async (tx) => {
      await expireLapsedHolds(
        tx as unknown as Parameters<typeof expireLapsedHolds>[0],
        observatory.id,
        now,
      );

      const payment = await tx.payment.create({
        data: {
          userId,
          provider: PHASE_1_PROVIDER,
          status: "PENDING",
          amountMinor: slot.priceMinor,
          currency: slot.currency,
          isDemo: observatory.isDemo,
        },
      });

      const booking = await tx.booking.create({
        data: {
          userId,
          targetId: target.id,
          observatoryId: observatory.id,
          telescopeId: telescope.id,
          paymentId: payment.id,
          slotStartAt,
          durationMinutes: slot.durationMinutes,
          status: "PENDING_PAYMENT",
          holdExpiresAt,
          priceMinor: slot.priceMinor,
          currency: slot.currency,
          idempotencyKey,
          isDemo: observatory.isDemo,
        },
      });

      return { booking, payment };
    });

    return {
      ok: true,
      replayed: false,
      body: {
        booking: toContractBooking(created.booking as BookingRow),
        paymentIntent: toPaymentIntent(created.payment as PaymentRow, holdExpiresAt),
      },
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Either index can be the one that fired. Rather than parse a constraint name
    // out of a driver error, ask the question that separates the two cases: if this
    // user already holds a booking under this key, the request was a retry that
    // raced its own first attempt, and the answer is that booking. Otherwise the
    // slot went to someone else.
    if (idempotencyKey) {
      const existing = await replayByIdempotencyKey(userId, idempotencyKey);
      if (existing) return existing;
    }

    return {
      ok: false,
      status: 409,
      code: "SLOT_UNAVAILABLE",
      message: "That slot has just been taken.",
    };
  }
}

async function replayByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<ReserveSlotSuccess | null> {
  const database = getDatabase();

  const booking = await database.booking.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    include: { payment: true },
  });

  if (!booking || !booking.payment) return null;

  return {
    ok: true,
    replayed: true,
    body: {
      booking: toContractBooking(booking as BookingRow),
      paymentIntent: toPaymentIntent(
        booking.payment as PaymentRow,
        booking.holdExpiresAt,
      ),
    },
  };
}

/**
 * The slot the requested instant names, if the observatory offers one there.
 *
 * A slot at 02:00 local belongs to the night that began the previous evening, so
 * both candidate dates are generated and searched. No booked set is passed: this
 * answers "is this a real slot?", never "is it free?".
 */
function findGeneratedSlot(
  slotStartAt: Date,
  observatory: {
    timezone: string;
    latitude: number;
    longitude: number;
    status: string;
    weatherState: { holdActive: boolean } | null;
  },
  now: Date,
) {
  const site = {
    latitudeDegrees: observatory.latitude,
    longitudeDegrees: observatory.longitude,
  };

  const observatoryState = {
    online: observatory.status === "ONLINE",
    weatherHold: observatory.weatherState?.holdActive ?? false,
  };

  const on = localDate(slotStartAt, observatory.timezone);

  for (const date of [previousDate(on), on]) {
    const window = nightWindow(date, observatory.timezone, site);
    if (!window) continue;

    const match = generateSlots({
      window,
      now,
      observatory: observatoryState,
      bookedStartAt: new Set(),
    }).find((slot) => Date.parse(slot.startAt) === slotStartAt.getTime());

    if (match) return match;
  }

  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * A payment that did not succeed gives the slot back.
 *
 * DV-055 acceptance criterion 4. The booking leaves the partial unique index the
 * moment its status changes, so the slot is on sale again in the same
 * transaction; no sweeper has to notice. No mission is created here, and this
 * refuses to run if one somehow exists -- a mission means the observation was
 * already scheduled, and unwinding that is an operator decision, not a callback's.
 */
export async function releaseSlotForFailedPayment(input: {
  bookingId: string;
  reason: string;
  now: Date;
}): Promise<{ released: boolean }> {
  const database = getDatabase();

  return database.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: input.bookingId },
      select: { id: true, status: true, missionId: true, paymentId: true },
    });

    if (!booking) return { released: false };
    if (booking.status !== "PENDING_PAYMENT") return { released: false };

    if (booking.missionId) {
      throw new Error(
        `Booking ${booking.id} already has a mission; a failed payment may not unwind it.`,
      );
    }

    if (booking.paymentId) {
      await tx.payment.update({
        where: { id: booking.paymentId },
        data: { status: "FAILED", failureReason: input.reason },
      });
    }

    await tx.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED" },
    });

    return { released: true };
  });
}

export { SLOT_DURATION_MINUTES };
