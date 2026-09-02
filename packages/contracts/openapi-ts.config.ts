import { defineConfig } from "@hey-api/openapi-ts";

// Output path is overridable so `contracts:check` can generate into a scratch
// directory and diff, rather than mutating the committed artifacts.
export default defineConfig({
  input: "../../contracts/openapi.yaml",
  output: {
    path: process.env.DARKVIEW_CONTRACTS_OUT ?? "generated",
    postProcess: [],
  },
  plugins: [
    { name: "@hey-api/typescript", enums: "javascript" },
    { name: "zod", exportFromIndex: true },
  ],
});
