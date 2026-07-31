// SPDX-License-Identifier: BUSL-1.1
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@/lib/auth";

const SessionContext = createContext<Session | null>(null);
const SessionUpdateContext = createContext<((session: Session | null) => void) | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: Session | null;
  children: ReactNode;
}) {
  const [currentSession, setCurrentSession] = useState(session);

  useEffect(() => {
    setCurrentSession(session);
  }, [session]);

  return (
    <SessionUpdateContext.Provider value={setCurrentSession}>
      <SessionContext.Provider value={currentSession}>{children}</SessionContext.Provider>
    </SessionUpdateContext.Provider>
  );
}

export function useAppSession() {
  return useContext(SessionContext);
}

export function useSetAppSession() {
  return useContext(SessionUpdateContext);
}
