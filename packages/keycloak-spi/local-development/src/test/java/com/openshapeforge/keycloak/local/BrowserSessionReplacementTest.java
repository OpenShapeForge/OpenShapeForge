// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak.local;

import java.lang.reflect.Proxy;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.models.*;
import org.keycloak.sessions.*;

public class BrowserSessionReplacementTest {
    @SuppressWarnings("unchecked")
    private static <T> T model(Class<T> type, Map<String, Object> answers) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
            (proxy, method, args) -> answers.get(method.getName()));
    }

    private static UserModel user(String id, boolean enabled, String serviceClient) {
        var answers = new java.util.HashMap<String, Object>();
        answers.put("getId", id); answers.put("getUsername", id);
        answers.put("isEnabled", enabled); answers.put("getServiceAccountClientLink", serviceClient);
        return model(UserModel.class, answers);
    }

    private static AuthenticationFlowContext context(UserSessionModel browser) {
        var sessions = (UserSessionProvider) Proxy.newProxyInstance(UserSessionProvider.class.getClassLoader(),
            new Class<?>[]{UserSessionProvider.class}, (proxy, method, args) -> {
                assertEquals("getUserSession", method.getName());
                assertEquals("this-browser", args[1]);
                return browser;
            });
        var session = model(KeycloakSession.class, Map.of("sessions", sessions));
        var root = model(RootAuthenticationSessionModel.class, Map.of("getId", "this-browser"));
        var auth = model(AuthenticationSessionModel.class, Map.of("getParentSession", root));
        return model(AuthenticationFlowContext.class, Map.of("getSession", session, "getAuthenticationSession", auth));
    }

    @Test public void replacesOnlyTheDifferentUserInThisBrowser() {
        var old = model(UserSessionModel.class, Map.of("getUser", user("previous", true, null)));
        assertSame(old, LocalAccountAuthenticator.browserSessionToReplace(context(old), user("selected", true, null)));
        assertNull(LocalAccountAuthenticator.browserSessionToReplace(context(old), user("previous", true, null)));
        assertNull(LocalAccountAuthenticator.browserSessionToReplace(context(null), user("selected", true, null)));
    }

    @Test public void rejectedSelectionsCannotEndAnExistingSession() {
        var old = model(UserSessionModel.class, Map.of("getUser", user("previous", true, null)));
        assertNull(LocalAccountAuthenticator.browserSessionToReplace(context(old), user("disabled", false, null)));
        assertNull(LocalAccountAuthenticator.browserSessionToReplace(context(old), user("service", true, "client")));
        assertNull(LocalAccountAuthenticator.browserSessionToReplace(context(old), null));
    }
}
