// SPDX-License-Identifier: BUSL-1.1
import { HttpError } from "../rest/http-error.js";

/** Only a refresh that requires new authorization may become a consent handoff. */
export async function connectRefreshOutcome(refresh: () => Promise<unknown>): Promise<"connected" | "reauthorize"> {
  try {
    await refresh();
    return "connected";
  } catch (error) {
    if (error instanceof HttpError && error.code === "REAUTHORIZATION_REQUIRED") return "reauthorize";
    throw error;
  }
}
