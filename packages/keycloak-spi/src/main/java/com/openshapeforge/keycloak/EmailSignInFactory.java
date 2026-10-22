// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel.Requirement;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

public final class EmailSignInFactory implements AuthenticatorFactory {
    public static final String ID = "osf-email-sign-in";
    private static final EmailSignIn SINGLETON = new EmailSignIn();
    @Override public String getId() { return ID; }
    @Override public Authenticator create(KeycloakSession session) { return SINGLETON; }
    @Override public String getDisplayType() { return "Email sign-in (code and same-browser link)"; }
    @Override public String getReferenceCategory() { return null; }
    @Override public boolean isConfigurable() { return false; }
    @Override public boolean isUserSetupAllowed() { return false; }
    @Override public Requirement[] getRequirementChoices() {
        return new Requirement[]{Requirement.ALTERNATIVE, Requirement.REQUIRED, Requirement.DISABLED};
    }
    @Override public String getHelpText() {
        return "Mail a one-time code and a link that only continues this browser's login; proves the address.";
    }
    @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
}
