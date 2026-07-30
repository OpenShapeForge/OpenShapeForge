// SPDX-License-Identifier: BUSL-1.1
"use client";

import * as React from "react";

type RendererDefaults = {
  direction: "horizontal" | "vertical" | undefined;
};

const RendererDefaultsContext = React.createContext<RendererDefaults>({
  direction: undefined,
});

function RendererDefaultsProvider({
  direction,
  children,
}: {
  direction: "horizontal" | "vertical" | undefined;
  children: React.ReactNode;
}) {
  const value = React.useMemo<RendererDefaults>(
    () => ({ direction }),
    [direction],
  );

  return (
    <RendererDefaultsContext.Provider value={value}>
      {children}
    </RendererDefaultsContext.Provider>
  );
}

function useRendererDefaults(): RendererDefaults {
  return React.useContext(RendererDefaultsContext);
}

export { RendererDefaultsProvider, useRendererDefaults };
