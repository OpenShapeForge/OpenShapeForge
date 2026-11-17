// SPDX-License-Identifier: BUSL-1.1
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SessionProvider,useSetAppSession} from '../../src/components/ui/layout/session-provider';
import {SessionExpiryGuard} from '../../src/components/ui/layout/session-expiry-guard';
import type {Session} from '../../src/lib/auth';
function Content(){
 const update=useSetAppSession();const [state,setState]=useState('ready');
 async function check(){const session=await fetch('/api/auth/session',{cache:'no-store'}).then(r=>r.json());update?.(session);setState(session.error??'ready');}
 return <><h1>Session guard integration fixture</h1><label>Unsaved draft<input aria-label="Unsaved draft"/></label><button onClick={check}>Check session</button><output aria-label="Session response">{state}</output><SessionExpiryGuard lang="en"/></>;
}
const session=await fetch('/api/auth/session',{cache:'no-store'}).then(r=>r.json()) as Session;
createRoot(document.getElementById('root')!).render(<SessionProvider session={session}><Content/></SessionProvider>);
