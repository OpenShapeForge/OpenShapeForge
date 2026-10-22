// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.lang.reflect.Proxy;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.locale.LocaleSelectorProvider;
import org.keycloak.models.IdentityProviderModel;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.broker.provider.BrokeredIdentityContext;
import org.keycloak.http.HttpRequest;
import jakarta.ws.rs.core.MultivaluedHashMap;
import org.keycloak.sessions.RootAuthenticationSessionModel;

public class BrokerAccountRetryTest {
    private void verify(String prompt, boolean fail) {
        var notes = new HashMap<String,String>();
        notes.put("scope", "openid organization profile"); notes.put("state", "original-state");
        notes.put("code_challenge", "original-pkce"); notes.put("redirect_uri", "https://client.example/callback");
        if (prompt != null) notes.put("prompt", prompt);
        var before = new HashMap<>(notes);
        var broker = new HashMap<String,String>(); broker.put("BROKERED_CONTEXT", "rejected-person"); broker.put(LocaleSelectorProvider.USER_REQUEST_LOCALE, "nl");
        var cleared = new HashSet<String>();
        var parent = (RootAuthenticationSessionModel) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{RootAuthenticationSessionModel.class}, (p,m,a) -> null);
        var session = (AuthenticationSessionModel) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{AuthenticationSessionModel.class}, (p,m,a) -> switch(m.getName()) {
            case "getAuthNote" -> broker.get(a[0]);
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
                assertEquals("select_account", notes.get("prompt"));
                assertFalse(broker.containsKey("BROKERED_CONTEXT"));
                assertEquals("nl", broker.get(LocaleSelectorProvider.USER_REQUEST_LOCALE));
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

    private IdentityProviderModel provider(String kind, String prompt) {
        var model = new IdentityProviderModel(); model.setAlias("synthetic"); model.setProviderId(kind); model.setEnabled(true);
        model.setConfig(new HashMap<>()); if (prompt != null) model.getConfig().put("prompt", prompt); return model;
    }
    @Test public void onlyEnabledOidcWithoutFixedPromptCanRetry() {
        assertTrue(BrokerAccountRetry.supported(provider("oidc", null)));
        assertTrue(BrokerAccountRetry.supported(provider("oidc", "")));
        for (String fixed : List.of("login", "none", " ")) assertFalse(BrokerAccountRetry.supported(provider("oidc", fixed)));
        assertFalse(BrokerAccountRetry.supported(provider("saml", null)));
        var disabled = provider("oidc", null); disabled.setEnabled(false); assertFalse(BrokerAccountRetry.supported(disabled));
    }
    private List<String> action(Map<String,String> fields, IdentityProviderModel provider) {
        var values = new MultivaluedHashMap<String,String>(); fields.forEach(values::putSingle);
        var calls = new ArrayList<String>();
        var request = (HttpRequest) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{HttpRequest.class}, (p,m,a) -> m.getName().equals("getDecodedFormParameters") ? values : null);
        var context = (AuthenticationFlowContext) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{AuthenticationFlowContext.class}, (p,m,a) -> switch(m.getName()) {
            case "getHttpRequest" -> request;
            case "cancelLogin" -> { calls.add("cancel"); yield null; }
            case "failure" -> { assertEquals(AuthenticationFlowError.ACCESS_DENIED,a[0]); calls.add("denied"); yield null; }
            case "success", "setUser" -> throw new AssertionError("An unlinked identity must never authenticate.");
            default -> null;
        });
        new BrokerAccountRetry().actionImpl(context, null, new BrokeredIdentityContext("unlinked", provider));
        return calls;
    }
    @Test public void invalidPostCannotStartAuthentication() {
        assertEquals(List.of("denied"), action(Map.of(), provider("oidc", null)));
        assertEquals(List.of("denied"), action(Map.of("retry", "false"), provider("oidc", null)));
    }
    @Test public void cancelTerminatesWithoutRetry() { assertEquals(List.of("cancel"), action(Map.of("cancel", "true"), provider("oidc", null))); }
    @Test public void fixedPromptCannotSilentlyReuseTheRejectedAccount() { assertEquals(List.of("denied"), action(Map.of("retry", "true"), provider("oidc", " "))); }
    @Test public void providerStartFailureIsDeniedRatherThanThrown() { assertEquals(List.of("denied"), action(Map.of("retry", "true"), provider("oidc", null))); }
}
