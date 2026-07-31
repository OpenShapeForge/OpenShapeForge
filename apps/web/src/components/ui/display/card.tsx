// SPDX-License-Identifier: BUSL-1.1
import * as React from "react";
import { cn } from "@/lib/utils";

type CardProps = React.ComponentProps<"div">;
type CardTitleProps = React.ComponentProps<"h3">;
type CardDescriptionProps = React.ComponentProps<"p">;
type CardEmptyStateProps = React.ComponentProps<"p">;

function Card({ className, ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      className={cn("rounded-[14px] border bg-card shadow-xs", className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1.5 px-6 py-4 border-b border-[#ededed]", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: CardTitleProps) {
  return (
    <h3
      data-slot="card-title"
      className={cn("text-[15px] font-semibold tracking-[-0.2px]", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: CardDescriptionProps) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("p-6", className)}
      {...props}
    />
  );
}

function CardEmptyState({ className, ...props }: CardEmptyStateProps) {
  return (
    <p
      data-slot="card-empty-state"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardContent,
  CardDescription,
  CardEmptyState,
  CardHeader,
  CardTitle,
};
