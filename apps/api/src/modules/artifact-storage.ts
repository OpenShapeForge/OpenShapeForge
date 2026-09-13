// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeArtifactDescriptor, RuntimeArtifactServices, RuntimeArtifactStorageContribution } from "@openshapeforge/plugin-runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strip provider-internal fields even when a faulty implementation adds them. */
function descriptor(value: RuntimeArtifactDescriptor): RuntimeArtifactDescriptor {
  if (!value || typeof value.artifactId !== "string" || !UUID.test(value.artifactId) ||
      !Number.isSafeInteger(value.version) || value.version < 1 ||
      typeof value.fileName !== "string" || !value.fileName || /[\r\n\0/\\]/.test(value.fileName) ||
      typeof value.mediaType !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value.mediaType) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.byteSize) || value.byteSize < 0) {
    throw operationFailure({ code: "HANDLER_CONTRACT_VIOLATION", message: "Stored file metadata could not be verified." });
  }
  return Object.freeze({ artifactId: value.artifactId, version: value.version, fileName: value.fileName,
    mediaType: value.mediaType, sha256: value.sha256, byteSize: value.byteSize });
}

/** Core-only composition and live-session fence around the private storage contribution. */
export class ArtifactStorageRuntime<Session, Transaction> {
  readonly services: RuntimeArtifactServices<Session>;
  #provider: RuntimeArtifactStorageContribution<Session, Transaction> | undefined;
  #configured = false;

  constructor(options: {
    acceptsSession(session: Session): boolean;
    currentTransaction(session: Session): Transaction | undefined;
    withTransaction<T>(session: Session, work: (transaction: Transaction) => Promise<T>): Promise<T>;
  }) {
    const provider = (session: Session) => {
      if (!options.acceptsSession(session)) throw operationFailure({ code: "FORBIDDEN", message: "File access requires the live verified session." });
      if (!this.#provider) throw operationFailure({ code: "STORAGE_UNAVAILABLE", message: "File storage is not configured." });
      return this.#provider;
    };
    const context = (session: Session) => ({ session,
      withTransaction: <T>(work: (transaction: Transaction) => Promise<T>) => {
        provider(session); // A retained context cannot outlive its request.
        return options.withTransaction(session, work);
      },
    });
    const owner = (input: { artifactId: string; documentVersionId: string }) => {
      if (!input || typeof input.artifactId !== "string" || typeof input.documentVersionId !== "string" || !UUID.test(input.artifactId) || !UUID.test(input.documentVersionId)) {
        throw operationFailure({ code: "VALIDATION", message: "The file or document version identifier is invalid." });
      }
    };
    this.services = Object.freeze<RuntimeArtifactServices<Session>>({
      stage: async (session, input) => descriptor(await provider(session).stage(context(session), input)),
      bind: async (session, input) => {
        const active = provider(session);
        owner(input);
        if (!Number.isSafeInteger(input.expectedArtifactVersion) || input.expectedArtifactVersion < 1) {
          throw operationFailure({ code: "VALIDATION", message: "The expected file version is invalid." });
        }
        const transaction = options.currentTransaction(session);
        if (!transaction) throw operationFailure({ code: "ARTIFACT_TRANSACTION_REQUIRED", message: "A file must be linked in the document version transaction." });
        const result = descriptor(await active.bind({ session, transaction }, input));
        if (result.artifactId !== input.artifactId) throw operationFailure({ code: "HANDLER_CONTRACT_VIOLATION", message: "The linked file identity does not match." });
        return result;
      },
      read: async (session, input) => {
        const active = provider(session);
        owner(input);
        const result = await active.read(context(session), input);
        const safe = descriptor(result.descriptor);
        if (safe.artifactId !== input.artifactId || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== safe.byteSize) {
          throw operationFailure({ code: "HANDLER_CONTRACT_VIOLATION", message: "The returned file does not match its stored descriptor." });
        }
        return { descriptor: safe, bytes: result.bytes };
      },
    });
  }

  configure(modules: readonly { name: string; artifactStorage?: RuntimeArtifactStorageContribution<Session, Transaction> }[], selectedProviderIds: readonly string[]): void {
    if (this.#configured) throw new Error("Artifact storage was already configured.");
    const candidates = modules.filter(module => module.artifactStorage !== undefined);
    if (candidates.length > 1) throw new Error("Only one runtime module may provide artifact storage.");
    if (selectedProviderIds.length > 1) throw new Error("Only one artifact storage provider may be selected.");
    if (selectedProviderIds.length && !candidates.length) throw new Error("Selected artifact storage provider is unavailable.");
    const contribution = candidates[0]?.artifactStorage;
    if (candidates.length) {
      if (!contribution) throw new Error("Artifact storage contribution is incomplete.");
      if (!contribution.providerId || contribution.providerId !== selectedProviderIds[0]) {
        throw new Error("Artifact storage contribution does not match the compiled provider selection.");
      }
      if ([contribution.stage, contribution.bind, contribution.read].some(method => typeof method !== "function")) {
        throw new Error("Artifact storage contribution is incomplete.");
      }
      this.#provider = Object.freeze({ providerId: contribution.providerId, stage: contribution.stage.bind(contribution),
        bind: contribution.bind.bind(contribution), read: contribution.read.bind(contribution) });
    }
    this.#configured = true;
  }
}
