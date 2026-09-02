"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isLocale } from "@/lib/locale";
import { csrfTokenIsValid, getCurrentSession } from "@/lib/auth/session";
import type { AuthenticatedUser } from "@/lib/auth/types";
import { getDatabase } from "@/lib/db/client";

import { authorizeSharedMission, canSaveSharedCapture } from "./domain";

const missionActionInput = z.object({
  missionId: z.uuid(),
  locale: z.string().refine(isLocale),
  csrfToken: z.string().min(1),
});

const captureActionInput = missionActionInput.extend({ captureId: z.string().min(1) });

async function getActionActor(input: unknown) {
  const parsed = missionActionInput.parse(input);
  const session = await getCurrentSession();
  if (!session || !csrfTokenIsValid(session, parsed.csrfToken)) {
    throw new Error("Unauthorized shared mission request.");
  }
  return { parsed, session };
}

async function getAuthorizedMission(missionId: string, actor: AuthenticatedUser) {
  const mission = await getDatabase().mission.findUnique({
    where: { id: missionId },
    select: {
      id: true,
      userId: true,
      state: true,
      sharingMode: true,
      joinPolicy: true,
      allowSharedCaptures: true,
      isDemo: true,
    },
  });
  if (!mission) throw new Error("Mission not found.");

  const authorization = authorizeSharedMission(actor, {
    id: mission.id,
    ownerId: mission.userId,
    state: mission.state,
    sharingMode: mission.sharingMode,
    joinPolicy: mission.joinPolicy,
    allowSharedCaptures: mission.allowSharedCaptures,
  });
  if (!authorization.canView) throw new Error("Mission is not available to watch.");

  return { mission, authorization };
}

export async function recordMissionPresenceAction(input: unknown) {
  const { parsed, session } = await getActionActor(input);
  await getAuthorizedMission(parsed.missionId, session.user);
  const now = new Date();
  const database = getDatabase();

  await database.missionPresence.upsert({
    where: {
      missionId_userId: { missionId: parsed.missionId, userId: session.user.id },
    },
    create: {
      missionId: parsed.missionId,
      userId: session.user.id,
      lastSeenAt: now,
    },
    update: { lastSeenAt: now, leftAt: null },
  });

  return {
    viewerCount: await database.missionPresence.count({
      where: {
        missionId: parsed.missionId,
        leftAt: null,
        lastSeenAt: { gte: new Date(now.getTime() - 60_000) },
      },
    }),
  };
}

export async function leaveMissionPresenceAction(input: unknown) {
  const { parsed, session } = await getActionActor(input);
  await getDatabase().missionPresence.updateMany({
    where: { missionId: parsed.missionId, userId: session.user.id },
    data: { leftAt: new Date() },
  });
}

export async function joinSharedMissionAction(input: unknown) {
  const { parsed, session } = await getActionActor(input);
  const { mission, authorization } = await getAuthorizedMission(
    parsed.missionId,
    session.user,
  );
  if (!authorization.canJoin) throw new Error("This mission cannot be joined.");

  const database = getDatabase();
  await database.$transaction(async (transaction) => {
    await transaction.missionParticipant.upsert({
      where: {
        missionId_userId: { missionId: mission.id, userId: session.user.id },
      },
      create: {
        missionId: mission.id,
        userId: session.user.id,
        status: "JOINED",
        canSaveCaptures: mission.allowSharedCaptures,
        isDemo: mission.isDemo,
      },
      update: {
        status: "JOINED",
        canSaveCaptures: mission.allowSharedCaptures,
        joinedAt: new Date(),
        leftAt: null,
      },
    });

    if (mission.allowSharedCaptures) {
      const captures = await transaction.capture.findMany({
        where: { missionId: mission.id, userId: { not: session.user.id } },
        select: { id: true, isDemo: true },
      });
      await transaction.captureAccess.createMany({
        data: captures.map((capture) => ({
          captureId: capture.id,
          missionId: mission.id,
          userId: session.user.id,
          isDemo: capture.isDemo || mission.isDemo,
        })),
        skipDuplicates: true,
      });
    }
  });

  const captureAccess = await database.captureAccess.findMany({
    where: { missionId: mission.id, userId: session.user.id, status: "AVAILABLE" },
    select: { captureId: true },
  });
  revalidatePath(`/${parsed.locale}/app/missions/${mission.id}/watch`);
  return {
    joined: true,
    saveableCaptureIds: captureAccess.map((access) => access.captureId),
  };
}

