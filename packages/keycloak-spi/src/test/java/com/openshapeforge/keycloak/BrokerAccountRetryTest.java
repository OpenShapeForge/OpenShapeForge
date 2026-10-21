// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.lang.reflect.Proxy;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.sessions.RootAuthenticationSessionModel;

public class BrokerAccountRetryTest {
    private void verify(String prompt, boolean fail) {
        var notes = new HashMap<String,String>();
        notes.put("scope", "openid organization profile"); notes.put("state", "original-state");
        notes.put("code_challenge", "original-pkce"); notes.put("redirect_uri", "https://client.example/callback");
        if (prompt != null) notes.put("prompt", prompt);
        var before = new HashMap<>(notes);
        var broker = new HashMap<String,String>(); broker.put("BROKERED_CONTEXT", "rejected-person");
        var cleared = new HashSet<String>();
        var parent = (RootAuthenticationSessionModel) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{RootAuthenticationSessionModel.class}, (p,m,a) -> null);
        var session = (AuthenticationSessionModel) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{AuthenticationSessionModel.class}, (p,m,a) -> switch(m.getName()) {
            case "getClientNote" -> notes.get(a[0]);
            case "setClientNote" -> { notes.put((String)a[0], (String)a[1]); yield null; }
            case "removeClientNote" -> { notes.remove(a[0]); yield null; }
            case "getParentSession" -> parent;
            case "getRequiredActions" -> new HashSet<String>();
            case "clearAuthNotes" -> { broker.clear(); yield null; }
            case "setAuthNote" -> { broker.put((String)a[0], (String)a[1]); yield null; }
            case "setAuthenticatedUser" -> { assertNull(a[0]); cleared.add("person"); yield null; }
            case "clearExecutionStatus", "clearUserSessionNotes" -> { cleared.add(m.getName()); yield null; }
            default -> null;
        });
        try {
            BrokerAccountRetry.reauthenticate(session, () -> {
                assertEquals("login", notes.get("prompt"));
                assertFalse(broker.containsKey("BROKERED_CONTEXT"));
                for (String key : List.of("scope", "state", "code_challenge", "redirect_uri")) assertEquals(before.get(key),notes.get(key));
                if (fail) throw new IllegalStateException("provider failure");
                return null;
            });
            assertFalse(fail);
        } catch (IllegalStateException error) { assertTrue(fail); }
        assertEquals(before,notes);
        assertTrue(cleared.containsAll(Set.of("person", "clearExecutionStatus", "clearUserSessionNotes")));
    }
    @Test public void retryPreservesOriginalConsentPkceStateAndRedirect() { verify("consent", false); }
    @Test public void retryDoesNotLeaveAPromptWhenTheClientHadNone() { verify(null, false); }
    @Test public void failingProviderRestoresOriginalPrompt() { verify("consent", true); }
}
