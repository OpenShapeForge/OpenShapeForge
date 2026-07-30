// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Frown, MoreHorizontal } from "lucide-react";

import { InboxMessageHandlingTaskList } from "./case-timeline";
import { BoxingGloveIcon, ScrewdriverIcon } from "./icons";
import {
  InboxMessageHandlingAssignee,
  InboxMessageHandlingCaseTask,
  InboxMessageHandlingTaskPanel,
} from "./task-panel";
import type {
  InboxMessageHandlingCaseStep,
  InboxMessageHandlingChoice,
  InboxMessageHandlingStep,
} from "./types";

export const defaultChoices: InboxMessageHandlingChoice[] = [
  {
    value: "klacht",
    label: "Klacht (Suggestie)",
    description: "Klacht over een medewerker of leverancier",
    category: "ai",
    icon: <Frown />,
  },
  {
    value: "overlast",
    label: "Overlast",
    description: "Problemen in de buurt of met de buren",
    category: "case",
    icon: <BoxingGloveIcon />,
  },
  {
    value: "reparatie",
    label: "Reparatie",
    description: "Gebreken in de woning of de algemene ruimte",
    category: "case",
    icon: <ScrewdriverIcon />,
  },
  {
    value: "ander-zaaktype",
    label: "Ander zaaktype",
    description: "Open overzicht van alle zaaktypes",
    category: "case",
    icon: <MoreHorizontal />,
  },
];

export function buildDefaultCaseSteps(
  step: InboxMessageHandlingStep,
): InboxMessageHandlingCaseStep[] {
  const activeTaskPanel = step === "case-2" || step === "case-3";
  const taskHeight = activeTaskPanel ? 552 : 246;
  const finishLabel = step === "case-3" ? "Afronden" : "Oppakken";
  const outcome = step === "case-3" ? "Niet beoordeeld" : "Niet gecontroleerd";

  return [
    { id: "origin", label: "Aanleiding", nodeStep: "origin", top: false, bottom: false },
    {
      id: "complaint",
      label: "Klacht over medewerker",
      meta: "16 apr · 13:55",
      nodeStep: "message",
      top: false,
      bottom: false,
      height: 54,
    },
    {
      id: "received",
      label: "Huuropzegging ontvangen",
      nodeStep: "checked",
      top: false,
      bottom: true,
      height: 38,
    },
    { id: "line-1", nodeStep: "line", height: 16 },
    {
      id: "processing",
      label: "Huuropzegging verwerken",
      nodeStep: "step",
    },
    {
      id: "tasks",
      nodeStep: "line",
      height: taskHeight,
      bodyClassName: "gap-2 px-2 pb-6",
      children: (
        <>
          <p className="max-w-[304px] text-[13px] font-normal leading-[22px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
            De huurder zegt de huur op. De opzegging wordt gecontroleerd en
            vastgelegd.
          </p>
          {activeTaskPanel ? (
            <>
              <InboxMessageHandlingCaseTask
                label="Huuropzegging goedkeuring en vastleggen"
                checked
              />
              <InboxMessageHandlingTaskPanel
                title="Controleer huursaldo"
                outcome={outcome}
                finishLabel={finishLabel}
                assignee={step === "case-3" ? <InboxMessageHandlingAssignee /> : null}
              />
              <InboxMessageHandlingTaskList
                tasks={[
                  "Opzegtermijn en einddatum verifieren",
                  "Stuur bevestiging naar huurder",
                  "Stap afronden",
                ]}
                checked
              />
            </>
          ) : (
            <InboxMessageHandlingTaskList checked />
          )}
        </>
      ),
    },
    { id: "inspection-progress", nodeStep: "progress" },
    { id: "inspection", label: "Voorinspectie", nodeStep: "step" },
    { id: "line-2", nodeStep: "line", height: 12 },
    { id: "handover", label: "Overname en bezichtigingen", nodeStep: "step" },
    { id: "line-3", nodeStep: "line", height: 12 },
    { id: "repair", label: "Herstel en oplevering", nodeStep: "step" },
    { id: "line-4", nodeStep: "line", height: 12 },
    { id: "final-inspection", label: "Eindinspectie", nodeStep: "step" },
    { id: "line-5", nodeStep: "line", height: 12 },
    { id: "keys", label: "Sleuteloverdracht", nodeStep: "step" },
    { id: "line-6", nodeStep: "line", height: 12 },
    { id: "costs", label: "Servicekosten", nodeStep: "step" },
    { id: "line-7", nodeStep: "line", height: 12 },
    { id: "done", label: "Zaak afgerond", nodeStep: "end", bottom: false },
  ];
}
