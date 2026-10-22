<#ftl output_format="HTML" auto_esc=true>
<#-- SPDX-License-Identifier: BUSL-1.1
     Rendered by the osf-passkey-offer required action. Contract: two submits
     named osf-passkey-offer, value "add" or "skip". -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        ${msg("osfPasskeyOfferTitle")}
    <#elseif section = "form">
        <p>${msg("osfPasskeyOfferMessage")}</p>
        <form id="kc-osf-passkey-offer-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormButtonsClass!}">
                <button class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" name="osf-passkey-offer" value="add" type="submit">${msg("osfPasskeyOfferAdd")}</button>
                <button class="${properties.kcButtonClass!} ${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" name="osf-passkey-offer" value="skip" type="submit">${msg("osfPasskeyOfferSkip")}</button>
            </div>
        </form>
    </#if>
</@layout.registrationLayout>
