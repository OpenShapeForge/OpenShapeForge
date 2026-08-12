// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { requestLogout, type LogoutReason } from "@openshapeforge/auth";
import { Button } from "@openshapeforge/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/overlay/dialog";
import type { Session } from "@/lib/auth";
import { useAppSession, useSetAppSession } from "./session-provider";

const WARNING_BEFORE_EXPIRY_S = 120;
const AUTO_REDIRECT_AFTER_S = 60;
const RETRY_WARNING_DELAY_MS = 30_000;
const INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;

const COPY = {
  en: {
    title: "Session ending soon",
    description: "Your session will expire in",
    suffix: "seconds. Would you like to keep working?",
    logout: "Log out",
    continue: "Continue",
    refreshing: "Refreshing...",
    logoutFailed: "Logout could not be completed. Please try again.",
  },
  nl: {
    title: "Sessie verloopt binnenkort",
    description: "Uw sessie verloopt over",
    suffix: "seconden. Wilt u doorgaan met werken?",
    logout: "Uitloggen",
    continue: "Doorgaan",
    refreshing: "Bezig...",
    logoutFailed: "Uitloggen is niet gelukt. Probeer het opnieuw.",
  },
} as const;

export function SessionExpiryGuard({ lang }: { lang: string }) {
  const session = useAppSession();
  const setSession = useSetAppSession();
  const pathname = usePathname();
  const [showDialog, setShowDialog] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_REDIRECT_AFTER_S);
  const [refreshing, setRefreshing] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const redirectingRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const handleContinueRef = useRef(() => {});
  const copy = lang === "nl" ? COPY.nl : COPY.en;

  useEffect(() => {
    lastActivityRef.current = Date.now();
  }, [pathname]);

  const clearTimers = useCallback(() => {
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const logout = useCallback(async (reason?: LogoutReason) => {
    if (redirectingRef.current) {
      return;
    }

    redirectingRef.current = true;
    setLogoutFailed(false);
    clearTimers();
    if (!await requestLogout(reason, {
      retryOnceOnServiceUnavailable: reason === "session_expired",
    })) {
      redirectingRef.current = false;
      setLogoutFailed(true);
      setShowDialog(true);
    }
  }, [clearTimers]);

  const syncSessionExpiry = useCallback((expiresAt: number) => {
    const nowS = Math.floor(Date.now() / 1000);
    const secondsUntilExpiry = expiresAt - nowS;
    const secondsUntilWarning = secondsUntilExpiry - WARNING_BEFORE_EXPIRY_S;

    if (secondsUntilExpiry <= 0) {
      void logout("session_expired");
      return;
    }

    clearTimers();

    if (secondsUntilWarning <= 0) {
      const msSinceLastActivity = Date.now() - lastActivityRef.current;
      if (msSinceLastActivity < INACTIVITY_THRESHOLD_MS) {
        handleContinueRef.current();
        return;
      }

      setShowDialog(true);
      setCountdown(Math.min(secondsUntilExpiry, AUTO_REDIRECT_AFTER_S));
      return;
    }

    setShowDialog(false);
    warningTimerRef.current = setTimeout(() => {
      syncSessionExpiry(expiresAt);
    }, secondsUntilWarning * 1000);
  }, [clearTimers, logout]);

  const handleContinue = useCallback(async () => {
    setRefreshing(true);

    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      if (!response.ok) {
        void logout("session_expired");
        return;
      }

      const refreshedSession = await response.json() as Session;
      if (
        refreshedSession?.error === "RefreshTokenError"
        || !refreshedSession?.accessToken
      ) {
        void logout("session_expired");
        return;
      }

      setSession?.(refreshedSession);
      setShowDialog(false);
      setCountdown(AUTO_REDIRECT_AFTER_S);
      clearTimers();

      const monitorExpiry = refreshedSession.refreshExpiresAt ?? refreshedSession.expiresAt;
      if (!monitorExpiry) {
        return;
      }

      const nowS = Math.floor(Date.now() / 1000);
      const secondsLeft = monitorExpiry - nowS;
      if (secondsLeft > WARNING_BEFORE_EXPIRY_S) {
        warningTimerRef.current = setTimeout(() => {
          syncSessionExpiry(monitorExpiry);
        }, (secondsLeft - WARNING_BEFORE_EXPIRY_S) * 1000);
        return;
      }

      if (secondsLeft > 0) {
        warningTimerRef.current = setTimeout(() => {
          const remaining = monitorExpiry - Math.floor(Date.now() / 1000);
          if (remaining > 0) {
            setShowDialog(true);
            setCountdown(Math.min(remaining, AUTO_REDIRECT_AFTER_S));
            return;
          }

          void logout("session_expired");
        }, RETRY_WARNING_DELAY_MS);
        return;
      }

      void logout("session_expired");
    } catch {
      void logout("session_expired");
    } finally {
      if (!redirectingRef.current) {
        setRefreshing(false);
      }
    }
  }, [clearTimers, logout, setSession, syncSessionExpiry]);

  handleContinueRef.current = handleContinue;

  const monitorExpiry = session?.refreshExpiresAt ?? session?.expiresAt;

  useEffect(() => {
    if (session?.error === "RefreshTokenError") {
      void logout("session_expired");
    }
  }, [logout, session?.error]);

  useEffect(() => {
    if (!monitorExpiry) {
      clearTimers();
      setShowDialog(false);
      return;
    }

    syncSessionExpiry(monitorExpiry);

    return clearTimers;
  }, [clearTimers, monitorExpiry, syncSessionExpiry]);

  useEffect(() => {
    if (!monitorExpiry) {
      return;
    }

    const handlePageActive = () => {
      syncSessionExpiry(monitorExpiry);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handlePageActive();
      }
    };

    globalThis.addEventListener("focus", handlePageActive);
    globalThis.addEventListener("pageshow", handlePageActive);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      globalThis.removeEventListener("focus", handlePageActive);
      globalThis.removeEventListener("pageshow", handlePageActive);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [monitorExpiry, syncSessionExpiry]);

  useEffect(() => {
    if (!showDialog) {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      return;
    }

    countdownIntervalRef.current = setInterval(() => {
      setCountdown((previous) => Math.max(previous - 1, 0));
    }, 1000);

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [showDialog]);

  useEffect(() => {
    if (!showDialog || countdown > 0) {
      return;
    }

    void logout("session_expired");
  }, [countdown, logout, showDialog]);

  if (!showDialog) {
    return null;
  }

  return (
    <Dialog open={showDialog} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md [&>.absolute]:hidden"
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            {copy.description}{" "}
            <span className="font-semibold tabular-nums">{countdown}</span>{" "}
            {copy.suffix}
            {logoutFailed ? (
              <span className="mt-2 block text-destructive" role="alert">
                {copy.logoutFailed}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => void logout()}>
            {copy.logout}
          </Button>
          <Button onClick={handleContinue} disabled={refreshing}>
            {refreshing ? copy.refreshing : copy.continue}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
