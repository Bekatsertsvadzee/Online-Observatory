import "server-only";

import type { ScheduleTestMissionRequest, TestMission } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import type { AdminFailure } from "@/features/admin/observatory";
import { isSlotConflict } from "@/features/booking/reserve";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { realHardwareAllowedInDemo } from "@/lib/deployment";
import { getDatabase } from "@/lib/db/client";
import { horizontalAirlessOf } from "@/lib/ephemeris/engine";
import { equatorialFor } from "@/lib/ephemeris/visibility";
import { evaluatePointing, isMeasured } from "@/lib/safety/envelope";
import { loadSafetyEnvelope, siteOf } from "@/lib/safety/store";
import { getServerEnvironment } from "@/lib/validation/env";

export type TestMissionResult = { ok: true; testMission: TestMission } | AdminFailure;

/**
 * POST /admin/observatories/{observatoryId}/test-mission (ADR-075, amended by ADR-082).
 *
 * An operator's own session, free, starting now: a CONFIRMED booking at no price and
 * its SCHEDULED mission, on the hardware test observatory or any first-party one.
 * Starting it is POST /missions/{id}/start, unchanged, so every check a customer's
 * session meets is met here too. A customer's booking still holds its time: the
 * slot exclusion refuses an overlap with 409.
 *
 * With no target, the brightest one the observatory may point at now is chosen. An
 * operator whose own session here is already live gets that one back, so opening
 * the telescope twice lands in the same room.
 */
