// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@openshapeforge/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/overlay/dialog";
import { readSessionContinuation, sessionContinuationRetryAt } from "@/lib/auth/session-continuation";
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
    reconnectTitle: "Reconnecting your session",
    reconnectDescription: "The sign-in service is temporarily unavailable. We are retrying automatically; your work remains open.",
  },
  nl: {
    title: "Sessie verloopt binnenkort",
    description: "Uw sessie verloopt over",
    suffix: "seconden. Wilt u doorgaan met werken?",
    logout: "Uitloggen",
    continue: "Doorgaan",
    refreshing: "Bezig...",
    reconnectTitle: "Sessie opnieuw verbinden",
    reconnectDescription: "De inlogdienst is tijdelijk niet beschikbaar. We proberen automatisch opnieuw; uw werk blijft open.",
  },
} as const;

function buildLogoutUrl(reason?: "session_expired") {
  const logoutUrl = new URL("/api/logout", globalThis.location.origin);
  if (reason) {
    logoutUrl.searchParams.set("reason", reason);
  }
  return logoutUrl.toString();
}

export function SessionExpiryGuard({ lang }: { lang: string }) {
  const session = useAppSession();
  const setSession = useSetAppSession();
  const pathname = usePathname();
  const [showDialog, setShowDialog] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_REDIRECT_AFTER_S);
  const [refreshing, setRefreshing] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const redirectingRef = useRef(false);
  const recoveryAttemptRef = useRef(0);
  const continuingRef = useRef(false);
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

  const logout = useCallback((reason?: "session_expired") => {
    if (redirectingRef.current) {
      return;
    }

    redirectingRef.current = true;
    clearTimers();
    globalThis.location.assign(buildLogoutUrl(reason));
  }, [clearTimers]);

  const syncSessionExpiry = useCallback((expiresAt: number) => {
    const nowS = Math.floor(Date.now() / 1000);
    const secondsUntilExpiry = expiresAt - nowS;
    const secondsUntilWarning = secondsUntilExpiry - WARNING_BEFORE_EXPIRY_S;

    if (secondsUntilExpiry <= 0) {
      setSession?.(null);
      logout("session_expired");
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
  }, [clearTimers, logout, setSession]);

  const handleContinue = useCallback(async () => {
    if (continuingRef.current || redirectingRef.current) return;
    continuingRef.current = true;
    setRefreshing(true);

    try {
      const result = await readSessionContinuation(() => fetch("/api/auth/session", { cache: "no-store" }));
      if (result.state === "unavailable") {
        if (result.session) setSession?.(result.session);
        clearTimers();
        setShowDialog(false);
        setRetryAt(sessionContinuationRetryAt(Date.now(), recoveryAttemptRef.current++, result.session?.refreshRetryAt));
        return;
      }
      if (result.state === "expired") {
        setSession?.(null);
        logout("session_expired");
        return;
      }
      const refreshedSession = result.session;
      recoveryAttemptRef.current = 0;
      setRetryAt(null);
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

          setSession?.(null);
          logout("session_expired");
        }, RETRY_WARNING_DELAY_MS);
        return;
      }

      setSession?.(null);
      logout("session_expired");
    } catch {
      // Unexpected client-side failures must settle the click handler too.
      clearTimers();
      setShowDialog(false);
      setRetryAt(sessionContinuationRetryAt(Date.now(), recoveryAttemptRef.current++));
    } finally {
      continuingRef.current = false;
      if (!redirectingRef.current) {
        setRefreshing(false);
      }
    }
  }, [clearTimers, logout, setSession, syncSessionExpiry]);

  handleContinueRef.current = handleContinue;

  useEffect(() => {
    if (retryAt === null || redirectingRef.current) return;
    const timer = setTimeout(() => handleContinueRef.current(), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);

  useEffect(() => {
    if (session?.error === "RefreshTokenUnavailable") {
      setRetryAt((current) => Math.max(current ?? 0, sessionContinuationRetryAt(Date.now(), Math.max(0, recoveryAttemptRef.current - 1), session.refreshRetryAt)));
    }
  }, [session?.error, session?.refreshRetryAt]);

  const reconnecting = retryAt !== null || session?.error === "RefreshTokenUnavailable";
  const monitorExpiry = session?.error === "RefreshTokenUnavailable"
    ? session.refreshExpiresAt : session?.refreshExpiresAt ?? session?.expiresAt;

  useEffect(() => {
    if (session?.error === "RefreshTokenError") {
      setSession?.(null);
      logout("session_expired");
    }
  }, [logout, session?.error, setSession]);

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
    if (reconnecting || !showDialog || countdown > 0) {
      return;
    }

    setSession?.(null);
    logout("session_expired");
  }, [countdown, logout, reconnecting, setSession, showDialog]);

  if (!showDialog && !reconnecting) {
    return null;
  }

  return (
    <Dialog open={showDialog || reconnecting} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{reconnecting ? copy.reconnectTitle : copy.title}</DialogTitle>
          <DialogDescription>
            {reconnecting ? copy.reconnectDescription : <>{copy.description}{" "}
            <span className="font-semibold tabular-nums">{countdown}</span>{" "}
            {copy.suffix}</>}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => logout()}>
            {copy.logout}
          </Button>
          <Button onClick={handleContinue} disabled={refreshing || reconnecting}>
            {refreshing || reconnecting ? copy.refreshing : copy.continue}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
