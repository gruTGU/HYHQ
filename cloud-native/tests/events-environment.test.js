'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./memory-store');
const events = require('../../cloudfunctions/hyhqApi/lib/events');
const reminders = require('../../cloudfunctions/hyhqApi/lib/weather-reminders');
const reports = require('../../cloudfunctions/hyhqApi/lib/environment-reports');
const management = require('../../cloudfunctions/hyhqApi/lib/management');
const { purgeAccount } = require('../../cloudfunctions/hyhqApi/lib/accounts');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now = '2026-10-19T04:00:00.000Z';
const code = value => error => error.code === value;
async function fixture() {
  const store = new MemoryStore(), user = { id: uid(1), is_active: true, quota_key: 'a'.repeat(64) }, other = { ...user, id: uid(2), quota_key: 'b'.repeat(64) }, admin = { ...user, id: uid(3), quota_key: 'c'.repeat(64) };
  for (const owner of [user, other, admin]) await store.set('users', owner.id, owner);
  const config = { management: { enabled: true, adminUserIds: [admin.id] }, weatherReminders: { enabled: true, templateId: reminders.TEMPLATE_ID } };
  const asset = { id: uid(10), owner_id: user.id, purpose: 'recognition', thumbnail_file_id: 'private-thumbnail', expires_at: '2026-11-01T00:00:00Z' };
  const job = { id: uid(20), owner_id: user.id, asset_id: asset.id, status: 'succeeded', expires_at: asset.expires_at, result: { candidates: [{ name: '雏菊' }] } };
  await store.set('assets', asset.id, asset); await store.set('recognition_jobs', job.id, job);
  let reads = 0;
  const storage = { readAsset: async (owner, id, options) => { reads++; assert.equal(owner.id, user.id); assert.equal(id, asset.id); assert.equal(options.variant, 'thumbnail'); return { bytes: Buffer.from('thumbnail') }; }, deleteAsset: async (_owner, id) => store.remove('assets', id), cancelUpload: async (_owner, id) => store.remove('uploads', id) };
  const context = (path, method = 'GET', body = {}, extra = {}) => ({ path, method, body, now, config, user, store, storage, wechatOpenId: 'trusted-events-test-openid', providers: { sendWeatherReminder: async () => { throw new Error('subscription must not dispatch'); } }, query: new URLSearchParams(), ...extra });
  const request = (path, method, body, extra) => (path.startsWith('event') && !path.startsWith('environment') ? events : reports).handle(context(path, method, body, extra));
  const input = { task_kind: 'recognition', task_id: job.id, location_text: '公园东侧步道', description: '照片中可见散落包装物，请人工核对。' };
  const grant = async (owner = user) => {
    const row = (await reminders.handle(context('weather-data/reminders/grants/', 'POST', {}, { user: owner }))).data.data;
    await reminders.handle(context('weather-data/reminders/grants/' + row.id + '/confirm/', 'POST', { template_id: reminders.TEMPLATE_ID, decision: 'accept' }, { user: owner }));
  };
  return { store, user, other, admin, asset, job, context, request, grant, input, reads: () => reads };
}

test('public events carry simulation provenance, deterministic dates, exact place filtering and annual flower seasons', async () => {
  const f = await fixture(), all = (await f.request('events/', 'GET', {}, { user: null })).data.data.items;
  assert.ok(all.length > 3); assert.ok(all.every(row => row.simulated && Date.parse(row.ends_at) > Date.parse(now)));
  assert.ok(all.some(row => row.annual && row.kind === 'flower_season'));
  assert.deepEqual(events.catalogue(now), events.catalogue(now));
  const filtered = (await f.request('events/', 'GET', {}, { query: new URLSearchParams('map_reference_id=reference-park-079') })).data.data.items;
  assert.ok(filtered.length); assert.ok(filtered.every(row => row.map_reference_id === 'reference-park-079'));
  await assert.rejects(f.request('events/', 'GET', {}, { query: new URLSearchParams('map_reference_id=unknown') }), code('VALIDATION_ERROR'));
  await assert.rejects(f.request('events/', 'GET', {}, { query: new URLSearchParams('map_reference_id=reference-park-079&place_id='+uid(1)) }), code('VALIDATION_ERROR'));
  const nextYear = events.catalogue('2026-12-31T16:30:00Z'); assert.ok(nextYear.some(row => row.annual && row.starts_at.startsWith('2027-04')));
});

