// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.ws.rs.core.MultivaluedMap;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.jboss.logging.Logger;
import org.keycloak.models.ClientModel;
import org.keycloak.models.ClientScopeModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.representations.idm.ClientPolicyExecutorConfigurationRepresentation;
import org.keycloak.services.clientpolicy.ClientPolicyContext;
import org.keycloak.services.clientpolicy.ClientPolicyException;
import org.keycloak.services.clientpolicy.context.DynamicClientRegisteredContext;
import org.keycloak.services.clientpolicy.context.AuthorizationRequestContext;
import org.keycloak.services.clientpolicy.executor.ClientPolicyExecutorProvider;

/** Binds validated RFC 8707 requests before native login and consent. */
public final class McpResourceScopeExecutor implements ClientPolicyExecutorProvider<McpResourceScopeExecutor.Configuration> {
    static final String BOUND_SCOPE = "osf.mcp-resource.bound-scope";
    private static final Logger LOG = Logger.getLogger(McpResourceScopeExecutor.class);
    private String configurationError;
    private final KeycloakSession session;
    private Map<String, Binding> resources = Map.of();

    public static final class Binding {
        @JsonProperty public String resource;
        @JsonProperty public String scope;
        @JsonProperty public boolean organization = true;
        @JsonProperty public boolean registration;
        @JsonProperty("registration-scopes") public List<String> registrationScopes = List.of();
    }

    public static final class Configuration extends ClientPolicyExecutorConfigurationRepresentation {
        @JsonProperty public List<Binding> resources = new ArrayList<>();
    }

    public McpResourceScopeExecutor(KeycloakSession session) { this.session = session; }
    @Override public String getProviderId() { return McpResourceScopeExecutorFactory.ID; }
    @Override public Class<Configuration> getExecutorConfigurationClass() { return Configuration.class; }
    @Override public void close() { }

    @Override public void setupConfiguration(Configuration config) {
        configurationError = null;
        try { configure(config); } catch (RuntimeException error) {
            resources = Map.of(); configurationError = "Invalid MCP resource policy configuration";
            LOG.warn(configurationError);
        }
    }

