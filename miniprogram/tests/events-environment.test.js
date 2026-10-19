const test=require('node:test');
const assert=require('node:assert/strict');
const {createSession}=require('../lib/session');
const {createEventExperience}=require('../lib/events');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const EVENT={id:'example-2026-10-20',title:'演示活动',location_name:'天津水上公园',starts_at:'2026-10-20T01:00:00Z',ends_at:'2026-10-20T03:00:00Z',annual:false,map_reference_id:'reference-park-079',simulated:true};
const REPORT={id:'00000000-0000-4000-8000-000000000020',task_kind:'recognition',task_id:'00000000-0000-4000-8000-000000000030',description:'散落包装物',location:{name:'步道'},status:'pending',created_at:'2026-10-19T00:00:00Z',simulated:true,photo_url:'/api/v1/environment-reports/00000000-0000-4000-8000-000000000020/photo/'};
function fixture(page,handler,guest=false){
 const store=new Map(),calls=[],modals=[],redirects=[];
 const session=createSession({getStorageSync:k=>store.get(k),setStorageSync:(k,v)=>store.set(k,v),removeStorageSync:k=>store.delete(k)});
 if(!guest)session.save({token:'a',user:{id:'a'}});
 const application={session,globalData:{},api:{request:async(path,options)=>{calls.push({path,options});if(handler){const result=await handler(path,options);if(result!==undefined)return result;} if(path==='events/')return {data:{items:[EVENT],notice:'演示活动'}};if(path==='event-subscriptions/')return {data:{items:[{event_id:EVENT.id,event:EVENT}]}};if(path==='event-notifications/')return {data:{enabled:false}};if(path==='environment-reports/context/')return {data:{...REPORT,observation:'花卉候选：雏菊',location_hint:'公园',photo_url:'/api/v1/uploads/x/content/'}};if(path==='environment-reports/')return options&&options.method==='POST'?{data:REPORT}:{data:[REPORT]};return {data:{}};},download:async()=>'/private/photo.jpg'}};
 global.getApp=()=>application;global.wx={stopPullDownRefresh(){},showModal:o=>modals.push(o),navigateTo:o=>redirects.push(o.url),switchTab:o=>redirects.push(o.url),previewImage:o=>redirects.push(o.current)};
 let definition;global.Page=x=>definition=x;
 const file=require.resolve('../pages/'+page+'/index');delete require.cache[file];require(file);
 const instance={...definition,data:structuredClone(definition.data),setData(patch){for(const [key,value]of Object.entries(patch)){const keys=key.split('.');let cursor=this.data;for(const part of keys.slice(0,-1))cursor=cursor[part]||(cursor[part]={});cursor[keys.at(-1)]=value;}}};
 instance.onLoad({});return {instance,application,calls,modals,redirects};
}
const click=id=>({currentTarget:{dataset:{id}}});

test('event guests browse without private requests and explicit subscription has no platform authorization',async()=>{
 const f=fixture('events',null,true);await f.instance.onShow();assert.deepEqual(f.calls.map(c=>c.path),['events/']);assert.equal(f.instance.data.loggedIn,false);
 await f.instance.subscribe(click(EVENT.id));assert.equal(f.calls.length,1);f.instance.login();assert.equal(f.redirects[0],'/pages/profile/index');
});

test('activity preferences change only on a deliberate toggle and subscriptions show correct state',async()=>{
 const f=fixture('events');await f.instance.onShow();assert.equal(f.instance.data.items[0].subscribed,true);assert.equal(f.calls.filter(c=>c.options&&c.options.method==='POST').length,0);
 await f.instance.notifications({detail:{value:true}});const save=f.calls.find(c=>c.options&&c.options.method==='PATCH');assert.equal(save.path,'event-notifications/');assert.deepEqual(save.options.data,{enabled:true});
});

test('session change clears activity private UI and ignores a previous account response',async()=>{
 const delayed=deferred();const f=fixture('events',p=>p==='event-subscriptions/'?delayed.promise:undefined);const loading=f.instance.onShow();await tick();
 f.application.session.save({token:'b',user:{id:'b'}});delayed.resolve({data:{items:[{event_id:EVENT.id,event:EVENT}]}});await loading;
 assert.equal(f.instance.data.subscriptions.length,0);assert.equal(f.instance.data.enabled,false);assert.equal(f.instance.data.busy,false);assert.equal(f.instance.data.loading,false);
});

