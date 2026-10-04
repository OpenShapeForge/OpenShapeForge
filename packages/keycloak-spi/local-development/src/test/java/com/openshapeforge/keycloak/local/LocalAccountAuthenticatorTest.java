// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak.local;

import org.junit.Test;
import static org.junit.Assert.*;

public class LocalAccountAuthenticatorTest {
    private static final String AUTH = "https://auth.app.localhost/realms/development";
    private static final String CALLBACK = "https://app.localhost/signin-callback";

    @Test public void onlyLoopbackHttpOriginsAreAccepted() {
        for (String uri : new String[] { AUTH, CALLBACK, "http://127.0.0.1:8181", "http://[::1]:8181", "http://localhost" })
            assertTrue(uri, LocalAccountAuthenticator.localUri(uri));
        for (String uri : new String[] { "https://develop.example", "https://hubble.localhost.example", "https://localhost@evil.example", "https://evil@localhost", "file://localhost", "not a url" })
            assertFalse(uri, LocalAccountAuthenticator.localUri(uri));
        assertFalse(LocalAccountAuthenticator.localUri(null));
    }

    @Test public void disabledAndServiceAccountsCannotAuthenticate() {
        assertTrue(LocalAccountAuthenticator.eligible(true, null, "account"));
        assertFalse(LocalAccountAuthenticator.eligible(false, null, "account"));
        assertFalse(LocalAccountAuthenticator.eligible(true, "service-client", "account"));
        assertFalse(LocalAccountAuthenticator.eligible(false, "service-client", "account"));
    }

    @Test public void remotePeersFailClosedUnlessTheLocalLauncherExplicitlyTrustsTheGateway() {
        assertTrue(LocalAccountAuthenticator.localPeer("127.0.0.1", null));
        assertTrue(LocalAccountAuthenticator.localPeer("::1", null));
        assertFalse(LocalAccountAuthenticator.localPeer("192.0.2.1", null));
        assertFalse(LocalAccountAuthenticator.localPeer("localhost", "localhost"));
        assertFalse(LocalAccountAuthenticator.localPeer(null, null));
        assertFalse(LocalAccountAuthenticator.localPeer("192.0.2.1", "192.0.2.0/24,*"));
        assertTrue(LocalAccountAuthenticator.localPeer("192.0.2.1", "192.0.2.1"));
        assertFalse(LocalAccountAuthenticator.eligible(true, null, null));
    }

    @Test public void whitespaceAndCaseAreNormalizedWithoutWideningOrigins() {
        assertTrue(LocalAccountAuthenticator.allowed("true", "other, development", "development", AUTH, AUTH, CALLBACK));
        assertTrue(LocalAccountAuthenticator.localUri("HTTPS://AUTH.APP.LOCALHOST/"));
        assertFalse(LocalAccountAuthenticator.localUri("HTTPS://APP.LOCALHOST.EXAMPLE/"));
    }

    @Test public void optInAndRealmAndBothRequestOriginsAndCallbackAreRequired() {
        assertTrue(LocalAccountAuthenticator.allowed("true", "development", "development", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed(null, "development", "development", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("false", "development", "development", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", null, "development", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "development", "master", AUTH, AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "development", "development", "https://remote.example", AUTH, CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "development", "development", AUTH, "https://remote.example", CALLBACK));
        assertFalse(LocalAccountAuthenticator.allowed("true", "development", "development", AUTH, AUTH, "https://remote.example/callback"));
    }
}
