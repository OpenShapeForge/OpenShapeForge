// SPDX-License-Identifier: BUSL-1.1
package com.openshapeforge.keycloak;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.UriBuilder;
import org.jboss.logging.Logger;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.AuthenticationProcessor;
import org.keycloak.authentication.Authenticator;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.utils.FormMessage;
import org.keycloak.services.resources.LoginActionsService;
import org.keycloak.services.util.AuthenticationFlowURLHelper;
import org.keycloak.sessions.AuthenticationSessionModel;

/** Sign in by proving the inbox: one mail carries a 6-digit code and a link.
 *
 * The link is the same URL as refreshing this login page plus the code, so it
 * only continues the login in the browser that asked for it (the auth-session
 * cookie decides; no session id is ever put in the link). A mail scanner or a
 * second device that opens it gets Keycloak's expired page, consumes nothing,
 * and the person types the code instead. A successful code is proof of the
 * address, so it also settles VERIFY_EMAIL, and a passkey enrolment that was
 * forced on the account becomes the skippable {@link PasskeyOffer}. */
public final class EmailSignIn implements Authenticator {
    private static final Logger LOG = Logger.getLogger(EmailSignIn.class);
    static final String CODE = "osf.email-sign-in.code";
    static final String SENT_AT = "osf.email-sign-in.sent-at";
    static final String ATTEMPTS = "osf.email-sign-in.attempts";
    static final String SENDS = "osf.email-sign-in.sends";
    static final String LINK_PARAM = "osf_email_code";
    static final int LENGTH = 6, MAX_ATTEMPTS = 5, MAX_SENDS = 5;
    static final long TTL_SECONDS = 600, RESEND_AFTER_SECONDS = 30;
    static final String VERIFY_EMAIL = UserModel.RequiredAction.VERIFY_EMAIL.name();
    static final String PASSKEY_ENROLMENT = "webauthn-register-passwordless";
    private static final SecureRandom RANDOM = new SecureRandom();

    @Override public void authenticate(AuthenticationFlowContext context) {
        var auth = context.getAuthenticationSession();
        String linked = context.getUriInfo().getQueryParameters().getFirst(LINK_PARAM);
        if (linked != null && auth.getAuthNote(CODE) != null) { verify(context, linked, "email_link"); return; }
        if (linked != null) { challenge(context, "osfEmailSignInExpired", true); return; }
        if (auth.getAuthNote(CODE) == null || expired(auth, now())) send(context);
        else challenge(context, null, true);
    }

    @Override public void action(AuthenticationFlowContext context) {
        var form = context.getHttpRequest().getDecodedFormParameters();
        if ("true".equals(form.getFirst("resend"))) { resend(context); return; }
        String code = form.getFirst("code");
        verify(context, code == null ? "" : code.replaceAll("\\s", ""), "email_code");
    }

    private void resend(AuthenticationFlowContext context) {
        var auth = context.getAuthenticationSession();
        if (resendWait(auth, now()) > 0) { challenge(context, null, true); return; }
        if (count(auth, SENDS) >= MAX_SENDS) { challenge(context, "osfEmailSignInTooManyAttempts", true); return; }
        send(context);
    }

