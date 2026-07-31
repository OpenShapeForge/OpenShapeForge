// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";
import { CircleHelp } from "lucide-react";
import Markdown from "react-markdown";

import { Button } from "@openshapeforge/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/overlay/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@openshapeforge/ui";
import { useFieldContext } from "@/features/renderer/edit/field-context";
import { Label } from "@/features/renderer/edit/controls/basic/label";
import { cn } from "@/lib/utils";

type Lang = "nl" | "en";

/**
 * Strict truthiness for help-affordance content. A whitespace-only string
 * passes a plain `Boolean(x)` check but visually shows nothing — render an
 * empty tooltip / dialog. Treat strings that contain no non-whitespace
 * characters as absent. Non-string ReactNodes fall through to the normal
 * truthiness check.
 */
function hasMeaningfulContent(value: React.ReactNode): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return Boolean(value);
}

function TooltipOnlyAffordance({
  ariaLabel,
  className,
  content,
}: {
  ariaLabel: string;
  className?: string;
  content: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <HelpButton
            ariaLabel={ariaLabel}
            className={className}
            onClick={() => setOpen((prev) => !prev)}
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function HelpButton({
  ariaLabel,
  className,
  onClick,
}: {
  ariaLabel: string;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(
        "text-muted-foreground hover:text-foreground shrink-0 self-center",
        className,
      )}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <CircleHelp className="size-3.5" />
    </Button>
  );
}

function HelpDialogContent({
  title,
  helpText,
}: {
  title: string;
  helpText: React.ReactNode;
}) {
  return (
    <DialogContent className="max-h-[86vh] w-[min(92vw,880px)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none">
      <DialogHeader className="border-b px-6 py-5 pr-12">
        <DialogTitle className="text-xl leading-tight">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {title}
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-[calc(86vh-82px)] overflow-y-auto px-6 py-5">
        <HelpArticleContent helpText={helpText} />
      </div>
    </DialogContent>
  );
}

function HelpArticleContent({ helpText }: { helpText: React.ReactNode }) {
  if (typeof helpText !== "string") {
    return (
      <div className="text-sm leading-6 text-muted-foreground">{helpText}</div>
    );
  }

  return (
    <Markdown
      components={{
        h1: ({ children }) => (
          <h2 className="mt-0 mb-3 text-xl font-semibold tracking-normal text-foreground">
            {children}
          </h2>
        ),
        h2: ({ children }) => (
          <h3 className="mt-6 mb-2 text-base font-semibold tracking-normal text-foreground">
            {children}
          </h3>
        ),
        h3: ({ children }) => (
          <h4 className="mt-5 mb-2 text-sm font-semibold tracking-normal text-foreground">
            {children}
          </h4>
        ),
        p: ({ children }) => (
          <p className="my-3 text-sm leading-6 text-muted-foreground">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="my-3 list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="my-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="pl-1">{children}</li>,
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
        code: ({ children }) => (
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-medium text-foreground">
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="my-3 overflow-x-auto rounded-md border bg-muted/60 p-3 text-xs leading-5 text-foreground">
            {children}
          </pre>
        ),
        a: ({ children, href }) => (
          <a
            className="font-medium text-action-primary underline underline-offset-2"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {children}
          </a>
        ),
        img: ({ alt, src }) => (
          <img
            alt={alt ?? ""}
            className="my-4 max-h-80 w-full rounded-md border object-contain"
            src={src ?? ""}
          />
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-4 border-l-4 border-action-primary/30 pl-4 text-sm leading-6 text-muted-foreground">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-5 border-border" />,
      }}
    >
      {helpText}
    </Markdown>
  );
}

type HelpAffordanceProps = {
  description?: React.ReactNode;
  helpText?: React.ReactNode;
  helpTitle?: string;
  fieldLabel?: React.ReactNode;
  lang?: Lang;
  className?: string;
};

function HelpAffordance({
  description,
  helpText,
  helpTitle,
  fieldLabel,
  lang = "en",
  className,
}: HelpAffordanceProps) {
  if (!hasMeaningfulContent(description) && !hasMeaningfulContent(helpText)) {
    return null;
  }

  const displayTitle =
    helpTitle ?? (typeof fieldLabel === "string" ? fieldLabel : undefined);
  const triggerLabel = displayTitle
    ? `Help: ${displayTitle}`
    : lang === "nl"
      ? "Veldhulp openen"
      : "Open field help";
  const dialogTitle =
    displayTitle ?? (lang === "nl" ? "Veldhulp" : "Field help");
  const tooltipFallback =
    lang === "nl" ? "Open helpartikel" : "Open help article";
  const tooltipContent = description ?? tooltipFallback;

  // Tooltip-only branch: no help article to open. Hover/focus shows the
  // description; click also opens it (so touch devices and click users get
  // the same affordance — Radix Tooltip would otherwise dismiss on click).
  if (!helpText) {
    return (
      <TooltipOnlyAffordance
        ariaLabel={triggerLabel}
        className={className}
        content={tooltipContent}
      />
    );
  }

  const button = <HelpButton ariaLabel={triggerLabel} className={className} />;

  // Dialog-only branch: no description to show in a tooltip; click opens the
  // help article directly.
  if (!description) {
    return (
      <Dialog>
        <DialogTrigger asChild>{button}</DialogTrigger>
        <HelpDialogContent title={dialogTitle} helpText={helpText} />
      </Dialog>
    );
  }

  // Both branch: hover shows the short description, click opens the article.
  // DialogTrigger must be inside TooltipTrigger (both asChild) so they
  // forward to the same button via Radix Slot.
  return (
    <Dialog>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>{button}</DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {tooltipContent}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <HelpDialogContent title={dialogTitle} helpText={helpText} />
    </Dialog>
  );
}

/**
 * Visually hidden description anchor. Description content lives in the help
 * tooltip, but screen readers reach it via the `aria-describedby` chain
 * established in `FieldRoot`. This element is the `descriptionId` target.
 */
function ScreenReaderDescription({
  description,
}: {
  description?: React.ReactNode;
}) {
  const { descriptionId } = useFieldContext();
  if (!description) return null;
  return (
    <span id={descriptionId} className="sr-only">
      {description}
    </span>
  );
}

function FieldLabel({
  children,
  className,
  description,
  displayMode,
  helpText,
  helpTitle,
  lang = "en",
  required: requiredProp,
  ...props
}: React.ComponentProps<typeof Label> & {
  description?: React.ReactNode;
  displayMode?: boolean;
  helpText?: React.ReactNode;
  helpTitle?: string;
  lang?: Lang;
  required?: boolean;
}) {
  const { id, required: requiredFromContext } = useFieldContext();
  const required = requiredProp ?? requiredFromContext;

  return (
    <div className="flex items-center gap-2">
      <Label
        htmlFor={id}
        className={cn(
          "min-w-0 flex-1",
          displayMode
            ? "text-[12px] font-normal leading-[12px] tracking-[-0.36px] text-foreground-subtle"
            : "text-foreground-subtle",
          className,
        )}
        {...props}
      >
        {children}
        {required ? (
          <>
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </Label>
      <HelpAffordance
        description={description}
        helpText={helpText}
        helpTitle={helpTitle}
        fieldLabel={children}
        lang={lang}
      />
      <ScreenReaderDescription description={description} />
    </div>
  );
}

export { FieldLabel, HelpAffordance, ScreenReaderDescription };
export type { Lang, HelpAffordanceProps };
