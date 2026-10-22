// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import org.keycloak.authentication.InitiatedActionSupport;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.models.Constants;
import org.keycloak.models.UserModel;
import org.keycloak.models.credential.WebAuthnCredentialModel;

/** After an email sign-in or an invited signup, ask, never demand, for a
 * passkey on this device.
 *
 * "Add" starts the native passkey enrolment as an application-initiated
 * action, so its page carries a cancel button: a device that cannot make a
 * passkey is never a dead end. "Not now" is remembered for {@link #QUIET_DAYS}. */
public final class PasskeyOffer implements RequiredActionProvider {
    public static final String ID = "osf-passkey-offer";
    static final String SKIPPED_AT = "osf.passkey-offer.skipped-at";
    /** Auth note: this login proved the inbox (email sign-in or invited signup), so offer. */
    static final String ELIGIBLE = "osf.passkey-offer.eligible";
    static final long QUIET_DAYS = 30;

    @Override public void evaluateTriggers(RequiredActionContext context) {
        var auth = context.getAuthenticationSession();
        if (!"true".equals(auth.getAuthNote(ELIGIBLE))) return;
        if (shouldOffer(hasPasskey(context.getUser()), context.getUser().getFirstAttribute(SKIPPED_AT), now()))
            auth.addRequiredAction(ID);
    }

    static boolean shouldOffer(boolean hasPasskey, String skippedAt, long now) {
        if (hasPasskey) return false;
        if (skippedAt == null) return true;
        try { return now - Long.parseLong(skippedAt) > QUIET_DAYS * 86_400; }
        catch (NumberFormatException unreadable) { return true; }
    }

    private static boolean hasPasskey(UserModel user) {
        return user.credentialManager().getStoredCredentialsByTypeStream(WebAuthnCredentialModel.TYPE_PASSWORDLESS)
            .findAny().isPresent();
    }

    @Override public void requiredActionChallenge(RequiredActionContext context) {
        context.challenge(context.form().createForm("osf-passkey-offer.ftl"));
    }

    @Override public void processAction(RequiredActionContext context) {
        String choice = context.getHttpRequest().getDecodedFormParameters().getFirst(ID);
        // Answered either way: Keycloak re-runs every trigger before the next
        // action, and an offer that re-adds itself would never let go.
        if ("add".equals(choice) || "skip".equals(choice))
            context.getAuthenticationSession().removeAuthNote(ELIGIBLE);
        if ("add".equals(choice)) {
            context.getAuthenticationSession().setClientNote(Constants.KC_ACTION, EmailSignIn.PASSKEY_ENROLMENT);
            context.success();
        } else if ("skip".equals(choice)) {
            context.getUser().setSingleAttribute(SKIPPED_AT, Long.toString(now()));
            context.success();
            // The same return to the organization's app that a finished passkey
            // enrolment gives (EnrollmentRegisterFactory), so skipping is never
            // a detour through Account Console.
            EnrollmentContinuation.resume(context);
            EnrollmentContinuation.replaceBrowserSession(context);
        } else {
            requiredActionChallenge(context);
        }
    }

    @Override public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.NOT_SUPPORTED; }
    private static long now() { return System.currentTimeMillis() / 1000; }
    @Override public void close() { }
}
