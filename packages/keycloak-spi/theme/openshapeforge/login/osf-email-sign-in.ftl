<#ftl output_format="HTML" auto_esc=true>
<#-- SPDX-License-Identifier: BUSL-1.1
     Rendered by the osf-email-sign-in authenticator. Contract (also the
     Keycloakify page in consuming themes): osfEmail, osfCodeLength,
     osfResendSeconds, osfMailSent; field "code"; submit "resend=true". -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('code') displayInfo=true; section>
    <#if section = "header">
        ${msg("osfEmailSignInTitle")}
    <#elseif section = "form">
        <form id="kc-osf-email-sign-in-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormGroupClass!}">
                <label for="code" class="${properties.kcLabelClass!}">${msg("osfEmailSignInCodeLabel")}</label>
                <input id="code" name="code" type="text" class="${properties.kcInputClass!}" autofocus
                       inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*"
                       maxlength="${(osfCodeLength!6) + 2}"
                       aria-invalid="<#if messagesPerField.existsError('code')>true</#if>"/>
                <#if messagesPerField.existsError('code')>
                    <span id="input-error-code" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">${kcSanitize(messagesPerField.get('code'))?no_esc}</span>
                </#if>
            </div>
            <div class="${properties.kcFormButtonsClass!}">
                <button class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" type="submit">${msg("doLogIn")}</button>
                <button class="${properties.kcButtonClass!} ${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" name="resend" value="true" type="submit" formnovalidate
                        <#if (osfResendSeconds!0) gt 0>disabled data-osf-resend-seconds="${osfResendSeconds?c}"</#if>>${msg("osfEmailSignInResend")}</button>
            </div>
        </form>
    <#elseif section = "info">
        ${msg("osfEmailSignInHelp")}
    </#if>
</@layout.registrationLayout>
<script>
  // Re-enable "send again" when the server's wait is over; the server still decides.
  for (const button of document.querySelectorAll("[data-osf-resend-seconds]")) {
    setTimeout(() => { button.disabled = false; }, Number(button.dataset.osfResendSeconds) * 1000);
  }
</script>
