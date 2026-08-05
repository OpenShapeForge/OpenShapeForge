// SPDX-License-Identifier: BUSL-1.1
"use server";

import { signIn } from "@/lib/auth";

/**
 * Only same-origin, absolute-path callbacks survive. An open redirect on a
 * login form is a phishing primitive: the victim lands on a real, trusted
 * origin and is bounced somewhere else with the sign-in already in flight.
 */
function getSafeCallbackUrl(value: FormDataEntryValue | null): string {
  if (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("://")
  ) {
    return value;
  }

  return "/";
}

export async function signInWithKeycloak(formData: FormData) {
  await signIn("keycloak", {
    redirectTo: getSafeCallbackUrl(formData.get("callbackUrl")),
  });
}
