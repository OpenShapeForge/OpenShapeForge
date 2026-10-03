package com.openshapeforge.keycloak;

import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Stream;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.models.*;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.services.managers.AuthenticationManager;

public class EnrollmentContinuationTest {
    static final String ORIGIN = "https://app.example.test";
    @SuppressWarnings("unchecked")
    static <T> T mock(Class<T> type, Function<String,Object> response) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                (proxy, method, args) -> response.apply(method.getName()));
    }
    static final class Fixture {
        boolean verified = true, enabled = true, organizationEnabled = true;
        String clientId = "account", origin = ORIGIN, target = ORIGIN + "/acme";
        int memberships = 1;
        RequiredActionContext.Status status = RequiredActionContext.Status.SUCCESS;
        final Map<String,String> notes = new HashMap<>();
        String redirect;
        Fixture() { notes.put(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS, "true"); }
        RequiredActionContext context() {
            var user = mock(UserModel.class, m -> switch(m) {
                case "isEmailVerified" -> verified; case "isEnabled" -> enabled; default -> null;
            });
            var client = mock(ClientModel.class, m -> switch(m) {
                case "getClientId" -> clientId; case "getAttribute" -> origin; default -> null;
            });
            var organization = mock(OrganizationModel.class, m -> switch(m) {
                case "isEnabled" -> organizationEnabled; case "getRedirectUrl" -> target; default -> null;
            });
            var provider = mock(OrganizationProvider.class, m -> m.equals("getByMember")
                ? Stream.generate(() -> organization).limit(memberships) : null);
            var session = mock(KeycloakSession.class, m -> m.equals("getProvider") ? provider : null);
            var auth = (AuthenticationSessionModel) Proxy.newProxyInstance(AuthenticationSessionModel.class.getClassLoader(),
                new Class<?>[]{AuthenticationSessionModel.class}, (p,m,a) -> switch(m.getName()) {
                    case "getClient" -> client;
                    case "getAuthNote" -> notes.get(a[0]);
                    case "removeAuthNote" -> notes.remove(a[0]);
                    case "setRedirectUri" -> { redirect = (String)a[0]; yield null; }
                    default -> null;
                });
            return mock(RequiredActionContext.class, m -> switch(m) {
                case "getStatus" -> status; case "getUser" -> user; case "getSession" -> session;
                case "getAuthenticationSession" -> auth; default -> null;
            });
        }
        void unchanged() {
            EnrollmentContinuation.resume(context());
            assertNull(redirect);
            assertEquals("true", notes.get(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS));
        }
    }
    @Test public void resumesOnlyValidatedEnrollmentAndLeavesOtherNotesAlone() {
        var f = new Fixture(); f.notes.put("unrelated", "keep");
        EnrollmentContinuation.resume(f.context());
        assertEquals(ORIGIN + "/acme", f.redirect);
        assertFalse(f.notes.containsKey(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS));
        assertEquals("keep", f.notes.get("unrelated"));
    }
    @Test public void rejectedOrCancelledNativeWebAuthnNeverResumes() {
        for (var status : RequiredActionContext.Status.values()) if(status != RequiredActionContext.Status.SUCCESS) {
            var f = new Fixture(); f.status = status; f.unchanged();
        }
    }
    @Test public void refusesUnverifiedDisabledUnconfiguredAndOtherClients() {
        var f = new Fixture(); f.verified=false; f.unchanged();
        f = new Fixture(); f.enabled=false; f.unchanged();
        f = new Fixture(); f.origin=null; f.unchanged();
        f = new Fixture(); f.clientId="other-client"; f.unchanged();
    }
    @Test public void refusesAbsentDisabledAndAmbiguousOrganizations() {
        for(int count : new int[]{0,2,3}) { var f = new Fixture(); f.memberships=count; f.unchanged(); }
        var f = new Fixture(); f.organizationEnabled=false; f.unchanged();
    }
    @Test public void doesNotAlterExistingNormalLogin() {
        var f = new Fixture(); f.notes.clear(); EnrollmentContinuation.resume(f.context()); assertNull(f.redirect);
    }
    @Test public void rejectsUntrustedOrMalformedReturns() {
        for(String target : new String[]{null,"", "https://evil.example/", "https://app.example.test.evil/", "//app.example.test/x",
                "http://app.example.test/x", "https://user@app.example.test/x", ORIGIN+"/x#fragment", ORIGIN+"/x?next=https://evil.example", "not a uri"}) {
            var f = new Fixture(); f.target=target; f.unchanged();
        }
        for(String origin : new String[]{"http://app.example.test","https://app.example.test/path",ORIGIN+"?x=y",ORIGIN+"#frag"}) {
            assertFalse(EnrollmentContinuation.allowedTarget(origin,origin));
        }
        assertTrue(EnrollmentContinuation.allowedTarget("http://127.0.0.1:3932","http://127.0.0.1:3932/acme"));
        assertFalse(EnrollmentContinuation.allowedTarget("http://127.0.0.1:3932","http://127.0.0.1:3933/acme"));
    }
}
