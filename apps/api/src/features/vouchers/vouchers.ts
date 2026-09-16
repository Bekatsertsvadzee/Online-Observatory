import "server-only";

import { randomUUID } from "node:crypto";

import type {
  CreateGiftVoucherRequest,
  ErrorCode,
  GiftVoucher,
  GiftVoucherList,
  GiftVoucherWithPaymentIntent,
} from "@darkview/contracts";
import type { Prisma } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";
import { earnOnSettledPayment } from "@darkview/db/loyalty";
import { queueEmail } from "@darkview/db/notifications";
import {
  deriveVoucherCode,
  hashVoucherCode,
  voucherCodeLast4,
  voucherExpiry,
} from "@darkview/db/vouchers";

import type { PaymentOutcome } from "@/features/payments/provider";
import { getDatabase } from "@/lib/db/client";
import {
  PROVISIONAL_SLOT_PRICE_MINOR,
  SLOT_DURATION_MINUTES,
} from "@/lib/slots/generate";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * Gift vouchers (DV-112), maintainer decisions of 2026-09-16: a voucher pays for one
 * observation of a given length, valid for twelve months from payment, and a booking
 * uses at most one price reduction.
 *
 * Sold on the sandbox provider, like every other sale in Phase 1, and priced at
 * the PROVISIONAL slot price for its length. Redemption is in `reserveSlot`, where it
 * shares the reservation's transaction.
 */

/** As on bookings and packs: the sandbox is never sold against in production. */
const PHASE_1_PROVIDER = "SANDBOX" as const;

type Refusal = { ok: false; status: 422 | 500 | 503; code: ErrorCode; message: string };

type VoucherRow = {
  id: string;
  status: string;
  durationMinutes: number;
  priceMinor: number;
  currency: string;
  codeLast4: string;
  recipientEmail: string | null;
  recipientName: string | null;
  expiresAt: Date | null;
  redeemedBookingId: string | null;
  createdAt: Date;
};

export function toContractVoucher(row: VoucherRow, now: Date): GiftVoucher {
  const paid = row.status !== "PENDING_PAYMENT" && row.status !== "CANCELLED";
  const expired =
    row.status === "ACTIVE" && row.expiresAt !== null && row.expiresAt <= now;
  return {
    id: row.id,
    status: (expired ? "EXPIRED" : row.status) as GiftVoucher["status"],
    durationMinutes: row.durationMinutes,
    priceMinor: row.priceMinor,
    currency: row.currency as GiftVoucher["currency"],
    codeLast4: paid ? row.codeLast4 : null,
    recipientEmail: row.recipientEmail,
    recipientName: row.recipientName,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    redeemedBookingId: row.redeemedBookingId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function purchaseGiftVoucher(input: {
  userId: string;
  request: CreateGiftVoucherRequest;
  now: Date;
}): Promise<{ ok: true; body: GiftVoucherWithPaymentIntent } | Refusal> {
  const { userId, request, now } = input;
  const environment = getServerEnvironment();

  if (environment.NODE_ENV === "production") {
    return {
      ok: false,
      status: 500,
      code: "INTERNAL",
      message: "Gift vouchers are unavailable: no payment provider is configured.",
    };
  }
  if (!environment.VOUCHER_CODE_SECRET) {
    return {
      ok: false,
      status: 503,
      code: "INTERNAL",
      message: "Gift vouchers are not available on this deployment.",
    };
  }
  // Only a length a slot is sold at: a voucher nobody can spend is not a gift.
  if (request.durationMinutes !== SLOT_DURATION_MINUTES) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: `Vouchers are sold for ${SLOT_DURATION_MINUTES}-minute observations.`,
    };
  }

  const id = randomUUID();
  const code = deriveVoucherCode(environment.VOUCHER_CODE_SECRET, id);
  const priceMinor = PROVISIONAL_SLOT_PRICE_MINOR;

  const { voucher, payment } = await getDatabase().$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        userId,
        purpose: "GIFT_VOUCHER",
        provider: PHASE_1_PROVIDER,
        status: "PENDING",
        amountMinor: priceMinor,
      },
    });
    const voucher = await tx.giftVoucher.create({
      data: {
        id,
        buyerUserId: userId,
        paymentId: payment.id,
        codeHash: hashVoucherCode(code),
        codeLast4: voucherCodeLast4(code),
        durationMinutes: request.durationMinutes,
        priceMinor,
        recipientEmail: request.recipientEmail ?? null,
        recipientName: request.recipientName ?? null,
        message: request.message ?? null,
      },
    });
    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "GIFT_VOUCHER_ORDERED",
        actorUserId: userId,
        entityType: "GiftVoucher",
        entityId: voucher.id,
        detail: {
          paymentId: payment.id,
          durationMinutes: voucher.durationMinutes,
          priceMinor,
          currency: voucher.currency,
          toRecipient: voucher.recipientEmail !== null,
        },
      },
      tx,
    );
    return { voucher, payment };
  });

  return {
    ok: true,
    body: {
      voucher: toContractVoucher(voucher, now),
      paymentIntent: {
        paymentId: payment.id,
        provider: payment.provider,
        status: payment.status,
        redirectUrl: payment.redirectUrl,
        expiresAt: null,
      },
    },
  };
}