test('shared-credit subscriptions are idempotent, private, and do not deliver during signup; in-app preferences remain opt-in', async () => {
  const f = await fixture(), event = events.catalogue(now)[0];
  await f.grant();
  const providers = { sendWeatherReminder() { throw new Error('must not send'); } };
  await Promise.all(Array.from({length: 5}, () => f.request('event-subscriptions/', 'POST', { event_id: event.id }, { providers })));
  assert.equal(await f.store.count('event_subscriptions'), 1);
  assert.equal((await f.store.get('users', f.user.id)).event_subscription_count, 1);
  assert.equal((await f.request('event-notifications/')).data.data.enabled, false);
  assert.equal((await f.request('event-notifications/')).data.data.prompted, false);
  assert.equal((await f.request('event-notifications/')).data.data.items.length, 0);
  const enabled = (await f.request('event-notifications/', 'PATCH', { enabled: true })).data.data;
  assert.equal(enabled.prompted, true); assert.equal(enabled.mode, 'in_app'); assert.equal(enabled.items[0].id, event.id);
  assert.equal((await f.request('event-subscriptions/', 'GET', {}, { user: f.other })).data.data.items.length, 0);
  await f.request('event-subscriptions/'+event.id+'/', 'DELETE', {}, { user: f.other });
  assert.equal(await f.store.count('event_subscriptions'), 1);
  await f.request('event-subscriptions/'+event.id+'/', 'DELETE');
  assert.equal((await f.store.get('users', f.user.id)).event_subscription_count, 0);
});

test('subscriptions reject guests, invalid dates, unknown fields and deactivated users', async () => {
  const f = await fixture(), event = events.catalogue(now)[0];
  await assert.rejects(f.request('event-subscriptions/', 'POST', {event_id:event.id}, {user:null}), error => error.status === 401);
  await assert.rejects(f.request('event-subscriptions/', 'POST', {event_id:'park-weekend-2020-01-01'}), code('EVENT_UNAVAILABLE'));
  await assert.rejects(f.request('event-notifications/', 'PATCH', {enabled:'true'}), code('VALIDATION_ERROR'));
  await assert.rejects(f.request('event-subscriptions/', 'POST', {event_id:event.id, owner_id:f.other.id}), code('VALIDATION_ERROR'));
  await f.store.update('users', f.user.id, {is_active:false});
  await assert.rejects(f.request('event-subscriptions/', 'POST', {event_id:event.id}), code('AUTH_REQUIRED'));
});

test('environment submission derives private photo and observation from the owned successful task and deduplicates retries', async () => {
  const f=await fixture(); const rows=await Promise.all(Array.from({length:4},()=>f.request('environment-reports/','POST',f.input)));
  const row=rows[0].data.data;
  assert.equal(await f.store.count('environment_reports'),1); assert.equal(row.simulated,true); assert.equal(row.delivery_mode,'platform_admin_simulation');
  assert.match(row.observation,/雏菊/); assert.match(row.notice,/未发送政府/); assert.equal(row.asset_id,undefined); assert.equal(row.owner_id,undefined);
  assert.equal((await f.store.get('users',f.user.id)).environment_report_count,1);
  await assert.rejects(f.request('environment-reports/','POST',{...f.input, description:'不应覆盖'}),code('REPORT_ALREADY_EXISTS'));
  assert.equal((await f.request('environment-reports/')).data.data[0].description,f.input.description);
  const context=(await f.request('environment-reports/context/','GET',{}, {query:new URLSearchParams({task_kind:'recognition',task_id:f.job.id})})).data.data;
  assert.equal(context.existing_report.id,row.id);
});

