<#ftl output_format="HTML" auto_esc=true>
<#-- SPDX-License-Identifier: BUSL-1.1 -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
        ${msg("brokerAccountRetryTitle")}
    <#elseif section = "form">
        <p>${msg("brokerAccountRetryMessage", brokerAccount!"")}</p>
        <form id="kc-broker-account-retry-form" class="${properties.kcFormClass!}" action="${url.loginAction}" method="post">
            <div class="${properties.kcFormButtonsClass!}">
                <button class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" name="retry" value="true" type="submit">${msg("brokerAccountRetryAction")}</button>
                <button class="${properties.kcButtonClass!} ${properties.kcButtonSecondaryClass!} ${properties.kcButtonBlockClass!}" name="cancel" value="true" type="submit">${msg("doCancel")}</button>
            </div>
        </form>
    </#if>
</@layout.registrationLayout>
