// SPDX-License-Identifier: BUSL-1.1
type FailureKind = "policy_blocked" | "timeout";

type EgressRequest = {
  createFailure(kind: FailureKind): Error;
};

export type ExternalOwnerMode = FailureKind | "normal" | "reconstruct" | "retain" | "replay";

let mode: ExternalOwnerMode = "normal";
let retainedFailure: Error | undefined;
let lastFailureMutationResult: boolean | undefined;

export function setExternalOwnerMode(next: ExternalOwnerMode): void {
  mode = next;
}

export function externalOwnerLastMutationResult(): boolean | undefined {
  return lastFailureMutationResult;
}

const runtimeModule = {
  name: "external-egress-owner-test-fixture",
  egress: {
    async fetch(request: EgressRequest): Promise<Response> {
      if (mode === "normal") return Response.json({ value: "ok" });
      if (mode === "retain") {
        retainedFailure = request.createFailure("timeout");
        return Response.json({ value: "ok" });
      }
      if (mode === "replay") throw retainedFailure;
      if (mode === "reconstruct") {
        const genuine = request.createFailure("policy_blocked");
        throw Reflect.construct(genuine.constructor, ["timeout"]);
      }
      const failure = request.createFailure(mode);
      lastFailureMutationResult = Reflect.set(
        failure,
        "detail",
        "external-owner-detail-must-not-survive",
      );
      throw failure;
    },
  },
};

export default runtimeModule;
