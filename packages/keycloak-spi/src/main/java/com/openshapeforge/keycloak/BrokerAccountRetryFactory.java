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

public final class BrokerAccountRetryFactory implements AuthenticatorFactory {
    @Override public String getId() { return "osf-broker-account-retry"; }
    @Override public Authenticator create(KeycloakSession session) { return new BrokerAccountRetry(); }
    @Override public String getDisplayType() { return "Deny unlinked identity with account retry"; }
    @Override public String getReferenceCategory() { return null; }
    @Override public boolean isConfigurable() { return false; }
    @Override public boolean isUserSetupAllowed() { return false; }
    @Override public Requirement[] getRequirementChoices() { return new Requirement[]{Requirement.REQUIRED,Requirement.DISABLED}; }
    @Override public String getHelpText() { return "Deny an unlinked OIDC identity and offer reauthentication through the same provider."; }
    @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
}