export async function scheduleTestMission(input: {
  observatoryId: string;
  request: ScheduleTestMissionRequest;
  actorUserId: string;
  now: Date;
}): Promise<TestMissionResult> {
  const { observatoryId, request, actorUserId } = input;
  const database = getDatabase();

  const observatory = await database.observatory.findUnique({
    where: { id: observatoryId },
    select: {
      id: true,
      mode: true,
      isDemo: true,
      latitude: true,
      longitude: true,
      networkNode: { select: { kind: true } },
      telescopes: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
    },
  });
  if (!observatory) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such observatory." };
  }

  const hardwareTestId = getServerEnvironment().DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID;
  if (
    !realHardwareAllowedInDemo(observatory.id, hardwareTestId) &&
    observatory.networkNode?.kind !== "FIRST_PARTY"
  ) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "An operator's own session runs only on an observatory Stellar runs.",
    };
  }

  const live = await database.booking.findFirst({
    where: {
      observatoryId,
      userId: actorUserId,
      status: "CONFIRMED",
      priceMinor: 0,
      mission: { state: { in: [...LIVE_MISSION_STATES] } },
    },
    orderBy: { slotStartAt: "desc" },
  });
  if (
    live?.missionId &&
    live.slotStartAt.getTime() + live.durationMinutes * 60_000 > input.now.getTime()
  ) {
    return {
      ok: true,
      testMission: {
        bookingId: live.id,
        missionId: live.missionId,
        observatoryId,
        targetId: live.targetId,
        slotStartAt: live.slotStartAt.toISOString(),
        durationMinutes: live.durationMinutes,
        mode: observatory.mode,
      },
    };
  }

  const telescope = observatory.telescopes[0];
  if (!telescope) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "This observatory has no telescope.",
    };
  }

  let targetId = request.targetId;
  if (targetId === undefined) {
    const best = await brightestTargetUpNow(observatory, input.now);
    if (!best) {
      return {
        ok: false,
        status: 409,
        code: "SAFETY_REFUSED",
        message: "Nothing this observatory can observe is above its limits now.",
      };
    }
    targetId = best;
  } else {
    const compatible = await database.targetObservatory.findFirst({
      where: { observatoryId, targetId },
      select: { targetId: true },
    });
    if (!compatible) {
      return {
        ok: false,
        status: 422,
        code: "VALIDATION_FAILED",
        message: "This observatory cannot observe that target.",
      };
    }
  }

  // Whole minutes, so the session's start check (now >= slot start) passes at once.
  const slotStartAt = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000);
  const simulated = observatory.mode === "SIMULATED";

  try {
    const testMission = await database.$transaction(async (tx) => {
      // A new test mission replaces this operator's own that never started. A start
      // refused (target low, MAX_ALT_SAFE unmeasured, agent offline) would otherwise
      // hold the telescope for its whole length and refuse every retry with a 409.
      const unstarted = await tx.booking.findMany({
        where: {
          observatoryId,
          userId: actorUserId,
          status: "CONFIRMED",
          mission: { state: "SCHEDULED" },
        },
        select: { id: true, missionId: true },
      });
      for (const old of unstarted) {
        await tx.booking.update({ where: { id: old.id }, data: { status: "CANCELLED" } });
        if (!old.missionId) continue;
        await tx.mission.update({
          where: { id: old.missionId },
          data: {
            state: "CANCELLED",
            failureReason: "OPERATOR_ABORT",
            completedAt: input.now,
          },
        });
        await tx.missionEvent.create({
          data: {
            missionId: old.missionId,
            state: "CANCELLED",
            failureReason: "OPERATOR_ABORT",
            source: "OPERATOR",
            message: "Replaced by the operator's next test mission before it started.",
            occurredAt: input.now,
            simulated,
            isDemo: observatory.isDemo,
          },
        });
      }

      const mission = await tx.mission.create({
        data: {
          userId: actorUserId,
          targetId,
          observatoryId,
          telescopeId: telescope.id,
          state: "SCHEDULED",
          mode: observatory.mode,
          isDemo: observatory.isDemo,
          requestedAt: input.now,
          scheduledFor: slotStartAt,
        },
      });
      await tx.missionEvent.create({
        data: {
          missionId: mission.id,
          state: "SCHEDULED",
          source: "CLOUD",
          message: "Scheduled by an operator on the hardware test observatory.",
          occurredAt: input.now,
          simulated,
          isDemo: observatory.isDemo,
        },
      });
      const booking = await tx.booking.create({
        data: {
          userId: actorUserId,
          targetId,
          observatoryId,
          telescopeId: telescope.id,
          missionId: mission.id,
          slotStartAt,
          durationMinutes: request.durationMinutes,
          status: "CONFIRMED",
          priceMinor: 0,
          isDemo: observatory.isDemo,
        },
      });
      await recordAuditEvent(
        {
          category: "MISSION",
          action: "MISSION_SCHEDULED",
          actorUserId,
          entityType: "Mission",
          entityId: mission.id,
          detail: {
            testMission: true,
            bookingId: booking.id,
            observatoryId,
            mode: observatory.mode,
            durationMinutes: request.durationMinutes,
            replacedBookingIds: unstarted.map((old) => old.id),
          },
        },
        tx,
      );

      return {
        bookingId: booking.id,
        missionId: mission.id,
        observatoryId,
        targetId,
        slotStartAt: slotStartAt.toISOString(),
        durationMinutes: request.durationMinutes,
        mode: observatory.mode,
      } satisfies TestMission;
    });
    return { ok: true, testMission };
  } catch (error) {
    if (!isSlotConflict(error)) throw error;
    return {
      ok: false,
      status: 409,
      code: "SLOT_UNAVAILABLE",
      message: "Another booking holds this observatory's time now.",
    };
  }
}

/**
 * The brightest enabled target this observatory can observe that is above its own
 * minimum altitude now and, once MAX_ALT_SAFE is measured, inside the envelope.
 */
async function brightestTargetUpNow(
  observatory: { id: string; latitude: number; longitude: number },
  now: Date,
) {
  const rows = await getDatabase().targetObservatory.findMany({
    where: { observatoryId: observatory.id, target: { enabled: true } },
    include: { target: true },
  });
  const site = siteOf(observatory);
  const config = await loadSafetyEnvelope(observatory.id);
  const measured = isMeasured(config);

  const up = rows
    .map(({ target }) => {
      const horizontal = horizontalAirlessOf(equatorialFor(target, now, site), now, site);
      return { target, horizontal };
    })
    .filter(
      ({ target, horizontal }) =>
        horizontal.altitudeDegrees >= target.minAltitudeDegrees &&
        (!measured ||
          evaluatePointing({
            config,
            site,
            at: now,
            altitudeDegrees: horizontal.altitudeDegrees,
            azimuthDegrees: horizontal.azimuthDegrees,
          }).permitted),
    )
    .sort((a, b) => a.target.magnitude - b.target.magnitude);
  return up[0]?.target.id;
}
