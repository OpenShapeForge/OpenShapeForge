// SPDX-License-Identifier: BUSL-1.1
"use client";

import { BriefcaseBusiness, MessageCircle } from "lucide-react";

import { cn } from "../../lib/cn";
import {
  InboxMessageHandlingCase,
  InboxMessageHandlingCaseContainer,
  InboxMessageHandlingSelector,
  InboxMessageHandlingStepRow,
} from "./case-timeline";
import {
  InboxMessageHandlingCaseCategories,
  InboxMessageHandlingPanelHeader,
  InboxMessageHandlingRowHeader,
} from "./convert-panel";
import { buildDefaultCaseSteps, defaultChoices } from "./defaults";
import {
  inboxMessageHandlingFigmaBinding,
  type InboxMessageHandlingProps,
} from "./types";

/**
 * `Inbox \ Message \ Handeling` side-panel product component.
 *
 * @figma file-key=CbKdajB2p4lAW3bBGcHBYd
 * @figma name="Inbox \ Message \ Handeling"
 * @figma node-id=226-59906 root
 * @figma node-id=101-12602 step=convert-to-case
 * @figma node-id=226-59907 step=case-1
 * @figma node-id=273-5300 step=case-2
 * @figma node-id=287-5351 step=case-3
 */
export function InboxMessageHandling({
  step = "convert-to-case",
  panelTitle = "Zaakgericht werken",
  title = step === "convert-to-case" ? "Omzetten naar zaak" : "Klacht",
  subtitle = step === "convert-to-case" ? "Contact registratie" : "Zaak",
  choices = defaultChoices,
  selectedChoice,
  onChoiceChange,
  startCaseLabel = "Start zaak",
  startCaseShortcut,
  startCaseDisabled,
  startCaseStatus,
  onStartCase,
  selector,
  caseSteps,
  children,
  className,
  ...props
}: InboxMessageHandlingProps) {
  const isConvert = step === "convert-to-case";
  const resolvedCaseSteps = caseSteps ?? buildDefaultCaseSteps(step);

  return (
    <aside
      {...props}
      data-slot="inbox-message-handling"
      data-figma-file-key={inboxMessageHandlingFigmaBinding.fileKey}
      data-figma-name={inboxMessageHandlingFigmaBinding.name}
      data-figma-root-node-id={inboxMessageHandlingFigmaBinding.rootNodeId}
      data-figma-node-id={inboxMessageHandlingFigmaBinding.variants[step]}
      data-step={step}
      className={cn(
        "relative flex h-full min-h-[1064px] w-[400px] shrink-0 flex-col gap-6 overflow-hidden border-l border-[var(--color-border-subtle)] bg-[var(--color-card)]",
        className,
      )}
    >
      <InboxMessageHandlingPanelHeader title={panelTitle} />
      <InboxMessageHandlingRowHeader
        icon={
          isConvert ? (
            <MessageCircle className="size-4" />
          ) : (
            <BriefcaseBusiness className="size-4" />
          )
        }
        category={isConvert ? "default" : "case"}
        title={title}
        subtitle={subtitle}
        className={isConvert ? "h-7" : "h-9"}
      />
      {isConvert ? (
        <InboxMessageHandlingCaseCategories
          choices={choices}
          selectedChoice={selectedChoice}
          onChoiceChange={onChoiceChange}
          startCaseLabel={startCaseLabel}
          startCaseShortcut={startCaseShortcut}
          startCaseDisabled={startCaseDisabled}
          startCaseStatus={startCaseStatus}
          onStartCase={onStartCase}
        />
      ) : (
        <>
          {selector ?? <InboxMessageHandlingSelector aria-hidden />}
          <InboxMessageHandlingCaseContainer>
            {children ?? (
              <InboxMessageHandlingCase>
                {resolvedCaseSteps.map((caseStep) => (
                  <InboxMessageHandlingStepRow
                    key={caseStep.id}
                    nodeStep={caseStep.nodeStep}
                    top={caseStep.top}
                    bottom={caseStep.bottom}
                    dashed={caseStep.dashed}
                    height={caseStep.height}
                    title={caseStep.label}
                    meta={caseStep.meta}
                    bodyClassName={caseStep.bodyClassName}
                  >
                    {caseStep.children}
                  </InboxMessageHandlingStepRow>
                ))}
              </InboxMessageHandlingCase>
            )}
          </InboxMessageHandlingCaseContainer>
        </>
      )}
    </aside>
  );
}