    private void configure(Configuration config) {
        if (config == null || config.resources == null) throw new IllegalArgumentException();
        Map<String, Binding> checked = new LinkedHashMap<>();
        Map<String, String> scopeModes = new LinkedHashMap<>();
        for (Binding binding : config.resources) {
            if (binding == null || binding.resource == null) throw new IllegalArgumentException();
            URI uri = URI.create(binding.resource);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getRawPath().isEmpty()
                    || binding.scope == null || (!binding.scope.matches("[a-z][a-z0-9:_-]{0,149}")
                        || Set.of("openid","profile","email","roles","organization","offline_access","address","phone").contains(binding.scope))
                    || checked.putIfAbsent(binding.resource, binding) != null)
                throw new IllegalArgumentException("Invalid or duplicate MCP resource binding");
            if (binding.registrationScopes == null || binding.registrationScopes.stream().anyMatch(name ->
                    name == null || !name.matches("[a-z][a-z0-9_-]*") || name.equals("openid") || (!binding.organization && name.equals("organization"))))
                throw new IllegalArgumentException("Invalid optional registration scope");
            if (!binding.registration && !binding.registrationScopes.isEmpty())
                throw new IllegalArgumentException("Supporting scopes require registration opt-in");
            binding.registrationScopes = List.copyOf(new java.util.TreeSet<>(binding.registrationScopes));
            String mode = binding.organization + ":" + binding.registration + ":" + binding.registrationScopes;
            String previous = scopeModes.putIfAbsent(binding.scope, mode);
            if (previous != null && !previous.equals(mode))
                throw new IllegalArgumentException("Resource aliases must use the same registration and organization policy");
        }
        if (checked.isEmpty()) throw new IllegalArgumentException("MCP resource policy needs explicit resource bindings");
        resources = Map.copyOf(checked);
    }

    @Override public void executeOnEvent(ClientPolicyContext context) throws ClientPolicyException {
        if (context instanceof DynamicClientRegisteredContext registered) {
            // Runs in the DCR transaction, before its response. No roles, default
            // scopes, callbacks or user grants are changed. Native DCR policies
            // still validate the registration and roll back a rejected request.
            if (configurationError != null) throw denied("invalid_client_metadata", configurationError);
            ClientModel client = registered.getTargetClient();
            for (Binding binding : resources.values()) {
                if (!binding.registration) continue;
                Set<String> capabilities = new LinkedHashSet<>(binding.registrationScopes);
                capabilities.add(binding.scope);
                for (String name : capabilities) {
                    if (client.getClientScopes(true).containsKey(name) || client.getClientScopes(false).containsKey(name)) continue;
                    ClientScopeModel scope = realmScope(name);
                    if (scope == null) {
                        LOG.warnf("Configured %s scope %s is unavailable during dynamic registration; requests requiring it remain denied", name.equals(binding.scope) ? "resource" : "supporting", name);
                        continue;
                    }
                    client.addClientScope(scope, false);
                }
            }
        } else if (context instanceof AuthorizationRequestContext authorization) {
            MultivaluedMap<String, String> params = authorization.getRequestParameters();
            List<String> requested = params.get("resource");
            if (requested != null && requested.size() != 1)
                throw denied("invalid_target", "Exactly one configured MCP resource is required");
            String resource = authorization.getAuthorizationEndpointRequest().getResource();
            if (resource == null) return;
            if (configurationError != null) throw denied("invalid_request", configurationError);
            Binding binding = resources.get(resource);
            if (binding == null) return; // Other resources keep their native scope policy.
            ClientModel client = authorization.getClient();
            if (client == null) return; // Native client validation owns this error.
            if (!client.getClientScopes(true).containsKey(binding.scope)
                    && !client.getClientScopes(false).containsKey(binding.scope))
                throw denied("invalid_scope", "The client is not registered for this MCP resource");
            List<String> scopes = params.get("scope");
            if (scopes != null && scopes.size() != 1)
                throw denied("invalid_scope", "Exactly one scope parameter is required");
            authorization.getAuthenticationSession().setClientNote(BOUND_SCOPE,
                    bindScopes(authorization.getAuthorizationEndpointRequest().getScope(), binding,
                        resources.values().stream().map(item -> item.scope).collect(java.util.stream.Collectors.toSet())));
        }
    }

    private ClientScopeModel realmScope(String name) throws ClientPolicyException {
        List<ClientScopeModel> matches = session.getContext().getRealm().getClientScopesStream()
                .filter(scope -> name.equals(scope.getName()) && "openid-connect".equals(scope.getProtocol())).toList();
        if (matches.size() > 1) throw denied("invalid_scope", "Configured MCP resource scope is ambiguous");
        return matches.isEmpty() ? null : matches.get(0);
    }

    static String bindScopes(String value, Binding binding) throws ClientPolicyException {
        return bindScopes(value, binding, Set.of(binding.scope));
    }

    static String bindScopes(String value, Binding binding, Set<String> resourceScopes) throws ClientPolicyException {
        Set<String> scopes = new LinkedHashSet<>(Arrays.asList((value == null ? "" : value).trim().split("\\s+")));
        scopes.remove("");
        if (scopes.stream().anyMatch(scope -> (scope.startsWith("mcp-resource:") || resourceScopes.contains(scope)) && !scope.equals(binding.scope)))
            throw denied("invalid_scope", "The requested scopes conflict with the MCP resource");
        if (!binding.organization) scopes.removeIf(scope -> scope.equals("organization") || scope.startsWith("organization:"));
        scopes.add(binding.scope);
        return String.join(" ", scopes);
    }

    private static ClientPolicyException denied(String error, String detail) {
        return new ClientPolicyException(error, detail);
    }
}
