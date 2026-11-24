'use strict';
const API_URL='https://uggqsvgxjhvdfkddqzyh.supabase.co/functions/v1/lpg-api';
const PUBLISHABLE_KEY='sb_publishable_gvys5Rb8ugEbQrBk2unNQQ_6ZmJSV4q';
const $=id=>document.getElementById(id);
const state={token:null,user:null,tokenExpires:0,rows:[],done:new Set(),gpsCaptured:new Set(),pendingCompletions:[],pendingGps:[],sortMode:'assigned',depot:null,publishedRoute:[],selected:null};
const storeKey='samruddhi_delivery_v2';
const sessionKey='samruddhi_delivery_session_v1';
function today(){return new Intl.DateTimeFormat('en-IN',{weekday:'long',day:'2-digit',month:'short',year:'numeric'}).format(new Date())}
function setNetwork(){const el=$('network');if(navigator.onLine){el.textContent='Online';el.className='net-pill online'}else{el.textContent='Offline';el.className='net-pill offline'}}
window.addEventListener('online',()=>{setNetwork();flushPendingCompletions()});window.addEventListener('offline',setNetwork);setNetwork();$('todayText').textContent=today();
function restore(){
 try{
  const saved=JSON.parse(localStorage.getItem(storeKey)||'{}');
  if(Array.isArray(saved.done))state.done=new Set(saved.done);if(Array.isArray(saved.gpsCaptured))state.gpsCaptured=new Set(saved.gpsCaptured);if(Array.isArray(saved.pendingCompletions))state.pendingCompletions=saved.pendingCompletions;if(Array.isArray(saved.pendingGps))state.pendingGps=saved.pendingGps;state.pendingGps.forEach(x=>{if(x.booking_key)state.gpsCaptured.add('booking:'+String(x.booking_key))});
  // Keep the signed session token in sessionStorage only, not long-lived localStorage.
  const session=JSON.parse(sessionStorage.getItem(sessionKey)||'{}');
  localStorage.setItem(storeKey,JSON.stringify({done:[...state.done],gpsCaptured:[...state.gpsCaptured],pendingCompletions:state.pendingCompletions,pendingGps:state.pendingGps}));
  if(session.user&&session.token&&Number(session.expires)>Date.now()&&session.user.role==='delivery'){
   state.user=session.user;state.token=session.token;state.tokenExpires=Number(session.expires);showHome();loadBookings(false);
  }else{sessionStorage.removeItem(sessionKey)}
 }catch{sessionStorage.removeItem(sessionKey)}
}
function persist(){
 localStorage.setItem(storeKey,JSON.stringify({done:[...state.done],gpsCaptured:[...state.gpsCaptured],pendingCompletions:state.pendingCompletions}));
 if(state.token&&state.user&&state.tokenExpires>Date.now())sessionStorage.setItem(sessionKey,JSON.stringify({token:state.token,user:state.user,expires:state.tokenExpires}));
 else sessionStorage.removeItem(sessionKey);
}
async function api(body,token=state.token){const headers={'Content-Type':'application/json','apikey':PUBLISHABLE_KEY};if(token)headers['x-session-token']=token;const response=await fetch(API_URL,{method:'POST',headers,body:JSON.stringify(body)});let data;try{data=await response.json()}catch{throw new Error(`Server returned HTTP ${response.status}`)}if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);if(data.error)throw new Error(data.error);return data}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const btn=e.submitter;btn.disabled=true;btn.textContent='Signing in…';try{const result=await api({action:'login',name:$('username').value.trim(),pin:$('pin').value},null);if(!result.token||!result.user)throw new Error('Login response was incomplete');if(result.user.role!=='delivery')throw new Error('This app is only for delivery accounts. Office accounts should use the Dashboard.');state.token=result.token;state.user=result.user;state.tokenExpires=Date.now()+Number(result.expiresIn||28800)*1000;persist();showHome();await loadBookings(true)}catch(err){$('loginError').textContent=err.message||'Login failed'}finally{btn.disabled=false;btn.textContent='Sign in'}});
function showHome(){$('loginView').hidden=true;$('homeView').hidden=false;$('welcome').textContent=`Hello, ${state.user.name}`}
$('logoutBtn').onclick=async()=>{if(state.pendingCompletions.length||state.pendingGps.length){if(!navigator.onLine){alert('There are GPS or delivery updates waiting to sync. Reconnect to the internet before logging out.');return}await flushPendingCompletions();if(state.pendingCompletions.length||state.pendingGps.length){alert('Some GPS or delivery updates could not sync. Keep this app signed in and contact the office before logging out.');return}}state.token=null;state.user=null;state.tokenExpires=0;state.rows=[];state.done.clear();state.gpsCaptured.clear();state.publishedRoute=[];state.depot=null;state.sortMode='assigned';state.pendingCompletions=[];state.pendingGps=[];sessionStorage.removeItem(sessionKey);localStorage.removeItem(storeKey);$('homeView').hidden=true;$('loginView').hidden=false;$('pin').value=''};
$('refreshBtn').onclick=()=>loadBookings(true);$('sortBtn').disabled=true;$('sortBtn').textContent='Route order unavailable';$('sortBtn').onclick=()=>{if(state.publishedRoute.length)state.sortMode=state.sortMode==='published'?'assigned':'published';else state.sortMode=state.sortMode==='assigned'?'optimized':'assigned';updateRouteControl();render()};$('search').addEventListener('input',render);
function pick(row,keys){for(const k of keys){if(row[k]!==undefined&&row[k]!==null&&String(row[k]).trim()!=='')return row[k]}return ''}
function rowNormalize(r){const consumer=pick(r,['consumer_no','consumer_number','consumerNo','consumer']);const name=pick(r,['consumer_name','name','customer_name']);const area=pick(r,['area','delivery_area','deliveryArea']);const address=pick(r,['address','consumer_address','consumerAddress']);const phone=pick(r,['mobile','mobile_no','phone','mobile_number']);const booking=pick(r,['booking_no','booking_number','bookingNo','order_no','order_number','id']);const qty=pick(r,['qty','quantity','order_quantity','cylinder_qty']);return {raw:r,consumer:String(consumer||''),name:String(name||'Customer'),area:String(area||''),address:String(address||''),phone:String(phone||''),booking:String(booking||''),qty:String(qty||'')}}
async function loadBookings(showMessage=true){if(!state.token)return;const btn=$('refreshBtn');btn.disabled=true;btn.textContent='Loading…';$('message').textContent='Fetching your assigned bookings from server…';try{let rows=[],offset=0;for(let page=0;page<15;page++){const result=await api({action:'db',table:'lpg_pending',op:'select',limit:1000,offset,orderBy:'consumer_no'});const chunk=Array.isArray(result.data)?result.data:[];rows.push(...chunk);if(chunk.length<1000)break;offset+=chunk.length}const normalized=rows.map(rowNormalize);state.rows=normalized;normalized.forEach((r,i)=>{if(r.raw.lat!=null&&r.raw.lng!=null&&Number.isFinite(Number(r.raw.lat))&&Number.isFinite(Number(r.raw.lng)))state.gpsCaptured.add(completionKey(r,i))});sessionStorage.setItem('samruddhi_delivery_bookings_v1',JSON.stringify(rows));try{const completed=await api({action:'delivery_completion',op:'list'});const serverKeys=new Set((completed.data||[]).map(x=>'booking:'+String(x.booking_key)));for(const r of normalized){const key=completionKey(r,state.rows.indexOf(r));if(serverKeys.has(key))state.done.add(key)} }catch(syncErr){$('message').textContent='Bookings loaded; central completion status could not be refreshed: '+syncErr.message}try{const savedLocations=await api({action:'locations_manage',op:'list'});state.depot=(savedLocations.locations||[]).find(x=>x.is_default)|| (savedLocations.locations||[]).find(x=>x.kind==='depot')||null}catch(_){state.depot=null}try{const published=await api({action:'route_manage',op:'list',route_date:localDateKey()});state.publishedRoute=published.stops||[];if(state.publishedRoute.length)state.sortMode='published';else if(state.sortMode==='published')state.sortMode='assigned'}catch(_){state.publishedRoute=[]}updateRouteControl();await flushPendingCompletions();persist();$('message').textContent=showMessage?`Updated ${state.rows.length} assigned booking(s).`:`${state.rows.length} booking(s) loaded.`;render()}catch(err){$('message').textContent=err.message;if(!state.rows.length){try{const cached=JSON.parse(sessionStorage.getItem('samruddhi_delivery_bookings_v1')||'[]');if(Array.isArray(cached)&&cached.length){state.rows=cached.map(rowNormalize);$('message').textContent='Offline mode · showing the last bookings loaded in this app session. New changes will sync when online.';render()}else $('bookingList').innerHTML='<div class="empty error-card">Could not load assigned bookings. Connect to the internet and refresh. Any queued delivery updates remain saved on this phone.</div>'}catch(_){$('bookingList').innerHTML='<div class="empty error-card">Could not load assigned bookings. Connect to the internet and refresh.</div>'}}if(/Session expired|invalid|expired/i.test(err.message)){$('message').textContent='Session expired. Please log in again.';state.token=null;state.user=null;state.tokenExpires=0;sessionStorage.removeItem(sessionKey);localStorage.setItem(storeKey,JSON.stringify({done:[...state.done],gpsCaptured:[...state.gpsCaptured]}));$('homeView').hidden=true;$('loginView').hidden=false;$('loginError').textContent='Your session expired. Please sign in again.'}}finally{btn.disabled=false;btn.textContent='↻ Refresh bookings'}}
function distance(a,b){const rad=x=>x*Math.PI/180;const R=6371000;const dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng);const x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
function getCoords(r){const rawLat=pick(r,['lat','latitude','gps_lat','location_lat']),rawLng=pick(r,['lng','longitude','gps_lng','location_lng']);if(rawLat===''||rawLng==='')return null;const lat=Number(rawLat),lng=Number(rawLng);if(Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180)return {lat,lng};return null}
function localDateKey(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function updateRouteControl(){if(state.publishedRoute.length){$('sortBtn').disabled=false;$('sortBtn').textContent=state.sortMode==='published'?'Show assigned order':'Use office-published route ('+state.publishedRoute.length+' GPS stops)';return}const count=state.rows.filter(x=>getCoords(x.raw)).length;const ready=!!state.depot&&count>=2;$('sortBtn').disabled=!ready;$('sortBtn').textContent=ready?(state.sortMode==='assigned'?'Arrange by GPS distance ('+count+')':'Show assigned order'):'Route order needs a published route or 2 approved GPS pins'}
function sortRows(rows){if(state.sortMode==='published'&&state.publishedRoute.length){const order=new Map(state.publishedRoute.map(x=>[String(x.booking_key),Number(x.stop_order)]));return rows.slice().sort((a,b)=>{const ai=order.get(String(a.booking)),bi=order.get(String(b.booking));if(ai!=null&&bi!=null)return ai-bi;if(ai!=null)return -1;if(bi!=null)return 1;return a.area.localeCompare(b.area)||a.consumer.localeCompare(b.consumer)})}if(state.sortMode==='assigned')return rows;const withGps=rows.filter(x=>getCoords(x.raw)),without=rows.filter(x=>!getCoords(x.raw));if(!withGps.length||!state.depot)return rows.slice().sort((a,b)=>a.area.localeCompare(b.area)||a.consumer.localeCompare(b.consumer));let remaining=withGps.slice(),ordered=[],current={lat:Number(state.depot.lat),lng:Number(state.depot.lng)};while(remaining.length){let nearestIndex=0,nearestDist=Infinity;remaining.forEach((item,i)=>{const c=getCoords(item.raw);const d=distance(current,c);if(d<nearestDist){nearestDist=d;nearestIndex=i}});const next=remaining.splice(nearestIndex,1)[0];ordered.push(next);current=getCoords(next.raw)}return ordered.concat(without.sort((a,b)=>a.area.localeCompare(b.area)||a.consumer.localeCompare(b.consumer)))}
function completionKey(r,index=0){return r.booking?`booking:${r.booking}`:`fallback:${r.consumer}|${r.area}|${r.address}|${r.phone}|${r.qty}|${index}`}
async function completeBooking(r,key,button){
 if(!state.gpsCaptured.has(key)){alert('GPS location must be captured before marking this booking delivered.');return}
 if(state.done.has(key))return;
 const record={booking_key:String(r.booking||''),consumer_no:String(r.consumer||''),qty:Math.max(1,Number(r.qty)||1),completed_at:new Date().toISOString()};
 if(!record.booking_key||!record.consumer_no){alert('Booking identity is incomplete. Refresh bookings and contact the office.');return}
 button.disabled=true;button.textContent='Saving delivery…';
 try{
  if(!navigator.onLine)throw new Error('OFFLINE_QUEUE');
  await flushPendingGps();
  if(state.pendingGps.some(x=>String(x.booking_key)===record.booking_key))throw new Error('GPS is waiting to sync. Keep the app open until the phone reconnects.');
  const result=await api({action:'delivery_completion',op:'save',...record});
  if(!result.success)throw new Error(result.error||'Delivery could not be saved');
  state.done.add(key);state.pendingCompletions=state.pendingCompletions.filter(x=>x.booking_key!==record.booking_key);
  persist();render();
 }catch(err){
  if(err.message==='OFFLINE_QUEUE'||!navigator.onLine){
   if(!state.pendingCompletions.some(x=>x.booking_key===record.booking_key))state.pendingCompletions.push(record);
   state.done.add(key);persist();render();
   alert('Delivery recorded on this phone and queued. GPS and delivery will sync in order when internet returns.');
  }else{
   button.disabled=false;button.textContent='Retry delivery save';alert(err.message||'Could not save delivery. It has not been marked delivered.');
  }
 }
}
async function flushPendingGps(){
 if(!state.token||!navigator.onLine||!state.pendingGps.length)return;
 const queue=[...state.pendingGps];
 for(const item of queue){
  try{
   await api({action:'gps_capture',...item});
   state.pendingGps=state.pendingGps.filter(x=>x.booking_key!==item.booking_key);
  }catch(err){if(/Session expired|invalid/i.test(err.message))break;else break;}
 }
 persist();
}
async function flushPendingCompletions(){
 if(!state.token||!navigator.onLine)return;
 await flushPendingGps();
 if(!state.pendingCompletions.length){persist();return}
 const queue=[...state.pendingCompletions];
 for(const item of queue){
  if(state.pendingGps.some(g=>String(g.booking_key)===String(item.booking_key)))continue;
  try{
   const result=await api({action:'delivery_completion',op:'save',...item});
   if(result.success)state.pendingCompletions=state.pendingCompletions.filter(x=>x.booking_key!==item.booking_key);
  }catch(err){if(/Session expired|invalid/i.test(err.message))break;}
 }
 persist();render();
}
function render(){const query=$('search').value.trim().toLowerCase();let rows=state.rows.filter(r=>[r.consumer,r.name,r.area,r.address,r.phone,r.booking].join(' ').toLowerCase().includes(query));rows=sortRows(rows);$('assignedCount').textContent=state.rows.length;$('pendingCount').textContent=state.rows.filter((r,i)=>!state.done.has(completionKey(r,i))).length;$('doneCount').textContent=state.rows.filter((r,i)=>state.done.has(completionKey(r,i))).length;if(!rows.length){$('bookingList').innerHTML='<div class="empty">No assigned booking matches your search.</div>';return}const frag=document.createDocumentFragment();rows.forEach((r,i)=>{const key=completionKey(r,state.rows.indexOf(r));const done=state.done.has(key);const el=document.createElement('article');el.className='booking'+(done?' done':'');const head=document.createElement('div');head.className='booking-head';const no=document.createElement('div');no.className='stopno';no.textContent=i+1;const details=document.createElement('div');details.innerHTML='';const customer=document.createElement('div');customer.className='customer';customer.textContent=r.name;const sub=document.createElement('div');sub.className='small';sub.textContent=`Consumer ${r.consumer||'—'}${r.area?' · '+r.area:''}`;details.append(customer,sub);head.append(no,details);const addr=document.createElement('div');addr.className='address';addr.textContent=r.address||'Address unavailable in booking data';const actions=document.createElement('div');actions.className='actions';const view=document.createElement('button');view.className='detail-btn';view.textContent='Details / GPS';view.onclick=()=>openDetail(r);const mark=document.createElement('button');mark.className='done-btn';const queued=state.pendingCompletions.some(x=>String(x.booking_key)===String(r.booking));mark.textContent=done?(queued?'Done · waiting to sync':'Delivered · synced'):(state.gpsCaptured.has(key)?'Mark delivered':'Capture GPS before Done');mark.disabled=done;mark.onclick=()=>completeBooking(r,key,mark);actions.append(view,mark);el.append(head,addr,actions);frag.append(el)});$('bookingList').replaceChildren(frag)}
function openDetail(r){state.selected=r;$('stopDetail').replaceChildren();const title=document.createElement('h2');title.className='detail-title';title.textContent=r.name;const small=document.createElement('div');small.className='small';small.textContent=`Consumer ${r.consumer||'—'} · ${r.area||'Area not provided'}`;$('stopDetail').append(title,small);const grid=document.createElement('div');grid.className='detail-grid';const fields=[['Booking No.',r.booking],['Phone',r.phone],['Address',r.address],['Quantity',r.qty]];fields.forEach(([label,value])=>{const div=document.createElement('div'),span=document.createElement('span'),b=document.createElement('b');span.textContent=label;b.textContent=value||'—';div.append(span,b);grid.append(div)});$('stopDetail').append(grid);if(r.phone){const call=document.createElement('a');call.href='tel:'+r.phone.replace(/[^0-9+]/g,'');call.className='nav-button';call.textContent='Call customer';call.style.display='block';call.style.textAlign='center';call.style.textDecoration='none';call.style.padding='12px';call.style.borderRadius='12px';$('stopDetail').append(call)}const coords=getCoords(r.raw);if(coords||r.address){const nav=document.createElement('a');nav.href=coords?`https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`:`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(r.address)}`;nav.target='_blank';nav.rel='noopener';nav.className='nav-button';nav.textContent=coords?'Navigate using Google Maps (GPS)':'Find address in Google Maps';nav.style.display='block';nav.style.textAlign='center';nav.style.textDecoration='none';nav.style.padding='12px';nav.style.borderRadius='12px';nav.style.marginTop='8px';$('stopDetail').append(nav)}const gps=document.createElement('section');gps.className='gps-panel';const gtitle=document.createElement('h3');gtitle.textContent='Capture customer GPS';const gdesc=document.createElement('p');gdesc.className='gps-status';const idx=state.rows.indexOf(r);const isDone=state.done.has(completionKey(r,idx));gdesc.textContent=isDone?'Capture five stable precise readings for office review. Existing office-approved coordinates are protected.':'Capture the customer location only. This will NOT mark the booking delivered or change its status.';const btn=document.createElement('button');btn.className='gps-button';btn.textContent=isDone?'Capture delivery location':'Capture location only';btn.disabled=!r.consumer;btn.onclick=()=>captureGps(r,btn,isDone?'delivery_after_mark_delivered':'delivery_initial_mapping');gps.append(gtitle,gdesc,btn);$('stopDetail').append(gps);$('stopDialog').showModal()}
$('closeDialog').onclick=()=>$('stopDialog').close();$('stopDialog').addEventListener('click',e=>{if(e.target===$('stopDialog'))$('stopDialog').close()});
async function captureGps(r,button,captureMode='delivery_initial_mapping'){
 if(!navigator.geolocation){alert('Geolocation is not available in this browser.');return}
 button.disabled=true;button.textContent='Collecting stable GPS readings…';
 const readings=[],gpsStatus=$('stopDetail').querySelector('.gps-status');
 const geo=options=>new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,options));
 try{
  for(let i=0;i<5;i++){
   const pos=await geo({enableHighAccuracy:true,timeout:20000,maximumAge:0});
   readings.push({lat:pos.coords.latitude,lng:pos.coords.longitude,acc:pos.coords.accuracy,ts:pos.timestamp});
   gpsStatus.textContent=`Reading ${i+1}/5 · Accuracy ${Math.round(pos.coords.accuracy)}m`;
   if(i<4)await new Promise(res=>setTimeout(res,900));
  }
  const mean={lat:readings.reduce((sum,x)=>sum+x.lat,0)/readings.length,lng:readings.reduce((sum,x)=>sum+x.lng,0)/readings.length};
  const spread=Math.max(...readings.map(x=>distance(mean,x)));
  if(readings.some(x=>x.acc>5)||spread>5)throw new Error('GPS accuracy/stability is insufficient. Move outdoors, wait for a better fix, and retry.');
  const best=readings.reduce((a,b)=>a.acc<b.acc?a:b);
  const payload={booking_key:String(r.booking||''),consumer_no:r.consumer,raw_lat:best.lat,raw_lng:best.lng,pin_lat:mean.lat,pin_lng:mean.lng,lat:mean.lat,lng:mean.lng,acc:best.acc,readings,capture_mode:captureMode};
  try{
   const result=await api({action:'gps_capture',...payload});
   gpsStatus.textContent=result.message||'GPS capture submitted.';
   state.gpsCaptured.add(completionKey(r,state.rows.indexOf(r)));persist();
   button.textContent='GPS submitted';
   alert((result.message||'GPS capture submitted successfully.')+' You can now mark this booking done.');
  }catch(err){
   const networkFailure=!navigator.onLine||/failed to fetch|networkerror|load failed/i.test(err.message||'');
   if(!networkFailure)throw err;
   if(!state.pendingGps.some(x=>x.booking_key===payload.booking_key))state.pendingGps.push(payload);
   state.gpsCaptured.add(completionKey(r,state.rows.indexOf(r)));persist();
   gpsStatus.textContent='GPS captured on this phone · waiting for internet sync.';
   button.textContent='GPS captured · waiting sync';
   alert('GPS captured on this phone. It will be saved to the central system when internet returns. Delivery completion will sync only after GPS is saved.');
  }
 }catch(err){
  gpsStatus.textContent=err.message||'GPS capture failed.';
  button.textContent='Retry GPS capture';alert(err.message||'GPS capture failed');
 }finally{button.disabled=false}
}
if('serviceWorker'in navigator&&location.protocol!=='file:'){navigator.serviceWorker.register('./sw.js').catch(()=>{})}
restore();
