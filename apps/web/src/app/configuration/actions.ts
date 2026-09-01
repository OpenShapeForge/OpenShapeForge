// SPDX-License-Identifier: BUSL-1.1
"use server";

import { redirect } from "next/navigation";
import { getCachedSession } from "@/lib/cached-session";
import { buildGatewayUrl } from "@/lib/server/gateway";

export async function submitPendingConfiguration(
  formData: FormData,
): Promise<void> {
  const session = await getCachedSession();
  if (!session?.accessToken) {
    redirect("/login?callbackUrl=%2Fconfiguration");
  }
  const handoffId = formData.get("handoffId");
  if (typeof handoffId !== "string" || handoffId.length === 0) {
    redirect("/configuration?error=missing");
  }

  const body = new URLSearchParams();
  for (const [key, value] of formData.entries()) {
    if (key === "handoffId" || typeof value !== "string") continue;
    body.append(key, value);
  }
  const response = await fetch(
    buildGatewayUrl(
      `/api/entity-configuration/pending/${encodeURIComponent(handoffId)}`,
    ),
    {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  redirect(response.ok ? "/configuration?saved=1" : "/configuration?error=invalid");
}
