// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Braces, ChevronDown, Plus } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@openshapeforge/ui";
import {
  HelpAffordance,
  ScreenReaderDescription,
} from "@/features/renderer/components/field/label";
import { cn } from "@/lib/utils";

type CollectionEditorHeaderProps = {
  headerId: string;
  bodyId: string;
  label: string;
  description?: string;
  helpText?: string;
  chromeLang: "nl" | "en";
  sectionExpanded: boolean;
  setSectionExpanded: (updater: (current: boolean) => boolean) => void;
  variableRowsEnabled: boolean;
  isReadOnly: boolean;
  sourceMode: "manual" | "variable";
  setSourceMode: (mode: "manual" | "variable") => void;
  addMenuOpen: boolean;
  setAddMenuOpen: (updater: boolean | ((current: boolean) => boolean)) => void;
  valueIsArray: boolean;
  onChange: (nextValue: unknown[] | string) => void;
  handleAdd: () => void;
  handleAddManualSourceRow: () => void;
  handleAddVariableSourceRow: () => void;
  variableModeToggleLabel: string;
  addLabel: string;
  addManualLabel: string;
  addVariableRowLabel: string;
};

export function CollectionEditorHeader({
  headerId,
  bodyId,
  label,
  description,
  helpText,
  chromeLang,
  sectionExpanded,
  setSectionExpanded,
  variableRowsEnabled,
  isReadOnly,
  sourceMode,
  setSourceMode,
  addMenuOpen,
  setAddMenuOpen,
  valueIsArray,
  onChange,
  handleAdd,
  handleAddManualSourceRow,
  handleAddVariableSourceRow,
  variableModeToggleLabel,
  addLabel,
  addManualLabel,
  addVariableRowLabel,
}: CollectionEditorHeaderProps) {
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!addMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        addMenuRef.current &&
        addMenuRef.current.contains(target)
      ) {
        return;
      }
      setAddMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAddMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen, setAddMenuOpen]);

  return (
    <div className="group flex items-center gap-2">
      <button
        type="button"
        id={headerId}
        onClick={() => setSectionExpanded((prev) => !prev)}
        aria-expanded={sectionExpanded}
        aria-controls={bodyId}
        className="text-foreground flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            !sectionExpanded && "-rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {variableRowsEnabled && !isReadOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            "text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
            sourceMode === "variable" &&
              "bg-muted text-foreground opacity-100 hover:bg-muted",
          )}
          onClick={() => {
            if (sourceMode === "variable") {
              setSourceMode("manual");
              if (!valueIsArray) {
                onChange([]);
              }
              return;
            }
            setSourceMode("variable");
          }}
          aria-label={variableModeToggleLabel}
          aria-pressed={sourceMode === "variable"}
          title={variableModeToggleLabel}
        >
          <Braces className="size-4" />
        </Button>
      ) : null}
      {!isReadOnly && sourceMode === "manual" ? (
        variableRowsEnabled ? (
          <div ref={addMenuRef} className="relative">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setAddMenuOpen((prev) => !prev)}
              aria-label={addLabel}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
            >
              <Plus className="size-4" />
            </Button>
            {addMenuOpen ? (
              <div
                role="menu"
                aria-label={addLabel}
                className="bg-background absolute right-0 top-full z-50 mt-1 min-w-48 rounded-md border border-border p-1 text-[13px] shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none hover:bg-muted focus:bg-muted"
                  onClick={() => {
                    setAddMenuOpen(false);
                    handleAddManualSourceRow();
                  }}
                >
                  <Plus className="text-muted-foreground size-4" aria-hidden="true" />
                  <span>{addManualLabel}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none hover:bg-muted focus:bg-muted"
                  onClick={() => {
                    setAddMenuOpen(false);
                    handleAddVariableSourceRow();
                  }}
                >
                  <Braces
                    className="text-muted-foreground size-4"
                    aria-hidden="true"
                  />
                  <span>{addVariableRowLabel}</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={handleAdd}
            aria-label={addLabel}
          >
            <Plus className="size-4" />
          </Button>
        )
      ) : null}
      <HelpAffordance
        description={description}
        helpText={helpText}
        fieldLabel={label}
        lang={chromeLang}
      />
      <ScreenReaderDescription description={description} />
    </div>
  );
}
