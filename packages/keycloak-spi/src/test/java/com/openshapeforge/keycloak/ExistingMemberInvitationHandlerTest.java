// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.junit.Test;
import static org.junit.Assert.*;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.UserModel;

public class ExistingMemberInvitationHandlerTest {
    static final String ORIGIN = "https://app.example.test";
    static UserModel user(boolean enabled, boolean verified) {
        return EnrollmentContinuationTest.mock(UserModel.class, m -> switch (m) {
            case "isEnabled" -> enabled; case "isEmailVerified" -> verified; default -> null;
        });
    }
    static OrganizationModel org(boolean enabled, boolean member, String target) {
        return EnrollmentContinuationTest.mock(OrganizationModel.class, m -> switch (m) {
            case "isEnabled" -> enabled; case "isMember" -> member; case "getRedirectUrl" -> target; default -> null;
        });
    }
    @Test public void returnsOnlyAnEnabledExistingMemberToTheConfiguredApp() {
        assertEquals(ORIGIN + "/acme", ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN,
                org(true, true, ORIGIN + "/acme"), user(true, true)));
        assertNull(ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN, org(false, true, ORIGIN), user(true,true)));
        assertNull(ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN, org(true, false, ORIGIN), user(true,true)));
        assertNull(ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN, org(true, true, ORIGIN), user(false,true)));
        // An unverified member is returned too: the invitation link proves the address.
        assertEquals(ORIGIN, ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN, org(true, true, ORIGIN), user(true,false)));
        assertNull(ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN, null, user(true,true)));
        assertNull(ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN, org(true,true,ORIGIN), null));
    }
    @Test public void unconfiguredAndForeignReturnsKeepNativeHandling() {
        for (String target : new String[]{null, "", "https://evil.example/acme", "//evil.example", ORIGIN + "?next=x", ORIGIN + "#x"})
            assertNull(ExistingMemberInvitationHandler.existingMemberTarget(ORIGIN, org(true,true,target), user(true,true)));
        assertNull(ExistingMemberInvitationHandler.existingMemberTarget(null, org(true,true,ORIGIN), user(true,true)));
    }
}
