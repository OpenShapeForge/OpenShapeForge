// SPDX-License-Identifier: BUSL-1.1
export function WorkspaceEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-border bg-muted/20 px-6 text-center">
      <div className="max-w-sm space-y-2">
        <p className="text-base font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
