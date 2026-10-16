import { zCastVoteBody, zListWeekVotesQuery } from "@darkview/contracts/zod";

import { castVote, readWeekVote, type WeekVoteRefusal } from "@/features/votes/week";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { getCurrentSession } from "@/lib/auth/session";
import { apiError } from "@/lib/http/api-error";

export const dynamic = "force-dynamic";

function refused(refusal: WeekVoteRefusal) {
  switch (refusal.kind) {
    case "not-found":
      // Unknown and not bookable are one answer, as on GET /slots.
      return apiError(404, "NOT_FOUND", "No such observatory.");
    case "not-monday":
      return apiError(422, "VALIDATION_FAILED", "`week` must be a Monday, YYYY-MM-DD.");
    case "locked":
      return apiError(409, "VOTE_LOCKED", "The week's ballot has locked.");
    case "not-a-candidate":
      return apiError(422, "TARGET_NOT_A_CANDIDATE", "That target is not on the week's ballot.");
  }
}

/**
 * GET /votes?observatoryId=&week= -- the week's ballot (ADR-050).
 *
 * Public: reading what is up for a vote needs no account. A session, when the
 * request carries one, adds the caller's own vote as `mine`.
 */
export async function GET(request: Request) {
  const query = zListWeekVotesQuery.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return apiError(422, "VALIDATION_FAILED", "`observatoryId` must be a UUID and `week` a date.");
  }

  const session = await getCurrentSession();
  const result = await readWeekVote({
    observatoryId: query.data.observatoryId,
    week: query.data.week,
    callerId: session?.user.id ?? null,
    now: new Date(),
  });
  if (!result.ok) return refused(result.refusal);
  return Response.json(result.vote);
}

/**
 * POST /votes -- cast, or move, the caller's vote for the week.
 *
 * Not public: a vote is one customer's, once, and the ballot's whole value is that
 * nobody has two. Same-origin, like every mutation (ADR-016 §3).
 */
export async function POST(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }
  const body = zCastVoteBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "CastVoteRequest is malformed.", {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const result = await castVote({
    ...body.data,
    userId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return refused(result.refusal);
  return Response.json(result.vote, { status: 201 });
}
