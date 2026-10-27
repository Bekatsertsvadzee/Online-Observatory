import "server-only";

import type { ScheduleTestMissionRequest, TestMission } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import type { AdminFailure } from "@/features/admin/observatory";
import { isSlotConflict } from "@/features/booking/reserve";
import { realHardwareAllowedInDemo } from "@/lib/deployment";
import { getDatabase } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/validation/env";

export type TestMissionResult = { ok: true; testMission: TestMission } | AdminFailure;

/**
 * POST /admin/observatories/{observatoryId}/test-mission (ADR-075).
 *
 * The hardware test observatory cannot be booked, so an operator schedules a mission
 * on it for themselves: a CONFIRMED booking at no price starting now, and its
 * SCHEDULED mission. Starting it is POST /missions/{id}/start, unchanged, so every
 * check a customer's session meets is met here too.
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
      networkNode: { select: { approvalStatus: true } },
      telescopes: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
    },
  });
  if (!observatory) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such observatory." };
  }

  const hardwareTestId = getServerEnvironment().DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID;
  if (!realHardwareAllowedInDemo(observatory.id, hardwareTestId)) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "Only the hardware test observatory takes an operator's test mission.",
    };
  }
  // A customer's time is sold through a booking; an operator does not take it.
  if (observatory.networkNode?.approvalStatus === "APPROVED") {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "This observatory can be booked. Book it like a customer instead.",
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

  const compatible = await database.targetObservatory.findFirst({
    where: { observatoryId, targetId: request.targetId },
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

  // Whole minutes, so the session's start check (now >= slot start) passes at once.
  const slotStartAt = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000);
  const simulated = observatory.mode === "SIMULATED";

  try {
    const testMission = await database.$transaction(async (tx) => {
      const mission = await tx.mission.create({
        data: {
          userId: actorUserId,
          targetId: request.targetId,
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
          targetId: request.targetId,
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
          },
        },
        tx,
      );

      return {
        bookingId: booking.id,
        missionId: mission.id,
        observatoryId,
        targetId: request.targetId,
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
