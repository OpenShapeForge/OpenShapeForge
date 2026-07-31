// SPDX-License-Identifier: BUSL-1.1
import type { ReactNode } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

export const DOMAIN_COLORS: Record<string, string> = {
  Relaties: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  Vastgoed:
    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  Contracten:
    "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  Onderhoud:
    "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  Financien:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  "Financiën":
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  Projectontwikkeling:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  Duurzaamheid:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  Kwaliteit:
    "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  Organisatie:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  Dossier: "bg-muted text-muted-foreground",
  Woonruimteverdeling:
    "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  Support:
    "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  Processen:
    "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};

export const ACTIE_ICONS: Record<string, ReactNode> = {
  aangemaakt: <Plus className="size-3" />,
  gewijzigd: <Pencil className="size-3" />,
  bijgewerkt: <RefreshCw className="size-3" />,
  verwijderd: <Trash2 className="size-3" />,
};

export const ACTIE_ICON_TONES: Record<string, string> = {
  aangemaakt:
    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  gewijzigd: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  bijgewerkt:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  verwijderd: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export const ACTIE_LABELS: Record<string, string> = {
  aangemaakt: "Aangemaakt",
  gewijzigd: "Gewijzigd",
  bijgewerkt: "Bijgewerkt",
  verwijderd: "Verwijderd",
};
