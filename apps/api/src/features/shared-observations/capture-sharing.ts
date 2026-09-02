import "server-only";

import { getDatabase } from "@/lib/db/client";

export async function grantSharedCaptureAccess(captureId: string) {
  const database = getDatabase();
  const capture = await database.capture.findUnique({
    where: { id: captureId },
    include: {
      mission: {
        include: {
          participants: {
            where: { status: "JOINED", canSaveCaptures: true },
            select: { userId: true, isDemo: true },
          },
        },
      },
    },
  });

  if (!capture || capture.missionId !== capture.mission.id) return 0;
  if (!capture.mission.allowSharedCaptures) return 0;

  const eligibleParticipants = capture.mission.participants.filter(
    (participant) => participant.userId !== capture.userId,
  );
  if (eligibleParticipants.length === 0) return 0;

  const result = await database.captureAccess.createMany({
    data: eligibleParticipants.map((participant) => ({
      captureId: capture.id,
      missionId: capture.missionId,
      userId: participant.userId,
      isDemo: capture.isDemo || participant.isDemo,
    })),
    skipDuplicates: true,
  });

  return result.count;
}