test('environment submission rejects cross-account tasks, forged photo IDs, invalid location, unfinished jobs and expired assets', async () => {
  const f=await fixture();
  await assert.rejects(f.request('environment-reports/','POST',f.input,{user:f.other}),code('NOT_FOUND'));
  await assert.rejects(f.request('environment-reports/','POST',{...f.input,asset_id:f.asset.id}),code('VALIDATION_ERROR'));
  for(const task_kind of [['recognition'],'__proto__','toString']) await assert.rejects(f.request('environment-reports/','POST',{...f.input,task_kind}),code('VALIDATION_ERROR'));
  await assert.rejects(f.request('environment-reports/','POST',{...f.input,task_id:[f.job.id]}),code('VALIDATION_ERROR'));
  await assert.rejects(f.request('environment-reports/','POST',{...f.input,location_text:''}),code('VALIDATION_ERROR'));
  await f.store.update('recognition_jobs',f.job.id,{status:'running'});
  await assert.rejects(f.request('environment-reports/','POST',f.input),code('NOT_FOUND'));
  await f.store.update('recognition_jobs',f.job.id,{status:'succeeded'}); await f.store.update('assets',f.asset.id,{expires_at:'2026-10-18T00:00:00Z'});
  await assert.rejects(f.request('environment-reports/','POST',f.input),code('NOT_FOUND'));
  assert.equal(await f.store.count('environment_reports'),0);
});

test('reference locations are trusted server data and deleting an account cannot race in a report', async () => {
  const f=await fixture(), row=(await f.request('environment-reports/','POST',{...f.input,map_reference_id:'reference-park-079'})).data.data;
  assert.equal(row.location.name,'天津水上公园');
  await f.request('environment-reports/'+row.id+'/','DELETE');
  const transact=f.store.transaction.bind(f.store); f.store.transaction=async callback=>{await f.store.set('users',f.user.id,{...f.user,is_active:false});return transact(callback);};
  await assert.rejects(f.request('environment-reports/','POST',f.input),code('AUTH_REQUIRED'));
});

test('environment queue authorization, administrator replies and audits preserve private ownership', async () => {
  const f=await fixture(), row=(await f.request('environment-reports/','POST',f.input)).data.data;
  await assert.rejects(f.request('personal-admin/environment-reports/'),error=>error.status===403);
  assert.equal((await f.request('environment-reports/','GET',{}, {user:f.other})).data.data.length,0);
  assert.equal((await f.request('personal-admin/environment-reports/','GET',{}, {user:f.admin})).data.data[0].id,row.id);
  await f.request('personal-admin/environment-reports/'+row.id+'/resolve/','POST',{reply:'已核对，演示流程完成。',expected_revision:0},{user:f.admin});
  const own=(await f.request('environment-reports/')).data.data[0]; assert.equal(own.status,'resolved'); assert.match(own.reply,/已核对/);
  assert.equal(await f.store.count('admin_audit'),1);
  await assert.rejects(f.request('personal-admin/environment-reports/'+row.id+'/resolve/','POST',{reply:'已核对，演示流程完成。',expected_revision:1},{user:f.admin}),code('REPLY_UNCHANGED'));
  assert.equal(await f.store.count('admin_audit'),1);
  await assert.rejects(f.request('personal-admin/environment-reports/'+row.id+'/resolve/','POST',{reply:'旧版本',expected_revision:0},{user:f.admin}),code('ADMIN_REVISION_CHANGED'));
  await assert.rejects(f.request('environment-reports/'+row.id+'/','DELETE',{}, {user:f.other}),code('NOT_FOUND'));
});

test('photo sharing allows only owner and authorized administrator, and deletion or expiry revokes access', async () => {
  const f=await fixture(), row=(await f.request('environment-reports/','POST',f.input)).data.data;
  assert.equal((await reports.readPhoto(f.context(''),row.id)).bytes.toString(),'thumbnail');
  assert.equal((await reports.readPhoto(f.context('', 'GET', {}, {user:f.admin}),row.id)).bytes.toString(),'thumbnail');
  await assert.rejects(reports.readPhoto(f.context('', 'GET', {}, {user:f.other}),row.id),error=>error.status===403);
  assert.equal(f.reads(),2);
  await f.store.update('recognition_jobs',f.job.id,{status:'deleted'});
  await assert.rejects(reports.readPhoto(f.context(''),row.id),code('NOT_FOUND'));
  assert.equal((await f.request('environment-reports/')).data.data.length,1);
});

