// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  ConnectorDot,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@openshapeforge/ui";
import type { NodeConnectorSlots, NodeOutput } from "./types";

type OutputConnectorsProps = {
  outputs?: NodeOutput[];
  connectors?: NodeConnectorSlots;
};

/**
 * The labelled outlet row under a multi-output card: one equal column per
 * output, each with its label and its connector.
 *
 * Labels truncate rather than wrap so every column stays the same height and
 * the connectors stay on one line — hence the tooltip, which is the only way
 * back to a label that did not fit.
 */
export function OutputConnectors({ outputs, connectors }: OutputConnectorsProps) {
  if (!outputs || outputs.length === 0) return null;

  return (
    <>
      <div
        aria-hidden="true"
        className="h-px w-full shrink-0 bg-node-card-border-subtle"
      />
      <TooltipProvider delayDuration={250}>
        <div
          data-name="row-connectors"
          className="relative flex h-10 w-full items-stretch"
        >
          {outputs.map((output, index) => {
            const slot = connectors?.output?.(output, index);
            const outputLabel = output.label ?? output.id;
            return (
              <div
                key={output.id}
                data-name="connector"
                className="relative flex h-full min-w-0 flex-1 items-center justify-center"
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="max-w-[100px] min-w-0 cursor-default truncate px-1 text-center font-sans text-[12px] leading-[12px] tracking-[-0.03em] text-muted-foreground">
                      {outputLabel}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center" className="max-w-sm">
                    {outputLabel}
                  </TooltipContent>
                </Tooltip>
                {slot === null ? null : slot === undefined ? (
                  <ConnectorDot at="bottom" />
                ) : (
                  slot
                )}
              </div>
            );
          })}
        </div>
      </TooltipProvider>
    </>
  );
}