    private void verify(AuthenticationFlowContext context, String code, String method) {
        var auth = context.getAuthenticationSession();
        if (auth.getAuthNote(CODE) == null || expired(auth, now())) {
            clearCode(auth);
            challenge(context, "osfEmailSignInExpired", true);
            return;
        }
        int attempts = count(auth, ATTEMPTS) + 1;
        auth.setAuthNote(ATTEMPTS, Integer.toString(attempts));
        if (!matches(auth.getAuthNote(CODE), code, salt(auth))) {
            if (attempts >= MAX_ATTEMPTS) clearCode(auth);
            context.getEvent().detail("osf.sign_in_method", method);
            context.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS, form(context,
                attempts >= MAX_ATTEMPTS ? "osfEmailSignInTooManyAttempts" : "osfEmailSignInInvalidCode", true, true));
            return;
        }
        clearCode(auth);
        auth.removeAuthNote(SENDS);
        UserModel user = context.getUser();
        if (!user.isEmailVerified()) user.setEmailVerified(true);
        user.removeRequiredAction(VERIFY_EMAIL);
        // An enrolment forced at account creation would otherwise stand between
        // this person and the app; PasskeyOffer asks instead, with a way out.
        user.removeRequiredAction(PASSKEY_ENROLMENT);
        auth.setAuthNote(PasskeyOffer.ELIGIBLE, "true");
        context.getEvent().detail("osf.sign_in_method", method);
        context.success();
    }

    private void send(AuthenticationFlowContext context) {
        var auth = context.getAuthenticationSession();
        String code = newCode();
        auth.setAuthNote(CODE, hash(code, salt(auth)));
        auth.setAuthNote(SENT_AT, Long.toString(now()));
        auth.setAuthNote(SENDS, Integer.toString(count(auth, SENDS) + 1));
        auth.removeAuthNote(ATTEMPTS);
        try {
            context.getSession().getProvider(EmailTemplateProvider.class)
                .setRealm(context.getRealm()).setUser(context.getUser()).setAuthenticationSession(auth)
                // Mutable: Keycloak adds its own attributes (user, realmName, ...).
                .send("osfEmailSignInSubject", List.of(), "osf-email-sign-in.ftl", new HashMap<>(Map.of(
                    "code", code, "link", link(context, code).toString(),
                    "ttlMinutes", TTL_SECONDS / 60)));
            challenge(context, null, true);
        } catch (EmailException error) {
            LOG.warnf(error, "Sending the sign-in email failed for realm %s", context.getRealm().getName());
            clearCode(auth);
            auth.removeAuthNote(SENT_AT); // nothing arrived, so resending must not wait
            challenge(context, "osfEmailSignInSendFailed", false);
        }
    }

    static URI link(AuthenticationFlowContext context, String code) {
        var auth = context.getAuthenticationSession();
        URI page = new AuthenticationFlowURLHelper(context.getSession(), context.getRealm(), context.getUriInfo())
            .getLastExecutionUrl(LoginActionsService.AUTHENTICATE_PATH, context.getExecution().getId(),
                auth.getClient().getClientId(), auth.getTabId(),
                AuthenticationProcessor.getClientData(context.getSession(), auth));
        return UriBuilder.fromUri(page).queryParam(LINK_PARAM, code).build();
    }

    private void challenge(AuthenticationFlowContext context, String error, boolean sent) {
        context.challenge(form(context, error, sent, false));
    }

    private Response form(AuthenticationFlowContext context, String error, boolean sent, boolean field) {
        var auth = context.getAuthenticationSession();
        var form = context.form()
            .setAttribute("osfEmail", context.getUser().getEmail())
            .setAttribute("osfCodeLength", LENGTH)
            .setAttribute("osfResendSeconds", resendWait(auth, now()))
            .setAttribute("osfMailSent", sent);
        if (error != null) {
            if (field) form.addError(new FormMessage("code", error));
            else form.setError(error);
        }
        else if (sent) form.setInfo("osfEmailSignInSent", context.getUser().getEmail());
        return form.createForm("osf-email-sign-in.ftl");
    }

    static long resendWait(AuthenticationSessionModel auth, long now) {
        String sentAt = auth.getAuthNote(SENT_AT);
        if (sentAt == null) return 0;
        return Math.max(0, Long.parseLong(sentAt) + RESEND_AFTER_SECONDS - now);
    }

    static boolean expired(AuthenticationSessionModel auth, long now) {
        String sentAt = auth.getAuthNote(SENT_AT);
        return sentAt == null || now - Long.parseLong(sentAt) > TTL_SECONDS;
    }

    static boolean matches(String stored, String code, String salt) {
        if (stored == null || code == null || code.length() != LENGTH) return false;
        return MessageDigest.isEqual(stored.getBytes(StandardCharsets.US_ASCII),
            hash(code, salt).getBytes(StandardCharsets.US_ASCII));
    }

    static String hash(String code, String salt) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest((salt + ":" + code).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static String newCode() {
        return String.format("%0" + LENGTH + "d", RANDOM.nextInt((int) Math.pow(10, LENGTH)));
    }

    private static String salt(AuthenticationSessionModel auth) {
        return auth.getParentSession().getId() + "." + auth.getTabId();
    }

    private static int count(AuthenticationSessionModel auth, String note) {
        String value = auth.getAuthNote(note);
        return value == null ? 0 : Integer.parseInt(value);
    }

    private static void clearCode(AuthenticationSessionModel auth) {
        auth.removeAuthNote(CODE);
        auth.removeAuthNote(ATTEMPTS);
    }

    private static long now() { return System.currentTimeMillis() / 1000; }

    @Override public boolean requiresUser() { return true; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) {
        return user.getEmail() != null && !user.getEmail().isBlank();
    }
    @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
    @Override public void close() { }
}
