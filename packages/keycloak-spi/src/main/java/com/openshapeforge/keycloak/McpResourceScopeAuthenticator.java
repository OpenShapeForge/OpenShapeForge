// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.OAuth2Constants;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.Authenticator;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/** First browser execution: project the validated server-only binding into native scope state. */
public final class McpResourceScopeAuthenticator implements Authenticator {
    @Override public void authenticate(AuthenticationFlowContext context) {
        var session = context.getAuthenticationSession();
        String bound = session.getAuthNote(McpResourceScopeExecutor.BOUND_SCOPE);
        if (bound != null) {
            session.setClientNote(OAuth2Constants.SCOPE, bound);
            session.removeAuthNote(McpResourceScopeExecutor.BOUND_SCOPE);
        }
        context.success();
    }
    @Override public void action(AuthenticationFlowContext context) { authenticate(context); }
    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
    @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
    @Override public void close() { }
}
