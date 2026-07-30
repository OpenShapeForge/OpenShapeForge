// SPDX-License-Identifier: BUSL-1.1
import type { ComponentProps, ReactNode } from "react";

import type { CaseCheckState } from "../case-check";
import type { CaseStepNodeStep } from "../case-step-nodes";
import type { NodeCategory } from "../node-icon";

export const inboxMessageHandlingFigmaBinding = {
  fileKey: "CbKdajB2p4lAW3bBGcHBYd",
  name: "Inbox \\ Message \\ Handeling",
  rootNodeId: "226:59906",
  variants: {
    "convert-to-case": "101:12602",
    "case-1": "226:59907",
    "case-2": "273:5300",
    "case-3": "287:5351",
  },
  children: {
    rowPanelheader: "101:12392",
    rowPanelheaderCase: "226:59908",
    rowHeaderConvertToCase: "101:12393",
    rowCaseCategories: "133:3923",
    rowHeaderCase: "226:59909",
    selector: "227:61090",
    rowCaseContainer: "279:4745",
    rowCase: "279:4746",
    rowStep: "279:4747",
    rowTaskList: "279:4773",
    caseTask: "279:4774",
  },
} as const;

export type InboxMessageHandlingStep =
  | "convert-to-case"
  | "case-1"
  | "case-2"
  | "case-3";

export type InboxMessageHandlingRailStep = CaseStepNodeStep | "step9";

export interface InboxMessageHandlingChoice {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  category?: NodeCategory;
  icon?: ReactNode;
}

export interface InboxMessageHandlingCaseStep {
  id: string;
  label?: ReactNode;
  meta?: ReactNode;
  nodeStep?: InboxMessageHandlingRailStep;
  top?: boolean;
  bottom?: boolean;
  dashed?: boolean;
  height?: number;
  bodyClassName?: string;
  children?: ReactNode;
}

export interface InboxMessageHandlingProps
  extends Omit<ComponentProps<"aside">, "children" | "title"> {
  /** Figma `step` variant axis. */
  step?: InboxMessageHandlingStep;
  panelTitle?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  choices?: InboxMessageHandlingChoice[];
  selectedChoice?: string;
  onChoiceChange?: (value: string) => void;
  startCaseLabel?: ReactNode;
  startCaseShortcut?: ReactNode;
  startCaseDisabled?: boolean;
  startCaseStatus?: ReactNode;
  onStartCase?: (selectedChoice?: string) => void;
  selector?: ReactNode;
  caseSteps?: InboxMessageHandlingCaseStep[];
  children?: ReactNode;
}

export interface InboxMessageHandlingRowHeaderProps
  extends Omit<ComponentProps<"div">, "title"> {
  icon?: ReactNode;
  category?: NodeCategory;
  title: ReactNode;
  subtitle: ReactNode;
}

export interface InboxMessageHandlingCaseCategoriesProps
  extends ComponentProps<"div"> {
  choices?: InboxMessageHandlingChoice[];
  selectedChoice?: string;
  onChoiceChange?: (value: string) => void;
  startCaseLabel?: ReactNode;
  startCaseShortcut?: ReactNode;
  startCaseDisabled?: boolean;
  startCaseStatus?: ReactNode;
  onStartCase?: (selectedChoice?: string) => void;
}

export interface InboxMessageHandlingCaseContainerProps
  extends ComponentProps<"div"> {}

export interface InboxMessageHandlingCaseProps
  extends ComponentProps<"div"> {}

export interface InboxMessageHandlingStepRowProps
  extends Omit<ComponentProps<"div">, "title"> {
  nodeStep?: InboxMessageHandlingRailStep;
  top?: boolean;
  bottom?: boolean;
  dashed?: boolean;
  height?: number;
  title?: ReactNode;
  meta?: ReactNode;
  railClassName?: string;
  bodyClassName?: string;
}

export interface InboxMessageHandlingCaseTaskProps
  extends ComponentProps<"div"> {
  label: ReactNode;
  description?: ReactNode;
  state?: CaseCheckState;
  checked?: boolean;
  active?: boolean;
  showDescription?: boolean;
}

export interface InboxMessageHandlingTaskListProps
  extends ComponentProps<"div"> {
  tasks?: ReactNode[];
  checked?: boolean;
}

export interface InboxMessageHandlingCaseDescriptionProps
  extends ComponentProps<"div"> {}

export interface InboxMessageHandlingTaskPanelProps {
  title: ReactNode;
  outcome?: ReactNode;
  arrears?: ReactNode;
  note?: ReactNode;
  assignee?: ReactNode;
  finishLabel?: ReactNode;
  className?: string;
}

export interface InboxMessageHandlingFormFieldsProps
  extends ComponentProps<"div"> {
  outcome?: ReactNode;
  arrears?: ReactNode;
  note?: ReactNode;
}

export interface InboxMessageHandlingFieldProps {
  label: ReactNode;
  value: ReactNode;
  multiline?: boolean;
  hasDropdown?: boolean;
}

export interface InboxMessageHandlingActionRowProps {
  finishLabel?: ReactNode;
  className?: string;
}

export interface InboxMessageHandlingAssigneeProps {
  name?: ReactNode;
  role?: ReactNode;
  className?: string;
}
