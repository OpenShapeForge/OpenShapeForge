// SPDX-License-Identifier: BUSL-1.1
import type {Reporter,TestCase,TestError,TestResult,TestStep} from '@playwright/test/reporter';
/** Redact before native reporters serialize step titles or diagnostics. */
function redact(value:string){
 for(const name of ['AUTH_RECOVERY_PASSWORD','AUTH_RECOVERY_CLIENT_SECRET','AUTH_RECOVERY_AUTH_SECRET']){
  const secret=process.env[name];if(secret)value=value.replaceAll(secret,'[REDACTED]');
 }
 return value.replace(/([?&#](?:code|token|state|session_state|client_secret)=)[^&\s"']+/gi,'$1[REDACTED]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED]');
}
function error(value?:TestError){if(value)for(const key of ['message','stack','snippet'] as const)if(value[key])value[key]=redact(value[key]);}
export default class RecoveryRedaction implements Reporter{
 onStepBegin(_test:TestCase,_result:TestResult,step:TestStep){step.title=redact(step.title);}
 onStepEnd(_test:TestCase,_result:TestResult,step:TestStep){step.title=redact(step.title);error(step.error);}
 onTestEnd(_test:TestCase,result:TestResult){result.errors.forEach(error);}
 onError(value:TestError){error(value);}
 printsToStdio(){return false;}
}
