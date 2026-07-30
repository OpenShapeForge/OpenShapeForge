// SPDX-License-Identifier: BUSL-1.1
"use server";

import { signIn } from "@/lib/auth";

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
