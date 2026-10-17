// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import jakarta.ws.rs.core.MultivaluedHashMap;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.LinkedHashSet;
import java.util.HashMap;
import org.keycloak.authentication.AuthenticationFlowContext;
import java.util.function.BiFunction;
import java.util.stream.Stream;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.models.*;
import org.keycloak.services.clientpolicy.ClientPolicyException;
import org.keycloak.services.clientpolicy.context.DynamicClientRegisteredContext;
import org.keycloak.services.clientpolicy.context.AuthorizationRequestContext;
import org.keycloak.services.clientregistration.ClientRegistrationContext;
import org.keycloak.protocol.oidc.endpoints.request.AuthorizationEndpointRequest;
import org.keycloak.sessions.AuthenticationSessionModel;

public class McpResourceScopeExecutorTest {
    @SuppressWarnings("unchecked")
    static <T> T mock(Class<T> type, BiFunction<String,Object[],Object> action) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                (proxy, method, args) -> action.apply(method.getName(), args));
    }
    static McpResourceScopeExecutor.Binding binding(String path, String scope, boolean organization) {
        var binding = new McpResourceScopeExecutor.Binding();
        binding.resource = "https://app.example.test/" + path;
        binding.scope = scope; binding.organization = organization; binding.registration = !organization; return binding;
    }
    final McpResourceScopeExecutor.Binding control = binding("admin/mcp", "mcp-resource:control", false);
    final McpResourceScopeExecutor.Binding tenant = binding("acme/mcp", "mcp-resource:acme", true);
    boolean scopeAvailable=true, supportingAvailable=true, defaultAttached=false;
    int scopeAdds;
    int scopeReads;
    final Map<String,String> notes=new HashMap<>(), clientNotes=new HashMap<>();
    final Set<String> attached = new LinkedHashSet<>();
    final ClientScopeModel scope = mock(ClientScopeModel.class, (m,a) -> switch(m) {
        case "getName" -> control.scope; case "getProtocol" -> "openid-connect"; default -> null;
    });
    final RealmModel realm = mock(RealmModel.class, (m,a) -> m.equals("getClientScopesStream") ? realmScopes() : m.equals("isEventsEnabled") ? false : m.equals("getEventsListenersStream") ? Stream.empty() : null);
    final ClientModel client = mock(ClientModel.class, (m,a) -> switch(m) {
        case "getClientScopes" -> Boolean.TRUE.equals(a[0]) ? defaultAttached ? Map.of(control.scope,scope) : Map.of() : attached.stream().collect(java.util.stream.Collectors.toMap(name -> name, name -> namedScope(name)));
        case "addClientScope" -> { assertEquals(false,a[1]); attached.add(((ClientScopeModel)a[0]).getName()); scopeAdds++; yield null; }
        default -> throw new AssertionError("Unexpected client mutation/read " + m);
    });
    final ClientProvider clients = mock(ClientProvider.class, (m,a) -> m.equals("getClientByClientId") ? client : null);
    final KeycloakContext kcContext = mock(KeycloakContext.class, (m,a) -> m.equals("getRealm") ? realm : null);
    final KeycloakSessionFactory factory=mock(KeycloakSessionFactory.class,(m,a)->m.equals("getProviderFactoriesStream")?Stream.empty():null);
    final KeycloakSession session = mock(KeycloakSession.class, (m,a) -> switch(m) {
        case "getContext" -> kcContext; case "clients" -> clients; case "getKeycloakSessionFactory" -> factory; default -> null;
    });
    ClientScopeModel namedScope(String name) { return mock(ClientScopeModel.class,(m,a)->m.equals("getName")?name:m.equals("getProtocol")?"openid-connect":null); }
    Stream<ClientScopeModel> realmScopes() { scopeReads++;return scopeAvailable?(supportingAvailable?Stream.of(scope,namedScope("profile"),namedScope("roles")):Stream.of(scope)):Stream.empty(); }
    McpResourceScopeExecutor executor() {
        var configuration = new McpResourceScopeExecutor.Configuration(); configuration.resources = List.of(control);
        var executor = new McpResourceScopeExecutor(session); executor.setupConfiguration(configuration); return executor;
    }
    AuthorizationRequestContext event(MultivaluedHashMap<String,String> params) {
        var request=new AuthorizationEndpointRequest();
        // Native request has getters only. Populate the parse result as native
        // parsing does; production code never reflects or modifies this object.
        try {
            for(String name:List.of("resource","scope")) {
                var field=AuthorizationEndpointRequest.class.getDeclaredField(name);
                field.setAccessible(true);field.set(request,params.getFirst(name));
            }
        } catch(ReflectiveOperationException error) { throw new AssertionError(error); }
        var auth=mock(AuthenticationSessionModel.class,(m,a)->switch(m) {
            case "getClient" -> client;
            case "setAuthNote" -> {notes.put((String)a[0],(String)a[1]);yield null;}
            case "getAuthNote" -> notes.get(a[0]);
            case "removeAuthNote" -> {notes.remove(a[0]);yield null;}
            case "setClientNote" -> {clientNotes.put((String)a[0],(String)a[1]);yield null;}
            case "getClientNote" -> clientNotes.get(a[0]);
            default -> null;
        });
        return new AuthorizationRequestContext(null,request,null,params,auth);
    }
    @Test public void nativeDcrGetsOptionalScopeBeforeResponseAndReplayDoesNotDuplicate() throws Exception {
        var registration = mock(ClientRegistrationContext.class, (m,a) -> m.equals("getSession") ? session : null);
        var event = new DynamicClientRegisteredContext(registration, client, null, realm);
        control.registrationScopes=List.of("profile","roles");
        var executor = executor(); executor.executeOnEvent(event); executor.executeOnEvent(event);
        assertEquals(Set.of(control.scope,"profile","roles"),attached);assertEquals(3,scopeAdds);
    }
    @Test public void authorizationBindsTheResourceWithoutClientWrites() throws Exception {
        attached.add(control.scope); var params = new MultivaluedHashMap<String,String>();
        params.putSingle("resource",control.resource); params.putSingle("scope","openid email organization:*");
        var authorization=event(params); executor().executeOnEvent(authorization);
        assertEquals("openid email mcp-resource:control",clientNotes.get(McpResourceScopeExecutor.BOUND_SCOPE));
        // KC_RESTART snapshots client notes before the first authenticator.
        clientNotes.put("scope","openid email organization:*");
        var snapshot=new HashMap<>(clientNotes); clientNotes.clear(); clientNotes.putAll(snapshot);
        var event=new org.keycloak.events.EventBuilder(realm,session);
        var flow=mock(AuthenticationFlowContext.class,(m,a)->switch(m) {
            case "getAuthenticationSession" -> authorization.getAuthenticationSession(); case "getEvent" -> event; default -> null;
        });
        new McpResourceScopeAuthenticator().authenticate(flow);
        new McpResourceScopeAuthenticator().authenticate(flow);
        assertEquals("openid email mcp-resource:control",clientNotes.get("scope"));
        assertTrue(notes.isEmpty());
        assertEquals("openid email organization:*",params.getFirst("scope"));
    }
    @Test public void unregisteredResourceScopeFailsClosed() {
        var params = new MultivaluedHashMap<String,String>(); params.putSingle("resource",control.resource);
        assertThrows(ClientPolicyException.class, () -> executor().executeOnEvent(event(params)));
    }
    @Test public void multipleResourcesAndDuplicateScopesFailClosed() {
        attached.add(control.scope); var params = new MultivaluedHashMap<String,String>();
        params.add("resource",control.resource); params.add("resource",control.resource);
        assertThrows(ClientPolicyException.class, () -> executor().executeOnEvent(event(params)));
        params.putSingle("resource",control.resource); params.add("scope","openid"); params.add("scope","email");
        assertThrows(ClientPolicyException.class, () -> executor().executeOnEvent(event(params)));
    }
    @Test public void otherResourcesAndRequestsWithoutResourceStayNative() throws Exception {
        var params = new MultivaluedHashMap<String,String>(); params.putSingle("scope","openid organization");
        executor().executeOnEvent(event(params));
        params.putSingle("resource",tenant.resource);
        executor().executeOnEvent(event(params));
        assertEquals("openid organization",params.getFirst("scope")); assertTrue(attached.isEmpty());
    }
    @Test public void tenantBindingKeepsOrganizationAndRejectsControlScope() throws Exception {
        assertEquals("openid organization mcp-resource:acme",McpResourceScopeExecutor.bindScopes("openid organization",tenant,Set.of(control.scope,tenant.scope)));
        assertThrows(ClientPolicyException.class, () -> McpResourceScopeExecutor.bindScopes("openid mcp-resource:control",tenant,Set.of(control.scope,tenant.scope)));
        assertThrows(ClientPolicyException.class, () -> McpResourceScopeExecutor.bindScopes("openid mcp-resource:acme",control,Set.of(control.scope,tenant.scope)));
    }
    void assertInvalid(McpResourceScopeExecutor.Configuration config) {
        var executor=new McpResourceScopeExecutor(session);executor.setupConfiguration(config);
        var params=new MultivaluedHashMap<String,String>();params.putSingle("resource",control.resource);
        assertThrows(ClientPolicyException.class,()->executor.executeOnEvent(event(params)));
    }
    @Test public void missingScopeDoesNotBreakUnrelatedDcrAndUnboundClientsRemainDenied() throws Exception {
        control.registrationScopes=List.of("profile");supportingAvailable=false;
        var partial=mock(ClientRegistrationContext.class,(m,a)->m.equals("getSession")?session:null);
        executor().executeOnEvent(new DynamicClientRegisteredContext(partial,client,null,realm));
        assertEquals(Set.of(control.scope),attached);attached.clear();
        scopeAvailable=false;var registration=mock(ClientRegistrationContext.class,(m,a)->m.equals("getSession")?session:null);
        executor().executeOnEvent(new DynamicClientRegisteredContext(registration,client,null,realm));
        assertTrue(attached.isEmpty());
        var params=new MultivaluedHashMap<String,String>();params.putSingle("resource",control.resource);
        assertThrows(ClientPolicyException.class,()->executor().executeOnEvent(event(params)));
    }
    @Test public void alreadyDefaultScopeNeedsNoRealmLookupOrClientWrite() throws Exception {
        defaultAttached=true;var registration=mock(ClientRegistrationContext.class,(m,a)->m.equals("getSession")?session:null);
        executor().executeOnEvent(new DynamicClientRegisteredContext(registration,client,null,realm));
        assertTrue(attached.isEmpty());assertEquals(0,scopeReads);
    }
    @Test public void bindingsNotOptedIntoRegistrationDoNotBroadenClients() throws Exception {
        control.registration=false;var registration=mock(ClientRegistrationContext.class,(m,a)->m.equals("getSession")?session:null);
        executor().executeOnEvent(new DynamicClientRegisteredContext(registration,client,null,realm));
        assertTrue(attached.isEmpty());assertEquals(0,scopeReads);
    }
    @Test public void productResourceScopeBindsWithoutUsingTheOrganizationScopeNamespace() throws Exception {
        control.scope="product-shared-mcp";
        var registration=mock(ClientRegistrationContext.class,(m,a)->m.equals("getSession")?session:null);
        executor().executeOnEvent(new DynamicClientRegisteredContext(registration,client,null,realm));
        assertEquals(Set.of("product-shared-mcp"),attached);
        var params=new MultivaluedHashMap<String,String>();
        params.putSingle("resource",control.resource);params.putSingle("scope","openid profile");
        executor().executeOnEvent(event(params));
        assertEquals("openid profile product-shared-mcp",clientNotes.get(McpResourceScopeExecutor.BOUND_SCOPE));
        var configured=Set.of("product-shared-mcp","mcp-resource:acme");
        assertThrows(ClientPolicyException.class,()->McpResourceScopeExecutor.bindScopes("mcp-resource:acme",control,configured));
        assertThrows(ClientPolicyException.class,()->McpResourceScopeExecutor.bindScopes("product-shared-mcp",tenant,configured));
        assertEquals("openid organization mcp-resource:acme",McpResourceScopeExecutor.bindScopes("openid organization",tenant,configured));
    }
    @Test public void authorizationRejectsAnotherConfiguredProductScopeInEitherDirection() throws Exception {
        control.scope="product-shared-mcp";
        var other=binding("other/mcp","product-other-mcp",true);
        var config=new McpResourceScopeExecutor.Configuration();config.resources=List.of(control,other);
        var executor=new McpResourceScopeExecutor(session);executor.setupConfiguration(config);
        attached.add(control.scope);attached.add(other.scope);
        var params=new MultivaluedHashMap<String,String>();
        params.putSingle("resource",control.resource);params.putSingle("scope","openid product-other-mcp");
        assertThrows(ClientPolicyException.class,()->executor.executeOnEvent(event(params)));
        params.putSingle("resource",other.resource);params.putSingle("scope","openid product-shared-mcp");
        assertThrows(ClientPolicyException.class,()->executor.executeOnEvent(event(params)));
    }
    @Test public void supportingScopesCannotBypassAnotherResourcesRegistrationOptOut() throws Exception {
        control.scope="product-a";control.registrationScopes=List.of("product-b");
        var other=binding("other/mcp","product-b",true);other.registration=false;
        var config=new McpResourceScopeExecutor.Configuration();config.resources=List.of(control,other);
        assertInvalid(config);
        // Listing the binding's own resource as supporting scope is invalid too.
        control.registrationScopes=List.of("product-a");assertInvalid(config);
        assertTrue(attached.isEmpty());assertEquals(0,scopeAdds);
    }
    @Test public void resourceScopesRejectIdentityScopesAndUnsafeTokens() throws Exception {
        for(String name:List.of("openid","profile","email","roles","organization","offline_access","address","phone","basic","acr","web-origins","microprofile-jwt","organization:acme","org:acme", "has space", "scope/other", "A-scope", "a".repeat(151))) {
            var bad=binding("api/mcp",name,true);
            var config=new McpResourceScopeExecutor.Configuration();config.resources=List.of(bad);assertInvalid(config);
        }
    }
    @Test public void configurationRejectsAmbiguousAndUnsafeResources() throws Exception {
        var config = new McpResourceScopeExecutor.Configuration();
        for (String name : java.util.Arrays.asList(null,"openid","Profile","mcp-resource:other","organization")) {
            var bad=binding("invalid",control.scope,false);bad.registrationScopes=java.util.Arrays.asList(name);config.resources=List.of(bad);assertInvalid(config);
        }
        var disabled=binding("disabled",control.scope,false);disabled.registration=false;disabled.registrationScopes=List.of("profile");config.resources=List.of(disabled);assertInvalid(config);
        var compatible=binding("alias",control.scope,false);compatible.registrationScopes=List.of("roles","profile","roles");control.registrationScopes=List.of("profile","roles");
        config.resources=List.of(control,compatible);var valid=new McpResourceScopeExecutor(session);valid.setupConfiguration(config);
        var registration=mock(ClientRegistrationContext.class,(m,a)->m.equals("getSession")?session:null);
        valid.executeOnEvent(new DynamicClientRegisteredContext(registration,client,null,realm));assertEquals(Set.of(control.scope,"profile","roles"),attached);
        config.resources = List.of(control,control);
        assertInvalid(config);
        for (String resource : List.of("http://app.example.test/admin/mcp","https://u@app.example.test/admin/mcp","https://app.example.test/admin/mcp?x=1","https://app.example.test/admin/mcp#frag")) {
            var bad = binding("x",control.scope,false); bad.resource=resource; config.resources=List.of(bad);
            assertInvalid(config);
        }
        var alias = binding("admin",control.scope,true); config.resources=List.of(control,alias);
        assertInvalid(config);
    }
}
