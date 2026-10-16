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

public final class McpResourceScopeAuthenticatorFactory implements AuthenticatorFactory {
    @Override public String getId() { return "osf-mcp-resource-scope-binding"; }
    @Override public Authenticator create(KeycloakSession session) { return new McpResourceScopeAuthenticator(); }
    @Override public String getDisplayType() { return "MCP resource scope binding"; }
    @Override public String getReferenceCategory() { return null; }
    @Override public boolean isConfigurable() { return false; }
    @Override public boolean isUserSetupAllowed() { return false; }
    @Override public Requirement[] getRequirementChoices() { return new Requirement[]{Requirement.REQUIRED,Requirement.DISABLED}; }
    @Override public String getHelpText() { return "Apply the server-only resource scope note before browser login conditions."; }
    @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
}