export async function listMyGiftVouchers(
  userId: string,
  now: Date,
): Promise<GiftVoucherList> {
  const rows = await getDatabase().giftVoucher.findMany({
    where: { buyerUserId: userId },
    orderBy: { createdAt: "desc" },
  });
  return { items: rows.map((row) => toContractVoucher(row, now)) };
}

/**
 * Apply a verified outcome to the voucher a payment bought. Called by
 * `settlePayment` after the checks every payment gets, inside its transaction and
 * under its payment lock, so a repeated callback has already been answered there.
 */
export async function settleGiftVoucherPayment(
  tx: Prisma.TransactionClient,
  payment: { id: string; userId: string; isDemo: boolean; provider: string; amountMinor: number },
  outcome: PaymentOutcome,
  now: Date,
): Promise<{ ok: true; applied: true; missionId: null }> {
  const voucher = await tx.giftVoucher.findUniqueOrThrow({
    where: { paymentId: payment.id },
    select: { id: true, status: true },
  });

  if (outcome.result === "FAILED") {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        providerRef: outcome.providerRef,
        failureReason: outcome.failureReason,
      },
    });
    await tx.giftVoucher.update({
      where: { id: voucher.id },
      data: { status: "CANCELLED" },
    });
    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "GIFT_VOUCHER_PAYMENT_FAILED",
        actorUserId: payment.userId,
        entityType: "GiftVoucher",
        entityId: voucher.id,
        detail: {
          provider: payment.provider,
          providerRef: outcome.providerRef,
          paymentId: payment.id,
          failureReason: outcome.failureReason,
        },
        isDemo: payment.isDemo,
      },
      tx,
    );
    return { ok: true, applied: true, missionId: null };
  }

  const expiresAt = voucherExpiry(now);
  await tx.payment.update({
    where: { id: payment.id },
    data: { status: "CAPTURED", providerRef: outcome.providerRef, capturedAt: now },
  });
  await tx.giftVoucher.update({
    where: { id: voucher.id },
    data: { status: "ACTIVE", expiresAt },
  });
  await recordAuditEvent(
    {
      category: "PAYMENT",
      action: "GIFT_VOUCHER_ISSUED",
      actorUserId: payment.userId,
      entityType: "GiftVoucher",
      entityId: voucher.id,
      detail: {
        provider: payment.provider,
        providerRef: outcome.providerRef,
        paymentId: payment.id,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        expiresAt: expiresAt.toISOString(),
      },
      isDemo: payment.isDemo,
    },
    tx,
  );
  await earnOnSettledPayment(tx, payment, null);
  await queueEmail(tx, {
    userId: payment.userId,
    kind: "GIFT_VOUCHER_ISSUED",
    dedupeKey: `gift-voucher-issued:${voucher.id}`,
    payload: { voucherId: voucher.id },
  });

  return { ok: true, applied: true, missionId: null };
}