test('server claim controls login popups; local duplicates and delayed account callbacks cannot navigate',async()=>{
 const f=fixture('events');let claims=0;f.application.api.request=async(path,options)=>{if(path==='event-notifications/')return {data:{enabled:true,prompted:true}};claims++;assert.equal(path,'event-notifications/claim/');assert.deepEqual(options.data,{login:true});return {data:{should_show:true,items:[EVENT]}};};
 const experience=createEventExperience(f.application,wx);await Promise.all([experience.showLoginSummary(()=>true,true),experience.showLoginSummary(()=>true,true)]);assert.equal(claims,1);assert.equal(f.modals.length,1);assert.match(f.modals[0].content,/演示安排/);assert.match(f.modals[0].content,/天津水上公园/);
 f.application.session.save({token:'b',user:{id:'b'}});f.modals[0].success({confirm:true});assert.equal(f.redirects.length,0);
});

test('claimed=false and hidden or switched login callbacks never open an activity popup',async()=>{
 const f=fixture('events'),pending=deferred();f.application.api.request=()=>pending.promise;
 const experience=createEventExperience(f.application,wx);const work=experience.showLoginSummary(()=>true,true);f.application.session.clear();pending.resolve({data:{should_show:true,items:[EVENT]}});await work;assert.equal(f.modals.length,0);
});

test('environment form sends only owned task reference, user observation and chosen location',async()=>{
 const f=fixture('environment-report');f.instance.onLoad({task_kind:'recognition',task_id:REPORT.task_id});await f.instance.onShow();
 f.instance.setData({description:'岸边可见包装物',locationText:'公园东侧',locationIndex:0});await f.instance.submit();
 const saved=f.calls.find(c=>c.options&&c.options.method==='POST');assert.deepEqual(saved.options.data,{task_kind:'recognition',task_id:REPORT.task_id,description:'岸边可见包装物',location_text:'公园东侧'});
 assert.match(f.instance.data.notice,/模拟上报.*未发送政府/);assert.equal(f.instance.data.context.existing_report.id,REPORT.id);await f.instance.submit();assert.equal(f.calls.filter(c=>c.options&&c.options.method==='POST').length,1);
});

test('environment text survives a network failure and no success is shown before the server confirms',async()=>{
 const f=fixture('environment-report',(p,o)=>o&&o.method==='POST'?Promise.reject(new Error('网络中断')):undefined);f.instance.onLoad({task_kind:'recognition',task_id:REPORT.task_id});await f.instance.onShow();f.instance.setData({description:'包装物',locationText:'步道'});await f.instance.submit();
 assert.equal(f.instance.data.description,'包装物');assert.equal(f.instance.data.notice,'');assert.match(f.instance.data.error,/刷新核对/);assert.equal(f.instance.data.busy,false);
});

test('environment guest performs no private reads and account switch clears local photo, description and reports',async()=>{
 const guest=fixture('environment-report',null,true);await guest.instance.onShow();assert.equal(guest.calls.length,0);
 const f=fixture('environment-report');f.instance.onLoad({task_kind:'recognition',task_id:REPORT.task_id});await f.instance.onShow();f.instance.setData({description:'私人观察'});f.application.session.clear();assert.equal(f.instance.data.photo,'');assert.equal(f.instance.data.description,'');assert.equal(f.instance.data.records.length,0);assert.equal(f.instance.data.context,null);
});

test('environment deletion confirmation is invalidated by a change of account',async()=>{
 const f=fixture('environment-report');await f.instance.onShow();f.instance.remove(click(REPORT.id));f.application.session.save({token:'b',user:{id:'b'}});await f.modals[0].success({confirm:true});assert.equal(f.calls.filter(c=>c.options&&c.options.method==='DELETE').length,0);
});

test('official environment links copy only fixed public destinations and never submit the report',async()=>{
 const f=fixture('environment-report',null,true),copied=[];global.wx.setClipboardData=options=>{copied.push(options.data);options.success();};await f.instance.onShow();
 f.instance.copyOfficialSite({currentTarget:{dataset:{id:'tianjin',url:'https://untrusted.invalid'}}});
 f.instance.copyOfficialSite(click('beijing'));f.instance.copyOfficialSite(click('unknown'));
 assert.deepEqual(copied,f.instance.data.officialSites.map(row=>row.url));assert.equal(f.calls.length,0);assert.match(f.instance.data.notice,/未向有关部门发送/);
 f.instance.onHide();f.instance.copyOfficialSite(click('tianjin'));assert.equal(copied.length,2);
});

