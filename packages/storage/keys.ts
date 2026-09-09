import type { CaptureAssetKind } from "@darkview/contracts";

/**
 * Where one capture asset lives in the bucket.
 *
 * **The cloud derives this. The agent never proposes it.** ADR-012 is explicit
 * about why: an agent that chose its own key could write outside its prefix, and
 * deriving it cloud-side is also what lets `CaptureAsset.storageKey` be trusted
 * when the capture is finally recorded.
 *
 * Every component is an identifier the cloud already holds. All three are UUIDs
 * and the kind is a closed enum, so nothing here can carry a separator, a `..`,
 * or anything else that would need escaping -- `assertKeyComponentsAreOpaque`
 * holds that true rather than leaving it as an observation.
 *
 * There is no file extension. The agent writes what it writes and the object's
 * content type travels with the object; inventing `.jpg` here would be this
 * module asserting a format it does not choose and cannot check.
 */
export function captureObjectKey(input: {
  observatoryId: string;
  missionId: string;
  commandId: string;
  kind: CaptureAssetKind;
}): string {
  assertKeyComponentsAreOpaque(input);

  return [
    "captures",
    input.observatoryId,
    input.missionId,
    input.commandId,
    input.kind,
  ].join("/");
}

/**
 * A UUID, and nothing that could be read as structure.
 *
 * The identifiers reaching here come from the database and from a contract that
 * declares them `format: uuid`, so this should never fire. It exists because the
 * cost of being wrong is an object written outside its prefix, and "should never"
 * is not a check.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertKeyComponentsAreOpaque(input: {
  observatoryId: string;
  missionId: string;
  commandId: string;
}) {
  for (const [name, value] of Object.entries(input)) {
    if (name === "kind") continue;
    if (!UUID.test(value)) {
      throw new Error(`Refusing to derive a storage key: ${name} is not a UUID.`);
    }
  }
}