export async function leaveSharedMissionAction(input: unknown) {
  const { parsed, session } = await getActionActor(input);
  const now = new Date();
  const database = getDatabase();

  await database.$transaction([
    database.missionParticipant.updateMany({
      where: { missionId: parsed.missionId, userId: session.user.id },
      data: { status: "LEFT", leftAt: now },
    }),
    database.missionPresence.updateMany({
      where: { missionId: parsed.missionId, userId: session.user.id },
      data: { leftAt: now },
    }),
  ]);

  revalidatePath(`/${parsed.locale}/app/missions/${parsed.missionId}/watch`);
  return { joined: false };
}

export async function saveSharedCaptureAction(input: unknown) {
  const parsedCapture = captureActionInput.parse(input);
  const { session } = await getActionActor(parsedCapture);
  const database = getDatabase();
  const capture = await database.capture.findUnique({
    where: { id: parsedCapture.captureId },
    include: {
      mission: true,
      target: { select: { type: true, catalogId: true } },
      access: { where: { userId: session.user.id }, take: 1 },
    },
  });
  if (!capture || capture.missionId !== parsedCapture.missionId) {
    throw new Error("Capture not found.");
  }

  const participant = await database.missionParticipant.findUnique({
    where: {
      missionId_userId: {
        missionId: capture.missionId,
        userId: session.user.id,
      },
    },
  });
  const allowed = canSaveSharedCapture({
    actorId: session.user.id,
    mission: {
      id: capture.mission.id,
      ownerId: capture.mission.userId,
      state: capture.mission.state,
      sharingMode: capture.mission.sharingMode,
      joinPolicy: capture.mission.joinPolicy,
      allowSharedCaptures: capture.mission.allowSharedCaptures,
    },
    capture: { missionId: capture.missionId, ownerId: capture.userId },
    participant,
    access: capture.access[0] ?? null,
  });
  if (!allowed) throw new Error("Capture is not available to save.");

  const collectionKind =
    capture.target.type === "PLANET" || capture.target.type === "MOON"
      ? "SOLAR_SYSTEM"
      : capture.target.catalogId.startsWith("M")
        ? "MESSIER_STARTER"
        : "DEEP_SKY";
  const collectionNames = {
    SOLAR_SYSTEM: ["Solar System", "მზის სისტემა"],
    MESSIER_STARTER: ["Messier Starter", "მესიეს საწყისი კოლექცია"],
    DEEP_SKY: ["Deep Sky", "ღრმა ცა"],
  } as const;

  await database.$transaction(async (transaction) => {
    const collection = await transaction.collection.upsert({
      where: { userId_kind: { userId: session.user.id, kind: collectionKind } },
      create: {
        userId: session.user.id,
        kind: collectionKind,
        nameEn: collectionNames[collectionKind][0],
        nameKa: collectionNames[collectionKind][1],
        descriptionEn: "Captures saved from eligible Darkview missions.",
        descriptionKa: "Darkview-ის შესაბამისი მისიებიდან შენახული კადრები.",
        isDemo: capture.isDemo,
      },
      update: {},
    });
    await transaction.collectionCapture.upsert({
      where: {
        collectionId_captureId: { collectionId: collection.id, captureId: capture.id },
      },
      create: {
        collectionId: collection.id,
        captureId: capture.id,
        isDemo: capture.isDemo,
      },
      update: {},
    });
    await transaction.captureAccess.update({
      where: {
        captureId_userId: { captureId: capture.id, userId: session.user.id },
      },
      data: { status: "SAVED", savedAt: new Date() },
    });
  });

  revalidatePath(`/${parsedCapture.locale}/app/missions/${capture.missionId}/watch`);
  revalidatePath(`/${parsedCapture.locale}/app/collection`);
  return { saved: true, captureId: capture.id };
}
