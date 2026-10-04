package com.openshapeforge.keycloak.local;

import org.junit.Test;
import static org.junit.Assert.*;

public class LocalAccountAuthenticatorTest {
    private static final String AUTH = "https://auth.hubble.localhost/realms/openshapeforge";
    private static final String CALLBACK = "https://hubble.localhost/signin-callback";

    @Test public void onlyLoopbackHttpOriginsAreAccepted() {
        for (String uri : new String[] { AUTH, CALLBACK, "http://127.0.0.1:8181", "http://[::1]:8181", "http://localhost" })
            assertTrue(uri, LocalAccountAuthenticator.localUri(uri));
        for (String uri : new String[] { "https://develop.example", "https://hubble.localhost.example", "https://localhost@evil.example", "https://evil@localhost", "file://localhost", "not a url" })
            assertFalse(uri, LocalAccountAuthenticator.localUri(uri));
        assertFalse(LocalAccountAuthenticator.localUri(null));
    }

    @Test public void optInAndRealmAndBothRequestOriginsAndCallbackAreRequired() {
        assertTrue(LocalAccountAuthenticator.allowed("true", "openshapeforge", "openshapeforge", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed(null, "openshapeforge", "openshapeforge", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("false", "openshapeforge", "openshapeforge", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", null, "openshapeforge", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "openshapeforge", "master", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "openshapeforge", "openshapeforge", "https://remote.example", AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "openshapeforge", "openshapeforge", AUTH, "https://remote.example", CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "openshapeforge", "openshapeforge", AUTH, AUTH, "https://remote.example/callback"));
    }
}