test('the flower result environment action emits only for an eligible idle result',()=>{
 let component;global.Component=value=>component=value;const file=require.resolve('../components/recognition-result/index');delete require.cache[file];require(file);
 const emitted=[],instance={properties:{reportEnabled:false,busy:false},triggerEvent:name=>emitted.push(name)};
 component.methods.environment.call(instance);instance.properties.reportEnabled=true;instance.properties.busy=true;component.methods.environment.call(instance);
 instance.properties.busy=false;component.methods.environment.call(instance);assert.deepEqual(emitted,['environment']);
});

test('map event panel discards a late response for a previous selection and filters to the next thirty days',async()=>{
 const delayed=deferred();let first=true;const f=fixture('events');f.application.api.request=()=>first?(first=false,delayed.promise):Promise.resolve({data:{server_time:'2026-10-19T00:00:00Z',items:[{...EVENT,title:'第二地点'},{...EVENT,id:'annual',starts_at:'2027-04-01T00:00:00Z'}]}});
 let component;global.Component=x=>component=x;const file=require.resolve('../components/event-panel/index');delete require.cache[file];require(file);
 const panel={...component.methods,properties:{referenceId:'reference-park-079'},data:structuredClone(component.data),_active:true,setData(p){Object.assign(this.data,p);}};
 const old=panel.load();panel.properties={referenceId:'reference-park-003'};await panel.load();delayed.resolve({data:{server_time:'2026-10-19T00:00:00Z',items:[EVENT]}});await old;
 assert.equal(panel.data.items.length,1);assert.equal(panel.data.items[0].title,'第二地点');
});

test('first login asks for station reminder consent; affirmative choice alone saves true and opens activities',async()=>{
 const f=fixture('events');f.application.api.request=async(path,options)=>{f.calls.push({path,options});return {data:{enabled:false,prompted:false,upcoming:[EVENT]}};};
 const experience=createEventExperience(f.application,wx),pending=experience.showLoginSummary(()=>true,true);await tick();
 assert.equal(f.modals.length,1);assert.match(f.modals[0].title,/开启站内活动提醒/);assert.match(f.modals[0].content,/天津水上公园/);assert.equal(f.modals[0].confirmText,'开启提醒');assert.equal(f.modals[0].cancelText,'暂不开启');
 assert.equal(f.calls.filter(c=>c.options&&c.options.method==='PATCH').length,0);f.modals[0].success({confirm:true,cancel:false});await pending;
 assert.deepEqual(f.calls.find(c=>c.options&&c.options.method==='PATCH').options.data,{enabled:true});assert.deepEqual(f.redirects,['/pages/events/index']);assert.equal(f.calls.some(c=>c.path==='event-notifications/claim/'),false);
});

test('refusing the first reminder prompt saves false and later logins neither claim nor ask again',async()=>{
 const f=fixture('events');let prompted=false;f.application.api.request=async(path,options)=>{f.calls.push({path,options});if(options&&options.method==='PATCH')prompted=true;return {data:{enabled:false,prompted,upcoming:[EVENT]}};};
 let experience=createEventExperience(f.application,wx),pending=experience.showLoginSummary(()=>true,true);await tick();f.modals[0].success({confirm:false,cancel:true});await pending;
 assert.deepEqual(f.calls.find(c=>c.options&&c.options.method==='PATCH').options.data,{enabled:false});assert.equal(f.redirects.length,0);
 f.application.session.save({token:'new-login',user:{id:'a'}});experience=createEventExperience(f.application,wx);await experience.showLoginSummary(()=>true,true);
 assert.equal(f.modals.length,1);assert.equal(f.calls.some(c=>c.path==='event-notifications/claim/'),false);
});

test('failed first modal and account changes before consent do not persist a preference',async()=>{
 const f=fixture('events');f.application.api.request=async(path,options)=>{f.calls.push({path,options});return {data:{enabled:false,prompted:false,upcoming:[EVENT]}};};
 const experience=createEventExperience(f.application,wx);let pending=experience.showLoginSummary(()=>true,true);await tick();f.modals[0].fail();await pending;
 assert.equal(f.calls.some(c=>c.options&&c.options.method==='PATCH'),false);
 pending=experience.showLoginSummary(()=>true,true);await tick();assert.equal(f.modals.length,2);f.application.session.save({token:'b',user:{id:'b'}});f.modals[1].success({confirm:true,cancel:false});await pending;
 assert.equal(f.calls.some(c=>c.options&&c.options.method==='PATCH'),false);
});
