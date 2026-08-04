// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * One installation: its configuration form, its state, and the actions on it.
 *
 * The form is assembled entirely from `configFields`, so this component has
 * never heard of AFAS, object storage, or whatever is authored next.
 *
 * ## Secrets take a different path on purpose
 *
 * A secret reads back as `__set__`, never as a value. If the save folded every
 * field into one `configureConnector` payload, a form that round-trips what it
 * read would store the literal string `__set__` as the credential — and the
 * next call would authenticate with it. So secrets are collected separately and
 * sent one at a time through `setConnectorSecret`, and only when the operator
 * actually typed something.
 */
import { useMemo, useState, useTransition } from "react";
import { Button } from "@openshapeforge/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/display/card";
import { Badge } from "@/components/ui/display/badge";
import { Input } from "@/components/ui/forms/input";
import { Label } from "@/features/renderer/edit/controls/basic/label";
import {
  saveConnectorConfiguration,
  setConnectorEnabled,
  setConnectorSecret,
  verifyConnector,
} from "@/actions/integrations";
import { ConnectorFieldControl, localized } from "./connector-field-control";
import { CONTRACT_STATE_TONE } from "./connector-status";
import { SECRET_SENTINEL, type Connector, type ConnectorInstallation } from "./types";

type Feedback = { tone: "ok" | "error"; message: string } | null;

export type InstallationPanelProps = {
  connector: Connector;
  installation: ConnectorInstallation;
  lang: string;
  /** False for a not-yet-created installation, which cannot be enabled or checked. */
  persisted: boolean;
};

const COPY = {
  save: { en: "Save", nl: "Opslaan" },
  saving: { en: "Saving…", nl: "Opslaan…" },
  test: { en: "Test connection", nl: "Verbinding testen" },
  testing: { en: "Testing…", nl: "Testen…" },
  enable: { en: "Enable", nl: "Inschakelen" },
  disable: { en: "Disable", nl: "Uitschakelen" },
  displayName: { en: "Name", nl: "Naam" },
  saved: { en: "Configuration saved.", nl: "Configuratie opgeslagen." },
  verified: { en: "Connection succeeded.", nl: "Verbinding geslaagd." },
  repairBlocked: {
    en: "Supply the missing required fields before enabling this installation.",
    nl: "Vul de ontbrekende verplichte velden in voordat je deze installatie inschakelt.",
  },
} satisfies Record<string, Record<string, string>>;

export function InstallationPanel({
  connector,
  installation,
  lang,
  persisted,
}: InstallationPanelProps) {
  const say = (key: keyof typeof COPY) => localized(COPY[key], lang);

  const secretKeys = useMemo(
    () => new Set(connector.configFields.filter((f) => f.secret).map((f) => f.key)),
    [connector.configFields],
  );

  const [values, setValues] = useState<Record<string, unknown>>(
    () => ({ ...installation.configuration }),
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState(installation.displayName ?? "");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();
  const [checking, setChecking] = useState(false);

  const health = installation.contract;
  const missing = new Set(health.missingRequiredFields);
  const blockedByRepair = health.state === "NEEDS_REPAIR";

  function update(key: string, value: unknown) {
    if (secretKeys.has(key)) {
      setSecrets((prev) => ({ ...prev, [key]: String(value ?? "") }));
      return;
    }
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function onSave() {
    setFeedback(null);
    startTransition(async () => {
      // Non-secret fields only. The sentinel would otherwise be written back as
      // a real value for any secret the operator did not retype.
      const configuration = Object.fromEntries(
        Object.entries(values).filter(([key]) => !secretKeys.has(key)),
      );
      const saved = await saveConnectorConfiguration({
        slug: connector.slug,
        instanceKey: installation.instanceKey,
        displayName: displayName === "" ? null : displayName,
        configuration,
      });
      if (!saved.ok) {
        setFeedback({ tone: "error", message: saved.error });
        return;
      }

      // Only secrets the operator actually typed. An untouched one keeps the
      // value already stored, which is what makes the sentinel safe to show.
      for (const [field, value] of Object.entries(secrets)) {
        if (value === "") continue;
        const stored = await setConnectorSecret({
          slug: connector.slug,
          instanceKey: installation.instanceKey,
          field,
          value,
        });
        if (!stored.ok) {
          setFeedback({ tone: "error", message: stored.error });
          return;
        }
      }
      setSecrets({});
      setFeedback({ tone: "ok", message: say("saved") });
    });
  }

  function onToggleEnabled() {
    setFeedback(null);
    startTransition(async () => {
      const result = await setConnectorEnabled({
        slug: connector.slug,
        instanceKey: installation.instanceKey,
        enabled: !installation.enabled,
      });
      if (!result.ok) setFeedback({ tone: "error", message: result.error });
    });
  }

  async function onVerify() {
    setFeedback(null);
    setChecking(true);
    try {
      const result = await verifyConnector({
        slug: connector.slug,
        instanceKey: installation.instanceKey,
      });
      setFeedback(
        result.ok
          ? { tone: "ok", message: result.message || say("verified") }
          : { tone: "error", message: result.error },
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          {installation.displayName || installation.instanceKey}
          {persisted ? (
            <Badge variant={installation.enabled ? "success" : "secondary"}>
              {installation.enabled
                ? lang === "nl" ? "Ingeschakeld" : "Enabled"
                : lang === "nl" ? "Uitgeschakeld" : "Disabled"}
            </Badge>
          ) : null}
          {health.state !== "CURRENT" ? (
            <Badge variant={CONTRACT_STATE_TONE[health.state]}>{health.state}</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {health.reason ? (
          <p className="text-sm text-muted-foreground">{health.reason}</p>
        ) : null}

        {connector.instances === "multiple" ? (
          <div className="space-y-1.5">
            <Label htmlFor="installation-display-name">{say("displayName")}</Label>
            <Input
              id="installation-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={pending}
            />
          </div>
        ) : null}

        {connector.configFields.map((field) => (
          <ConnectorFieldControl
            key={field.key}
            field={field}
            lang={lang}
            disabled={pending}
            invalid={missing.has(field.key)}
            value={
              field.secret
                ? (secrets[field.key] ??
                  (installation.configuration[field.key] === SECRET_SENTINEL
                    ? SECRET_SENTINEL
                    : ""))
                : values[field.key]
            }
            onChange={(value) => update(field.key, value)}
          />
        ))}

        {feedback ? (
          <p
            className={
              feedback.tone === "ok"
                ? "text-sm text-muted-foreground"
                : "text-sm text-destructive"
            }
          >
            {feedback.message}
          </p>
        ) : null}

        {blockedByRepair ? (
          <p className="text-sm text-destructive">{say("repairBlocked")}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={onSave} disabled={pending}>
            {pending ? say("saving") : say("save")}
          </Button>

          {/* Offered only when the contract declares a check, so an operator is
              never shown a button whose only outcome is "unsupported". */}
          {persisted && connector.supportsVerify ? (
            <Button variant="outline" onClick={onVerify} disabled={checking || pending}>
              {checking ? say("testing") : say("test")}
            </Button>
          ) : null}

          {persisted ? (
            <Button
              variant="outline"
              onClick={onToggleEnabled}
              // NEEDS_REPAIR blocks enabling but never disabling: switching a
              // broken installation off must always be available.
              disabled={pending || (blockedByRepair && !installation.enabled)}
            >
              {installation.enabled ? say("disable") : say("enable")}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
