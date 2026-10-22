// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.authentication.actiontoken.inviteorg.InviteOrgActionToken;
import org.keycloak.models.UserModel;
import org.keycloak.sessions.AuthenticationSessionModel;

public class EmailSignInTest {
    static AuthenticationSessionModel notes(Map<String,String> notes) {
        return (AuthenticationSessionModel) Proxy.newProxyInstance(AuthenticationSessionModel.class.getClassLoader(),
            new Class<?>[]{AuthenticationSessionModel.class}, (p, m, a) -> switch (m.getName()) {
                case "getAuthNote" -> notes.get(a[0]);
                default -> null;
            });
    }

    @Test public void codesAreSixDigitsAndOnlyTheSameCodeAndSessionMatch() {
        for (int i = 0; i < 200; i++) assertTrue(EmailSignIn.newCode().matches("\\d{6}"));
        String stored = EmailSignIn.hash("042917", "root.tab");
        assertTrue(EmailSignIn.matches(stored, "042917", "root.tab"));
        assertFalse(EmailSignIn.matches(stored, "042918", "root.tab"));
        assertFalse("a code from another login session", EmailSignIn.matches(stored, "042917", "other.tab"));
        assertFalse(EmailSignIn.matches(stored, "42917", "root.tab"));
        assertFalse(EmailSignIn.matches(null, "042917", "root.tab"));
        assertFalse(EmailSignIn.matches(stored, null, "root.tab"));
    }

    @Test public void aCodeExpiresAfterTenMinutesAndResendWaitsThirtySeconds() {
        var auth = notes(Map.of(EmailSignIn.SENT_AT, "1000"));
        assertFalse(EmailSignIn.expired(auth, 1000 + 600));
        assertTrue(EmailSignIn.expired(auth, 1000 + 601));
        assertTrue("never sent reads as expired", EmailSignIn.expired(notes(Map.of()), 1000));
        assertEquals(30, EmailSignIn.resendWait(auth, 1000));
        assertEquals(1, EmailSignIn.resendWait(auth, 1029));
        assertEquals(0, EmailSignIn.resendWait(auth, 1030));
        assertEquals(0, EmailSignIn.resendWait(notes(Map.of()), 1000));
    }

    @Test public void passkeyIsOfferedUntilThereIsOneOrItWasDeclinedRecently() {
        long now = 10_000_000;
        assertTrue(PasskeyOffer.shouldOffer(false, null, now));
        assertFalse(PasskeyOffer.shouldOffer(true, null, now));
        assertFalse(PasskeyOffer.shouldOffer(false, Long.toString(now - 86_400), now));
        assertTrue(PasskeyOffer.shouldOffer(false, Long.toString(now - 31 * 86_400), now));
        assertTrue(PasskeyOffer.shouldOffer(false, "garbage", now));
    }

    static final class User {
        boolean verified;
        final Set<String> actions = new HashSet<>(Set.of("VERIFY_EMAIL"));
        UserModel model(String email) {
            return (UserModel) Proxy.newProxyInstance(UserModel.class.getClassLoader(), new Class<?>[]{UserModel.class},
                (p, m, a) -> switch (m.getName()) {
                    case "getEmail" -> email;
                    case "setEmailVerified" -> { verified = (Boolean) a[0]; yield null; }
                    case "removeRequiredAction" -> { actions.remove(a[0].toString()); yield null; }
                    default -> null;
                });
        }
    }

    @Test public void anInvitationForTheSameAddressProvesIt() {
        var token = new InviteOrgActionToken("user-id", 2_000_000_000, "Sven@Example.test", "account");
        var user = new User();
        assertTrue(InvitationEmailVerified.markVerified(token, user.model("sven@example.test")));
        assertTrue(user.verified);
        assertFalse(user.actions.contains("VERIFY_EMAIL"));

        var other = new User();
        assertFalse(InvitationEmailVerified.markVerified(token, other.model("someone@example.test")));
        assertFalse(other.verified);
        assertFalse(InvitationEmailVerified.markVerified(null, other.model("sven@example.test")));
        assertFalse(InvitationEmailVerified.markVerified(token, null));
    }
}
