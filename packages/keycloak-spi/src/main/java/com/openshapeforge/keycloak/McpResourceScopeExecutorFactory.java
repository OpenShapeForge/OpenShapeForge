// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.services.clientpolicy.executor.ClientPolicyExecutorProvider;
import org.keycloak.services.clientpolicy.executor.ClientPolicyExecutorProviderFactory;

public final class McpResourceScopeExecutorFactory implements ClientPolicyExecutorProviderFactory {
    public static final String ID = "osf-mcp-resource-scopes";
    @Override public ClientPolicyExecutorProvider create(KeycloakSession session) { return new McpResourceScopeExecutor(session); }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
    @Override public String getId() { return ID; }
    @Override public String getHelpText() { return "Bind configured MCP resources to optional client scopes during native DCR and authorization."; }
    @Override public List<ProviderConfigProperty> getConfigProperties() { return List.of(); }
}
