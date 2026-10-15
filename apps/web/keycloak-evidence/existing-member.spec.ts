// SPDX-License-Identifier: BUSL-1.1
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Run only against a separately started disposable image, never a shared realm.
const origin = process.env.INVITATION_PROOF_KEYCLOAK;
const password = process.env.INVITATION_PROOF_ADMIN_PASSWORD;
if (origin !== 'http://127.0.0.1:8183' || !password) throw new Error('Explicit disposable Keycloak proof environment required.');
const realm = `invitation-proof-${randomUUID()}`;
const appOrigin = 'http://127.0.0.1:8193';

test('Native mail returns an existing member to normal app login; consumed and revoked mail fails closed', async ({ page, context }, info) => {
  const server = createServer((_req, res) => { res.setHeader('content-type','text/html'); res.end('<h1>Normal application login entry</h1>'); });
  await new Promise<void>(resolve => server.listen(8193, '127.0.0.1', resolve));
  let token = '';
  async function admin(path: string, method = 'GET', body?: unknown, form = false) {
    const response = await fetch(`${origin}/admin/${path}`, {method, headers:{authorization:`Bearer ${token}`,
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json'},
      ...(body === undefined ? {} : {body:form ? String(body) : JSON.stringify(body)})});
    if (!response.ok) throw new Error(`Disposable fixture request failed: ${method} ${response.status}`);
    const text = await response.text(); return text ? JSON.parse(text) : undefined;
  }
  try {
    const response = await fetch(`${origin}/realms/master/protocol/openid-connect/token`, {method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'proof-admin',password})});
    if(!response.ok) throw new Error('Disposable fixture authentication failed');
    token = (await response.json()).access_token;
    await admin('realms','POST',{realm,enabled:true,organizationsEnabled:true,sslRequired:'none',smtpServer:{host:'host.docker.internal',port:'1025',from:'proof@example.invalid'}});
    const base=`realms/${realm}`;
    const [account] = await admin(`${base}/clients?clientId=account`);
    await admin(`${base}/clients/${account.id}`,'PUT',{...account,attributes:{...account.attributes,'osf.passkey-enrollment-return-origin':appOrigin}});
    const email=`${realm}@example.invalid`;
    await admin(`${base}/users`,'POST',{username:'existing-member',email,enabled:true,emailVerified:true});
    const [user] = await admin(`${base}/users?username=existing-member&exact=true`);
    await admin(`${base}/organizations`,'POST',{name:'Example',alias:'example',enabled:true,redirectUrl:`${appOrigin}/example`});
    const [org]=await admin(`${base}/organizations`);
    await admin(`${base}/organizations/${org.id}/members`,'POST',user.id);
    async function invite() {
      await admin(`${base}/organizations/${org.id}/members/invite-existing-user`,'POST',new URLSearchParams({id:user.id}),true);
      const [invitation]=await admin(`${base}/organizations/${org.id}/invitations`);
      let link: string | undefined;
      await expect.poll(async()=>{
        const list=await(await fetch('http://127.0.0.1:8025/api/v1/messages?limit=100')).json();
        for(const message of list.messages){
          if(!message.To?.some((r:any)=>r.Address===email))continue;
          const mail=await(await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json();
          const links=String(mail.HTML??'').replaceAll('&amp;','&').match(/https?:\/\/[^\s"<>]+/g)??[];
          link=links.find(u=>{try {const url=new URL(u); const key=url.searchParams.get('key'); return url.origin===origin && key && JSON.parse(Buffer.from(key.split('.')[1]!, 'base64url').toString()).jti===invitation.id;}catch{return false;}});
          if(link)return true;
        }
        return false;
      }).toBe(true);
      return {id:invitation.id,link:link!};
    }
    const first=await invite();
    await page.goto(first.link);
    await expect(page).toHaveURL(`${appOrigin}/example`);
    await expect(page.getByRole('heading',{name:'Normal application login entry'})).toBeVisible();
    await info.attach('existing-member-normal-entry',{body:await page.screenshot(),contentType:'image/png'});
    expect(await admin(`${base}/organizations/${org.id}/invitations`)).toEqual([]);
    // An invitation click does not issue a logged-in identity cookie.
    expect((await context.cookies(origin)).filter(c=>c.name==='KEYCLOAK_IDENTITY')).toEqual([]);
    await context.clearCookies(); await page.goto(first.link);
    await expect(page.getByText(/no longer valid|expired|already been used/i).first()).toBeVisible();
    expect(new URL(page.url()).origin).toBe(origin);
    const second=await invite();
    await admin(`${base}/organizations/${org.id}/invitations/${second.id}`,'DELETE');
    await context.clearCookies(); await page.goto(second.link);
    await expect(page.getByText(/no longer valid|expired|already been used/i).first()).toBeVisible();
    expect(new URL(page.url()).origin).toBe(origin);
    await info.attach('revoked-invitation-refused',{body:await page.screenshot(),contentType:'image/png'});
  } finally {
    if(token) await admin(`realms/${realm}`,'DELETE');
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
