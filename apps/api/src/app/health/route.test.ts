import { describe, expect, it } from "vitest";

import { zGetServiceHealthResponse } from "@darkview/contracts/zod";

import { GET } from "./route";

/** SR-13: the route answers exactly what the contract now declares, and no more. */
describe("GET /health", () => {
  it("matches the contract's ServiceHealth", async () => {
    const body = await GET().json();
    expect(zGetServiceHealthResponse.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "service", "status"]);
  });
});