test('deleting a report during photo download prevents returning the bytes',async()=>{
  const f=await fixture(), row=(await f.request('environment-reports/','POST',f.input)).data.data;
  const ctx=f.context(''); ctx.storage={readAsset:async()=>{await f.store.remove('environment_reports',row.id);return {bytes:Buffer.from('private')};}};
  await assert.rejects(reports.readPhoto(ctx,row.id),code('NOT_FOUND'));
});

test('account deletion purges activity subscriptions and environment reports without deleting another owner data',async()=>{
  const f=await fixture(), event=events.catalogue(now)[0];
  await f.grant(); await f.grant(f.other);
  await f.request('event-subscriptions/','POST',{event_id:event.id}); await f.request('event-subscriptions/','POST',{event_id:event.id},{user:f.other});
  await f.request('environment-reports/','POST',f.input);
  await purgeAccount(f.context('me/','DELETE'),f.user);
  assert.equal(await f.store.count('environment_reports'),0); assert.equal(await f.store.count('event_subscriptions'),1);
  assert.equal((await f.store.list('event_subscriptions'))[0].owner_id,f.other.id);
});

test('login claims are atomic once per Shanghai calendar day, including concurrent sessions and year boundary',async()=>{
  const f=await fixture();
  await f.grant(); await f.grant();
  await f.request('event-subscriptions/','POST',{event_id:events.catalogue(now)[0].id});
  await f.request('event-notifications/','PATCH',{enabled:true});
  const attempts=await Promise.all(Array.from({length:6},()=>f.request('event-notifications/claim/','POST',{login:true})));
  assert.equal(attempts.filter(r=>r.data.data.should_show).length,1);
  const next=await f.request('event-notifications/claim/','POST',{login:true},{now:'2026-10-19T16:00:00Z'}); assert.equal(next.data.data.should_show,true);
  assert.equal((await f.store.get('users',f.user.id)).event_popup_day,'2026-10-20');
  const other=await f.request('event-notifications/claim/','POST',{login:false},{user:f.other}); assert.equal(other.data.data.should_show,false);
  const yearTime='2026-12-31T15:59:59Z', january=events.catalogue(yearTime).find(row=>row.id==='flower-month-1-2027-01-01');
  await f.request('event-subscriptions/','POST',{event_id:january.id},{now:yearTime});
  await f.request('event-notifications/claim/','POST',{login:true},{now:yearTime});
  assert.equal((await f.request('event-notifications/claim/','POST',{login:true},{now:'2026-12-31T16:00:00Z'})).data.data.should_show,true);
});

test('annual flower calendar covers twelve months in both cities, labels every entry simulated, and handles February correctly',()=>{
  const rows=events.catalogue('2027-01-01T00:00:00Z');
  for(const city of ['tianjin-nature','beijing-nature']) assert.equal(new Set(rows.filter(r=>r.annual&&r.region_slug===city).map(r=>r.calendar_month)).size,12);
  const feb=rows.find(r=>r.id==='flower-month-2-2027-02-01'); assert.equal(feb.ends_at,'2027-02-28T15:59:59.999Z');
  const leap=events.catalogue('2028-02-20T00:00:00Z').find(r=>r.id==='flower-month-2-2028-02-01'); assert.equal(leap.ends_at,'2028-02-29T15:59:59.999Z');
  assert.equal(leap.is_current,true); assert.equal(leap.status,'ongoing'); assert.ok(rows.every(r=>r.simulated));
});

