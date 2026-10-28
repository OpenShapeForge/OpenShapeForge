// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak.local;

import java.lang.reflect.Proxy;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.models.*;

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

    @Test public void replacesOnlyTheDifferentUserInThisBrowser() {
        var old = model(UserSessionModel.class, Map.of("getUser", user("previous", true, null)));
        assertSame(old, LocalAccountAuthenticator.differentUserSession(old, user("selected", true, null)));
        assertNull(LocalAccountAuthenticator.differentUserSession(old, user("previous", true, null)));
        assertNull(LocalAccountAuthenticator.differentUserSession(null, user("selected", true, null)));
    }

    @Test public void rejectedSelectionsCannotEndAnExistingSession() {
        var old = model(UserSessionModel.class, Map.of("getUser", user("previous", true, null)));
        assertNull(LocalAccountAuthenticator.differentUserSession(old, user("disabled", false, null)));
        assertNull(LocalAccountAuthenticator.differentUserSession(old, user("service", true, "client")));
        assertNull(LocalAccountAuthenticator.differentUserSession(old, null));
    }
}
