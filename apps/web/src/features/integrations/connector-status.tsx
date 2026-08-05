// SPDX-License-Identifier: BUSL-1.1
/**
 * How a connector's availability reads on screen.
 *
 * The five statuses are not five flavours of "not working" — each names a
 * different party who has to do something, and the page says which:
 *
 *   NOT_LICENSED     this deployment, or this tenant's grant
 *   NOT_INSTALLED    whoever ships the implementation package
 *   NOT_CONFIGURED   the operator reading this screen
 *   DISABLED         the operator, deliberately, earlier
 *   AVAILABLE        nobody
 *
 * A NOT_LICENSED connector is still LISTED. The catalog types are static so an
 * unlicensed deployment sees a row rather than a hole, and that is the point:
 * an operator can see what exists before buying it, which is why the row shows
 * its licence terms rather than pretending it is broken.
 */
import { Badge } from "@/components/ui/display/badge";
import type { ConnectorContractState, ConnectorStatus } from "./types";

type BadgeTone = "default" | "secondary" | "destructive" | "outline" | "success" | "warning";

const STATUS_TONE: Record<ConnectorStatus, BadgeTone> = {
  AVAILABLE: "success",
  DISABLED: "secondary",
  NOT_CONFIGURED: "warning",
  NOT_INSTALLED: "outline",
  NOT_LICENSED: "outline",
};

const STATUS_LABEL: Record<ConnectorStatus, Record<string, string>> = {
  AVAILABLE: { en: "Available", nl: "Beschikbaar" },
  DISABLED: { en: "Disabled", nl: "Uitgeschakeld" },
  NOT_CONFIGURED: { en: "Not configured", nl: "Niet geconfigureerd" },
  NOT_INSTALLED: { en: "Not installed", nl: "Niet geïnstalleerd" },
  NOT_LICENSED: { en: "Not licensed", nl: "Niet gelicentieerd" },
};

/** What an operator should do next, per status. */
export const STATUS_HINT: Record<ConnectorStatus, Record<string, string>> = {
  AVAILABLE: { en: "", nl: "" },
  DISABLED: {
    en: "Configured and switched off.",
    nl: "Geconfigureerd en uitgeschakeld.",
  },
  NOT_CONFIGURED: {
    en: "Ready to configure.",
    nl: "Klaar om te configureren.",
  },
  NOT_INSTALLED: {
    en: "Licensed, but this deployment ships no implementation package for it.",
    nl: "Gelicentieerd, maar deze omgeving levert er geen implementatiepakket voor.",
  },
  NOT_LICENSED: {
    en: "Not licensed for this deployment or not granted to this tenant.",
    nl: "Niet gelicentieerd voor deze omgeving of niet toegekend aan deze tenant.",
  },
};

export const CONTRACT_STATE_TONE: Record<ConnectorContractState, BadgeTone> = {
  CURRENT: "success",
  // Usable: the stored configuration still satisfies the contract. Blocking
  // every tenant on a help-text edit would make contract changes unshippable.
  CONTRACT_CHANGED: "secondary",
  NEEDS_REPAIR: "warning",
  INCOMPATIBLE: "destructive",
};

export function ConnectorStatusBadge({
  status,
  lang,
}: {
  status: ConnectorStatus;
  lang: string;
}) {
  const label = STATUS_LABEL[status];
  return (
    <Badge variant={STATUS_TONE[status]}>{label[lang] ?? label.en}</Badge>
  );
}
