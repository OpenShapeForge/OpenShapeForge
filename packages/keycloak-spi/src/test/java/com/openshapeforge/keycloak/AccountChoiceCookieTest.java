// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.cookie.CookieProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.sessions.AuthenticationSessionModel;

public class AccountChoiceCookieTest {
    @Test public void passiveAndOrdinaryRequestsRetainNativeCookieBehavior() {
        for (String prompt : new String[]{"none select_account", "none", "login", "consent"}) {
            var reads = new AtomicInteger();
            var attempts = new AtomicInteger();
            var cookies = (CookieProvider) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{CookieProvider.class}, (p,m,a) -> {
                if (m.getName().equals("get")) { reads.incrementAndGet(); return null; }
                throw new AssertionError("A passive or ordinary request must not change SSO cookies");
            });
            var session = (KeycloakSession) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{KeycloakSession.class}, (p,m,a) -> {
                if (m.getName().equals("getProvider") && a[0] == CookieProvider.class) return cookies;
                throw new AssertionError("Must not recreate or remove sessions on a passive or ordinary request");
            });
            var auth = (AuthenticationSessionModel) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{AuthenticationSessionModel.class}, (p,m,a) -> switch(m.getName()) {
                case "getProtocol" -> "openid-connect";
                case "getClientNote" -> prompt;
                default -> null;
            });
            var context = (AuthenticationFlowContext) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{AuthenticationFlowContext.class}, (p,m,a) -> switch(m.getName()) {
                case "getAuthenticationSession" -> auth;
                case "getSession" -> session;
                case "getRealm" -> null;
                case "attempted" -> { attempts.incrementAndGet(); yield null; }
                default -> throw new AssertionError("Must not authenticate or challenge without native checks");
            });
            new AccountChoiceCookie().authenticate(context);
            assertEquals(1, reads.get());
            assertEquals(1, attempts.get());
        }
    }
}