test('native API dispatch authenticates activities and serves report thumbnails through the private chunk bridge',async()=>{
  const {createApp}=require('../../cloudfunctions/hyhqApi');
  const store=new MemoryStore(),identity={APPID:'wx1234567890abcdef',OPENID:'test-openid-for-events'},config={appId:'wx1234567890abcdef',management:{enabled:false,adminUserIds:[]},weatherReminders:{enabled:true,templateId:reminders.TEMPLATE_ID}};
  let downloads=0;
  const api=createApp({store,config,now:()=>now,providers:{sendWeatherReminder:async()=>assert.fail('signup must not dispatch')},cloud:{downloadFile:async()=>{downloads++;return {fileContent:Buffer.from('private-thumbnail')};}}});
  const login=await api({path:'/api/v1/auth/wechat/',method:'POST',body:{code:'native-code'}},identity);assert.equal(login.statusCode,200);
  const session=login.data.data,headers={Authorization:'Bearer '+session.token},owner_id=session.user.id;
  const call=(path,method='GET',body={})=>api({path:'/api/v1/'+path,method,body,headers},identity);
  assert.equal((await call('events/')).statusCode,200);
  const grant=(await call('weather-data/reminders/grants/','POST',{})).data.data;
  assert.equal((await call('weather-data/reminders/grants/'+grant.id+'/confirm/','POST',{template_id:reminders.TEMPLATE_ID,decision:'accept'})).statusCode,200);
  const event=events.catalogue(now)[0];assert.equal((await call('event-subscriptions/','POST',{event_id:event.id})).statusCode,200);
  await store.set('assets',uid(40),{id:uid(40),owner_id,purpose:'recognition',thumbnail_file_id:'private-report-photo',expires_at:'2026-11-01T00:00:00Z'});
  await store.set('recognition_jobs',uid(41),{id:uid(41),owner_id,asset_id:uid(40),status:'succeeded',expires_at:'2026-11-01T00:00:00Z',result:{candidates:[{name:'雏菊'}]}});
  const report=await call('environment-reports/','POST',{task_kind:'recognition',task_id:uid(41),description:'画面中散落包装物',location_text:'步道旁'});assert.equal(report.statusCode,201);
  const downloaded=await call('cloud-files/download/?path='+encodeURIComponent(report.data.data.photo_url)+'&offset=0');
  assert.equal(downloaded.statusCode,200);assert.equal(Buffer.from(downloaded.data.data.data_base64,'base64').toString(),'private-thumbnail');assert.equal(downloads,1);
  const denied=await api({path:'/api/v1/cloud-files/download/?path='+encodeURIComponent(report.data.data.photo_url)+'&offset=0',method:'GET',body:{}},identity);assert.equal(denied.statusCode,401);assert.equal(downloads,1);
});

test('missing or malformed job expiration never authorizes an environment report',async()=>{
  const f=await fixture();
  for(const expires_at of [null,'not-a-date','']){
    await f.store.update('recognition_jobs',f.job.id,{expires_at});
    await assert.rejects(f.request('environment-reports/','POST',f.input),code('NOT_FOUND'));
  }
});

test('explicit reminder refusal is remembered and login cannot bypass disabled preferences',async()=>{
 const f=await fixture();await f.grant();await f.request('event-subscriptions/','POST',{event_id:events.catalogue(now)[0].id});
 const declined=(await f.request('event-notifications/','PATCH',{enabled:false})).data.data;assert.equal(declined.prompted,true);assert.equal(declined.enabled,false);
 for(const login of [true,false])assert.equal((await f.request('event-notifications/claim/','POST',{login})).data.data.should_show,false);
 const user=await f.store.get('users',f.user.id);assert.equal(user.event_popup_day,undefined);
});

test('environment reports have a daily creation limit that deletion cannot refund',async()=>{
 const f=await fixture();
 for(let i=0;i<10;i++){
   const row=(await f.request('environment-reports/','POST',f.input)).data.data;
   await f.request('environment-reports/'+row.id+'/','DELETE');
 }
 assert.equal(await f.store.count('environment_reports'),0);
 await assert.rejects(f.request('environment-reports/','POST',f.input),code('ENVIRONMENT_REPORT_LIMIT'));
 assert.equal((await f.store.get('users',f.user.id)).environment_report_daily_count,10);
 assert.equal((await f.request('environment-reports/','POST',f.input,{now:'2026-10-19T16:00:00Z'})).statusCode,201);
});

test('low quality photos cannot enter the report queue while valid uncertain classification remains eligible',async()=>{
 const f=await fixture();await f.store.update('recognition_jobs',f.job.id,{result:{decision:'uncertain',reason:'LOW_IMAGE_QUALITY'}});
 await assert.rejects(f.request('environment-reports/','POST',f.input),code('PHOTO_UNSUITABLE'));
 await f.store.update('recognition_jobs',f.job.id,{result:{decision:'uncertain',reason:'BELOW_THRESHOLD',candidates:[]}});
 assert.equal((await f.request('environment-reports/','POST',f.input)).statusCode,201);
});
