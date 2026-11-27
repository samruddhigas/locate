'use strict';
const API_URL='https://uggqsvgxjhvdfkddqzyh.supabase.co/functions/v1/lpg-api';
const PUBLISHABLE_KEY='sb_publishable_gvys5Rb8ugEbQrBk2unNQQ_6ZmJSV4q';
const $=id=>document.getElementById(id);
const state={token:null,user:null,tokenExpires:0,rows:[],done:new Set(),gpsCaptured:new Set(),pendingCompletions:[],pendingGps:[],sortMode:'assigned',depot:null,publishedRoute:[],selected:null,pinPickerCancel:null};
let _gpsFix=null,_gpsWatchId=null;
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
   state.user=session.user;state.token=session.token;state.tokenExpires=Number(session.expires);showHome();startGPSWatch();loadBookings(false);
  }else{sessionStorage.removeItem(sessionKey)}
 }catch{sessionStorage.removeItem(sessionKey)}
}
function persist(){
 localStorage.setItem(storeKey,JSON.stringify({done:[...state.done],gpsCaptured:[...state.gpsCaptured],pendingCompletions:state.pendingCompletions,pendingGps:state.pendingGps}));
 if(state.token&&state.user&&state.tokenExpires>Date.now())sessionStorage.setItem(sessionKey,JSON.stringify({token:state.token,user:state.user,expires:state.tokenExpires}));
 else sessionStorage.removeItem(sessionKey);
}
async function api(body,token=state.token){const headers={'Content-Type':'application/json','apikey':PUBLISHABLE_KEY};if(token)headers['x-session-token']=token;const response=await fetch(API_URL,{method:'POST',headers,body:JSON.stringify(body)});let data;try{data=await response.json()}catch{throw new Error(`Server returned HTTP ${response.status}`)}if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);if(data.error)throw new Error(data.error);return data}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const btn=e.submitter;btn.disabled=true;btn.textContent='Signing in…';try{const result=await api({action:'login',name:$('username').value.trim(),pin:$('pin').value},null);if(!result.token||!result.user)throw new Error('Login response was incomplete');if(result.user.role!=='delivery')throw new Error('This app is only for delivery accounts. Office accounts should use the Dashboard.');state.token=result.token;state.user=result.user;state.tokenExpires=Date.now()+Number(result.expiresIn||28800)*1000;persist();showHome();startGPSWatch();await loadBookings(true)}catch(err){$('loginError').textContent=err.message||'Login failed'}finally{btn.disabled=false;btn.textContent='Sign in'}});
function showHome(){$('loginView').hidden=true;$('homeView').hidden=false;$('welcome').textContent=`Hello, ${state.user.name}`;startGPSWatch()}
$('logoutBtn').onclick=async()=>{stopGPSWatch();if(state.pendingCompletions.length||state.pendingGps.length){if(!navigator.onLine){alert('There are GPS or delivery updates waiting to sync. Reconnect to the internet before logging out.');return}await flushPendingCompletions();if(state.pendingCompletions.length||state.pendingGps.length){alert('Some GPS or delivery updates could not sync. Keep this app signed in and contact the office before logging out.');return}}state.token=null;state.user=null;state.tokenExpires=0;state.rows=[];state.done.clear();state.gpsCaptured.clear();state.publishedRoute=[];state.depot=null;state.sortMode='assigned';state.pendingCompletions=[];state.pendingGps=[];sessionStorage.removeItem(sessionKey);localStorage.removeItem(storeKey);$('homeView').hidden=true;$('loginView').hidden=false;$('pin').value=''};
$('refreshBtn').onclick=()=>loadBookings(true);$('sortBtn').disabled=true;$('sortBtn').textContent='Route order unavailable';$('sortBtn').onclick=()=>{if(state.publishedRoute.length)state.sortMode=state.sortMode==='published'?'assigned':'published';else state.sortMode=state.sortMode==='assigned'?'optimized':'assigned';updateRouteControl();render()};$('search').addEventListener('input',render);
$('gpsSearchBtn').onclick=searchGpsConsumers;
$('gpsSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchGpsConsumers()}});
async function searchGpsConsumers(){
 const q=$('gpsSearch').value.trim(),box=$('gpsSearchResults');
 if(!q){box.textContent='Enter consumer number or customer name.';return}
 $('gpsSearchBtn').disabled=true;$('gpsSearchBtn').textContent='Searching…';box.textContent='Searching consumer master…';
 try{
  const result=await api({action:'gps_search_consumers',q});
  const rows=Array.isArray(result.data)?result.data:[];
  box.replaceChildren();
  if(!rows.length){box.textContent='No consumer found. Check the number or spelling.';return}
  rows.forEach(c=>{
   const card=document.createElement('div');card.className='gps-search-result';
   const title=document.createElement('b');title.textContent=c.consumer_name||'Consumer';
   const sub=document.createElement('span');sub.textContent='Consumer '+c.consumer_no+' · '+(c.area||'Area unavailable');
   const addr=document.createElement('small');addr.textContent=c.address||'Address unavailable';
   const btn=document.createElement('button');btn.className='secondary';btn.textContent='Capture GPS only';
   btn.onclick=()=>{const r={consumer:String(c.consumer_no),name:String(c.consumer_name||'Consumer'),area:String(c.area||''),address:String(c.address||''),phone:String(c.mobile||''),booking:'',qty:'',raw:{},manualGpsLookup:true};openDetail(r)};
   card.append(title,sub,addr,btn);box.append(card);
  });
 }catch(err){box.textContent=err.message||'Consumer search failed.'}
 finally{$('gpsSearchBtn').disabled=false;$('gpsSearchBtn').textContent='Search consumer'}
}
function pick(row,keys){for(const k of keys){if(row[k]!==undefined&&row[k]!==null&&String(row[k]).trim()!=='')return row[k]}return ''}
function rowNormalize(r){const consumer=pick(r,['consumer_no','consumer_number','consumerNo','consumer']);const name=pick(r,['consumer_name','name','customer_name']);const area=pick(r,['area','delivery_area','deliveryArea']);const address=pick(r,['address','consumer_address','consumerAddress']);const phone=pick(r,['mobile','mobile_no','phone','mobile_number']);const booking=pick(r,['booking_no','booking_number','bookingNo','order_no','order_number','id']);const qty=pick(r,['qty','quantity','order_quantity','cylinder_qty']);return {raw:r,consumer:String(consumer||''),name:String(name||'Customer'),area:String(area||''),address:String(address||''),phone:String(phone||''),booking:String(booking||''),qty:String(qty||'')}}
async function loadBookings(showMessage=true){if(!state.token)return;const btn=$('refreshBtn');btn.disabled=true;btn.textContent='Loading…';$('message').textContent='Fetching your assigned bookings from server…';try{let rows=[],offset=0;for(let page=0;page<15;page++){const result=await api({action:'db',table:'lpg_pending',op:'select',limit:1000,offset,orderBy:'consumer_no'});const chunk=Array.isArray(result.data)?result.data:[];rows.push(...chunk);if(chunk.length<1000)break;offset+=chunk.length}const normalized=rows.map(rowNormalize);state.rows=normalized;normalized.forEach((r,i)=>{if(r.raw.lat!=null&&r.raw.lng!=null&&Number.isFinite(Number(r.raw.lat))&&Number.isFinite(Number(r.raw.lng)))state.gpsCaptured.add(completionKey(r,i))});sessionStorage.setItem('samruddhi_delivery_bookings_v1',JSON.stringify(rows));try{const completed=await api({action:'delivery_completion',op:'list'});const serverKeys=new Set((completed.data||[]).map(x=>'booking:'+String(x.booking_key)));for(const r of normalized){const key=completionKey(r,state.rows.indexOf(r));if(serverKeys.has(key))state.done.add(key)} }catch(syncErr){$('message').textContent='Bookings loaded; central completion status could not be refreshed: '+syncErr.message}try{const savedLocations=await api({action:'locations_manage',op:'list'});state.depot=(savedLocations.locations||[]).find(x=>x.is_default)|| (savedLocations.locations||[]).find(x=>x.kind==='depot')||null}catch(_){state.depot=null}try{const published=await api({action:'route_manage',op:'list',route_date:localDateKey()});state.publishedRoute=published.stops||[];if(state.publishedRoute.length)state.sortMode='published';else if(state.sortMode==='published')state.sortMode='assigned'}catch(_){state.publishedRoute=[]}updateRouteControl();await flushPendingCompletions();persist();$('message').textContent=showMessage?`Updated ${state.rows.length} assigned booking(s).`:`${state.rows.length} booking(s) loaded.`;render()}catch(err){$('message').textContent=err.message;if(!state.rows.length){try{const cached=JSON.parse(sessionStorage.getItem('samruddhi_delivery_bookings_v1')||'[]');if(Array.isArray(cached)&&cached.length){state.rows=cached.map(rowNormalize);$('message').textContent='Offline mode · showing the last bookings loaded in this app session. New changes will sync when online.';render()}else $('bookingList').innerHTML='<div class="empty error-card">Could not load assigned bookings. Connect to the internet and refresh. Any queued delivery updates remain saved on this phone.</div>'}catch(_){$('bookingList').innerHTML='<div class="empty error-card">Could not load assigned bookings. Connect to the internet and refresh.</div>'}}if(/Session expired|invalid|expired/i.test(err.message)){$('message').textContent='Session expired. Please log in again.';state.token=null;state.user=null;state.tokenExpires=0;sessionStorage.removeItem(sessionKey);localStorage.setItem(storeKey,JSON.stringify({done:[...state.done],gpsCaptured:[...state.gpsCaptured]}));$('homeView').hidden=true;$('loginView').hidden=false;$('loginError').textContent='Your session expired. Please sign in again.'}}finally{btn.disabled=false;btn.textContent='↻ Refresh bookings'}}
function startGPSWatch(){
 if(!navigator.geolocation||_gpsWatchId!==null)return;
 try{
  _gpsWatchId=navigator.geolocation.watchPosition(pos=>{
   const c=pos.coords,acc=Number(c.accuracy),ts=Number(pos.timestamp)||Date.now();
   if(!Number.isFinite(acc)||acc<=0||acc>1000||Date.now()-ts>15000)return;
   const fix={lat:Number(c.latitude),lng:Number(c.longitude),acc,ts};
   if(Number.isFinite(fix.lat)&&fix.lat>=-90&&fix.lat<=90&&Number.isFinite(fix.lng)&&fix.lng>=-180&&fix.lng<=180&&
      ts<=Date.now()+5000&&Date.now()-ts<=10000&&(!_gpsFix||fix.acc<=_gpsFix.acc||Date.now()-_gpsFix.ts>10000))_gpsFix=fix;
  },()=>{}, {enableHighAccuracy:true,maximumAge:3000,timeout:12000});
 }catch(_){_gpsWatchId=null;}
}
function stopGPSWatch(){if(_gpsWatchId!==null&&navigator.geolocation){navigator.geolocation.clearWatch(_gpsWatchId);_gpsWatchId=null;}_gpsFix=null;}
function distance(a,b){const rad=x=>x*Math.PI/180;const R=6371000;const dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng);const x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
function getCoords(r){const rawLat=pick(r,['lat','latitude','gps_lat','location_lat']),rawLng=pick(r,['lng','longitude','gps_lng','location_lng']);if(rawLat===''||rawLng==='')return null;const lat=Number(rawLat),lng=Number(rawLng);if(Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180)return {lat,lng};return null}
function localDateKey(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function updateRouteControl(){if(state.publishedRoute.length){$('sortBtn').disabled=false;$('sortBtn').textContent=state.sortMode==='published'?'Show assigned order':'Use office-published route ('+state.publishedRoute.length+' GPS stops)';return}const count=state.rows.filter(x=>getCoords(x.raw)).length;const ready=!!state.depot&&count>=2;$('sortBtn').disabled=!ready;$('sortBtn').textContent=ready?(state.sortMode==='assigned'?'Arrange by GPS distance ('+count+')':'Show assigned order'):'Route order needs a published route or 2 approved GPS pins'}
function sortRows(rows){if(state.sortMode==='published'&&state.publishedRoute.length){const order=new Map(state.publishedRoute.map(x=>[String(x.booking_key),Number(x.stop_order)]));return rows.slice().sort((a,b)=>{const ai=order.get(String(a.booking)),bi=order.get(String(b.booking));if(ai!=null&&bi!=null)return ai-bi;if(ai!=null)return -1;if(bi!=null)return 1;return a.area.localeCompare(b.area)||a.consumer.localeCompare(b.consumer)})}if(state.sortMode==='assigned')return rows;const withGps=rows.filter(x=>getCoords(x.raw)),without=rows.filter(x=>!getCoords(x.raw));if(!withGps.length||!state.depot)return rows.slice().sort((a,b)=>a.area.localeCompare(b.area)||a.consumer.localeCompare(b.consumer));let remaining=withGps.slice(),ordered=[],current={lat:Number(state.depot.lat),lng:Number(state.depot.lng)};while(remaining.length){let nearestIndex=0,nearestDist=Infinity;remaining.forEach((item,i)=>{const c=getCoords(item.raw);const d=distance(current,c);if(d<nearestDist){nearestDist=d;nearestIndex=i}});const next=remaining.splice(nearestIndex,1)[0];ordered.push(next);current=getCoords(next.raw)}return ordered.concat(without.sort((a,b)=>a.area.localeCompare(b.area)||a.consumer.localeCompare(b.consumer)))}
function completionKey(r,index=0){return r.booking?`booking:${r.booking}`:`fallback:${r.consumer}|${r.area}|${r.address}|${r.phone}|${r.qty}|${index}`}
async function completeBooking(r,key,button){
 if(state.done.has(key))return;
 const record={booking_key:String(r.booking||''),consumer_no:String(r.consumer||''),qty:Math.max(1,Number(r.qty)||1),completed_at:null};
 if(!record.booking_key||!record.consumer_no){alert('Booking identity is incomplete. Refresh bookings and contact the office.');return}
 button.disabled=true;button.textContent='Getting location…';
 let gpsSaved=false,gpsMessage='';
 // Every physical delivery gets its own fresh visit observation. A GPS point captured
 // earlier for initial mapping must never be reused to verify a later delivery.
 const gpsResult=await captureGps(r,button,'delivery_after_mark_delivered',{silent:true});
 gpsSaved=!!gpsResult?.saved;
 gpsMessage=gpsResult?.message||'';
 // Never complete a delivery without a fresh, valid GPS observation for this visit.
 if(!gpsSaved&&!gpsResult?.queued){button.disabled=false;button.textContent='Retry Mark Done';$('message').textContent='Delivery NOT marked done. Valid GPS (1–30 m) is required. '+gpsMessage;return;}
 // Start the completion window only after the operator confirms the map pin.
 record.completed_at=new Date().toISOString();
 button.textContent='Saving delivery…';
 try{
  if(!navigator.onLine)throw new Error('OFFLINE_QUEUE');
  await flushPendingGps();
  const gpsQueued=state.pendingGps.some(x=>String(x.booking_key||'')===record.booking_key&&String(x.consumer_no)===record.consumer_no);
  const result=await api({action:'delivery_completion',op:'save',...record});
  if(!result.success)throw new Error(result.error||'Delivery could not be saved');
  state.done.add(key);
  state.pendingCompletions=state.pendingCompletions.filter(x=>x.booking_key!==record.booking_key);
  persist();render();
  const check=result.location_check||{};
  let note=gpsSaved?'Delivery saved with this visit GPS recorded.':(gpsQueued?'Delivery saved. GPS was captured and is waiting to sync.':('Delivery saved. GPS not captured: '+(gpsMessage||'location signal was weak')+'. You can capture it later using GPS-only search.'));
  if(check.result==='temporary_approved')note+=' Temporary location verified after 3 consistent deliveries and is now eligible for route planning.';
  else if(check.result==='provisional')note+=' Temporary location is provisional ('+(check.temporary_confirmation_count||2)+' consistent deliveries). One more consistent delivery will make it route-eligible.';
  else if(check.result==='candidate')note+=' First location observation recorded; more consistent deliveries are needed.';
  else if(check.result==='deviation')note+=' LOCATION DEVIATION: '+Math.round(check.distance_m||0)+' m from the office-approved pin. An exception has been recorded for office review.';
  else if(check.result==='nearby_warning')note+=' Location warning: '+Math.round(check.distance_m||0)+' m from the approved pin. An exception has been recorded for office review.';
  else if(check.result==='outlier_review')note+=' This visit differs from the temporary location cluster and has been flagged for office review.';
  else if(check.result==='same_day_repeat')note+=' This is another booking on the same day; it does not count as a separate location confirmation.';
  $('message').textContent=note;
 }catch(err){
  if(err.message==='OFFLINE_QUEUE'||!navigator.onLine){
   if(!state.pendingCompletions.some(x=>x.booking_key===record.booking_key))state.pendingCompletions.push(record);
   state.done.add(key);persist();render();
   $('message').textContent='Delivery saved on this phone and waiting to sync. GPS '+(gpsSaved?'is queued for sync.':'was not available; capture it later from GPS-only search.');
  }else{
   button.disabled=false;button.textContent='Retry Mark Done';alert(err.message||'Could not save delivery. It has not been marked done.');
  }
 }
}
async function flushPendingGps(){
 if(!state.token||!navigator.onLine||!state.pendingGps.length)return;
 const queue=[...state.pendingGps];
 for(const item of queue){
  try{
   await api({action:'gps_capture',...item});
   state.pendingGps=state.pendingGps.filter(x=>!(String(x.booking_key||'')===String(item.booking_key||'')&&String(x.consumer_no)===String(item.consumer_no)));
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
  try{
   const result=await api({action:'delivery_completion',op:'save',...item});
   if(result.success)state.pendingCompletions=state.pendingCompletions.filter(x=>x.booking_key!==item.booking_key);
  }catch(err){if(/Session expired|invalid/i.test(err.message))break;}
 }
 persist();render();
}
function render(){const query=$('search').value.trim().toLowerCase();let rows=state.rows.filter(r=>[r.consumer,r.name,r.area,r.address,r.phone,r.booking].join(' ').toLowerCase().includes(query));rows=sortRows(rows);$('assignedCount').textContent=state.rows.length;$('pendingCount').textContent=state.rows.filter((r,i)=>!state.done.has(completionKey(r,i))).length;$('doneCount').textContent=state.rows.filter((r,i)=>state.done.has(completionKey(r,i))).length;if(!rows.length){$('bookingList').innerHTML='<div class="empty">No assigned booking matches your search.</div>';return}const frag=document.createDocumentFragment();rows.forEach((r,i)=>{const key=completionKey(r,state.rows.indexOf(r));const done=state.done.has(key);const el=document.createElement('article');el.className='booking'+(done?' done':'');const head=document.createElement('div');head.className='booking-head';const no=document.createElement('div');no.className='stopno';no.textContent=i+1;const details=document.createElement('div');details.innerHTML='';const customer=document.createElement('div');customer.className='customer';customer.textContent=r.name;const sub=document.createElement('div');sub.className='small';sub.textContent=`Consumer ${r.consumer||'—'}${r.area?' · '+r.area:''}`;details.append(customer,sub);head.append(no,details);const addr=document.createElement('div');addr.className='address';addr.textContent=r.address||'Address unavailable in booking data';const actions=document.createElement('div');actions.className='actions';const view=document.createElement('button');view.className='detail-btn';view.textContent='Details / GPS';view.onclick=()=>openDetail(r);const mark=document.createElement('button');mark.className='done-btn';const queued=state.pendingCompletions.some(x=>String(x.booking_key)===String(r.booking));mark.textContent=done?(queued?'Done · waiting to sync':'Delivered · synced'):'Mark Done';mark.disabled=done;mark.onclick=()=>completeBooking(r,key,mark);actions.append(view,mark);el.append(head,addr,actions);frag.append(el)});$('bookingList').replaceChildren(frag)}
function openDetail(r){state.selected=r;$('stopDetail').replaceChildren();const title=document.createElement('h2');title.className='detail-title';title.textContent=r.name;const small=document.createElement('div');small.className='small';small.textContent=`Consumer ${r.consumer||'—'} · ${r.area||'Area not provided'}`;$('stopDetail').append(title,small);const grid=document.createElement('div');grid.className='detail-grid';const fields=[['Booking No.',r.booking],['Phone',r.phone],['Address',r.address],['Quantity',r.qty]];fields.forEach(([label,value])=>{const div=document.createElement('div'),span=document.createElement('span'),b=document.createElement('b');span.textContent=label;b.textContent=value||'—';div.append(span,b);grid.append(div)});$('stopDetail').append(grid);if(r.phone){const call=document.createElement('a');call.href='tel:'+r.phone.replace(/[^0-9+]/g,'');call.className='nav-button';call.textContent='Call customer';call.style.display='block';call.style.textAlign='center';call.style.textDecoration='none';call.style.padding='12px';call.style.borderRadius='12px';$('stopDetail').append(call)}const coords=getCoords(r.raw);if(coords||r.address){const nav=document.createElement('a');nav.href=coords?`https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`:`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(r.address)}`;nav.target='_blank';nav.rel='noopener';nav.className='nav-button';nav.textContent=coords?'Navigate using Google Maps (GPS)':'Find address in Google Maps';nav.style.display='block';nav.style.textAlign='center';nav.style.textDecoration='none';nav.style.padding='12px';nav.style.borderRadius='12px';nav.style.marginTop='8px';$('stopDetail').append(nav)}const gps=document.createElement('section');gps.className='gps-panel';const gtitle=document.createElement('h3');gtitle.textContent='Capture customer GPS';const gdesc=document.createElement('p');gdesc.className='gps-status';const idx=state.rows.indexOf(r);const isDone=state.done.has(completionKey(r,idx));gdesc.textContent=r.manualGpsLookup?'GPS-only capture. This does not require a booking or change delivery status.':(isDone?'Capture a better customer location for office review. Existing office-approved coordinates are protected.':'Mark Done will attempt GPS automatically; use this button only if you want to capture location without marking delivered.');const btn=document.createElement('button');btn.className='gps-button';btn.textContent='Capture GPS only';btn.disabled=!r.consumer;btn.onclick=()=>captureGps(r,btn,r.manualGpsLookup?'delivery_manual_lookup':(isDone?'delivery_after_mark_delivered':'delivery_initial_mapping'));gps.append(gtitle,gdesc,btn);$('stopDetail').append(gps);$('stopDialog').showModal()}
$('closeDialog').onclick=()=>{if(state.pinPickerCancel)state.pinPickerCancel();$('stopDialog').close()};$('stopDialog').addEventListener('click',e=>{if(e.target===$('stopDialog')){if(state.pinPickerCancel)state.pinPickerCancel();$('stopDialog').close()}});

function chooseGpsPin(r,best){
 if(!window.L)return Promise.resolve(null);
 return new Promise(resolve=>{
  const dlg=$('pinPickerDialog'),mapEl=$('pinPickerMap');
  $('pinPickerConsumer').textContent=(r.name||'Customer')+' · Consumer '+r.consumer;
  $('pinPickerAccuracy').textContent='Device GPS accuracy: ±'+best.acc.toFixed(1)+' metres. Drag the pin or tap the map to select the actual main entrance.';
  let map=null,marker=null,street=null,satellite=null,layer='street',finished=false;
  const finish=value=>{
   if(finished)return;finished=true;state.pinPickerCancel=null;
   dlg.removeEventListener('cancel',onCancel);
   if(map){map.remove();map=null;}
   if(dlg.open)dlg.close();
   resolve(value);
  };
  const onCancel=()=>finish(null);
  state.pinPickerCancel=()=>finish(null);
  dlg.addEventListener('cancel',onCancel,{once:true});
  try{
   dlg.showModal();
   map=L.map(mapEl,{zoomControl:true,scrollWheelZoom:false}).setView([best.lat,best.lng],19);
   street=L.tileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',{maxZoom:22,attribution:'© OpenStreetMap contributors © CARTO'});
   satellite=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:20,attribution:'Tiles © Esri'});
   street.addTo(map);marker=L.marker([best.lat,best.lng],{draggable:true}).addTo(map);
   const update=()=>{
    const p=marker.getLatLng(),offset=distance({lat:best.lat,lng:best.lng},{lat:p.lat,lng:p.lng});
    const accuracyOk=Number.isFinite(best.acc)&&best.acc>0&&best.acc<=30;
    $('pinPickerCoords').textContent='Entrance pin offset: '+Math.round(offset)+' m from GPS'+(offset>500?' · Move within 500 m':'')+(!accuracyOk?' · GPS accuracy must be 30 m or better before saving':'');
    $('pinPickerCoords').classList.toggle('pin-too-far',offset>500||!accuracyOk);$('pinPickerConfirm').disabled=offset>500||!accuracyOk;
   };
   marker.on('dragend',update);map.on('click',e=>{marker.setLatLng(e.latlng);update();});
   $('pinPickerStreet').onclick=()=>{if(layer!=='street'){map.removeLayer(satellite);street.addTo(map);layer='street';}};
   $('pinPickerSatellite').onclick=()=>{if(layer!=='satellite'){map.removeLayer(street);satellite.addTo(map);layer='satellite';}};
   $('pinPickerClose').onclick=()=>finish(null);$('pinPickerCancel').onclick=()=>finish(null);
   $('pinPickerRetry').onclick=()=>finish({retry:true});
   $('pinPickerConfirm').onclick=()=>{const p=marker.getLatLng();finish({lat:p.lat,lng:p.lng});};
   update();setTimeout(()=>map&&map.invalidateSize(),180);
  }catch(e){finish(null);}
 });
}
window.__nativeGpsCallbacks=window.__nativeGpsCallbacks||{};
function requestNativeGps(onPosition,onError){
 if(!window.AndroidLocation||typeof window.AndroidLocation.getCurrentLocation!=='function')return false;
 const id='native_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);
 window.__nativeGpsCallbacks[id]=(lat,lng,acc,ts,error)=>{
  delete window.__nativeGpsCallbacks[id];
  if(error){onError({code:2,message:String(error)});return;}
  onPosition({coords:{latitude:Number(lat),longitude:Number(lng),accuracy:Number(acc)},timestamp:Number(ts)||Date.now()});
 };
 try{window.AndroidLocation.getCurrentLocation(id);setTimeout(()=>{delete window.__nativeGpsCallbacks[id]},35000);return true;}
 catch(e){delete window.__nativeGpsCallbacks[id];onError({code:2,message:e.message||'Native Android GPS request failed'});return false;}
}
async function captureGps(r,button,captureMode='delivery_initial_mapping',options={}){
 const browserGps=!!navigator.geolocation;
 const nativeGps=!!(window.AndroidLocation&&typeof window.AndroidLocation.getCurrentLocation==='function');
 if(!browserGps&&!nativeGps){const msg='No location provider is available. Open the official app in Chrome or the Samruddhi Android app.';if(!options.silent)alert(msg);return {saved:false,message:msg}}
 const detail=$('stopDetail');
 const status=detail?detail.querySelector('.gps-status'):null;
 button.disabled=true;button.textContent='Finding best GPS…';
 try{
  // Continuously request fresh GNSS/high-accuracy fixes. Never average coordinates:
  // while the delivery person is moving, averaging would place the customer between locations.
  // Reuse the continuously warmed GNSS fix whenever it is recent and sufficiently accurate.
  // This removes the per-delivery cold-start delay without pretending a weak fix is precise.
  const warmFix=captureMode!=='delivery_after_mark_delivered'&&_gpsFix&&
   Number.isFinite(Number(_gpsFix.lat))&&Number(_gpsFix.lat)>=-90&&Number(_gpsFix.lat)<=90&&
   Number.isFinite(Number(_gpsFix.lng))&&Number(_gpsFix.lng)>=-180&&Number(_gpsFix.lng)<=180&&
   Number(_gpsFix.acc)>0&&Number(_gpsFix.acc)<=10&&Date.now()-Number(_gpsFix.ts||0)<=5000
   ?{lat:Number(_gpsFix.lat),lng:Number(_gpsFix.lng),acc:Number(_gpsFix.acc),ts:Number(_gpsFix.ts)}:null;
  const best=warmFix||await new Promise((resolve,reject)=>{
   let watchId=null,deadline=null,bestFix=null,finished=false,startedAt=Date.now();
   const finish=(err)=>{
    if(finished)return;finished=true;
    if(watchId!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId);
    if(deadline!==null)clearTimeout(deadline);
    if(err)reject(err);else resolve(bestFix);
   };
   deadline=setTimeout(()=>finish(bestFix&&bestFix.acc>0&&bestFix.acc<=1000?null:new Error('No valid location fix received within 40 seconds. Check Android Location and precise permission, move outdoors, then retry.')),40000);
   const acceptPosition=pos=>{
    if(finished)return;
    const c=pos.coords,acc=Number(c.accuracy);
    if(!Number.isFinite(acc)||acc<=0||acc>1000)return;
    const fix={lat:Number(c.latitude),lng:Number(c.longitude),acc,ts:Number(pos.timestamp)||Date.now()};
    if(!Number.isFinite(fix.lat)||fix.lat < -90||fix.lat > 90||!Number.isFinite(fix.lng)||fix.lng < -180||fix.lng > 180||
       fix.ts>Date.now()+5000||Date.now()-fix.ts>10000)return;
    if(!bestFix||fix.acc<bestFix.acc)bestFix=fix;
    button.textContent='Best GPS '+Math.round(bestFix.acc)+' m…';
    if(status)status.textContent='Improving GPS fix · best so far '+Math.round(bestFix.acc)+' m';
    if(bestFix.acc<=10&&Date.now()-startedAt>=5000)finish();
   };
   let nativeRequested=false;
   const acceptError=err=>{if(err.code===1&&!nativeRequested)finish(new Error('Browser location permission denied. Allow precise location or use the Samruddhi Android app.'));else if(status)status.textContent='One location provider is unavailable; waiting for the other provider…';};
   // Start native fused location independently before browser geolocation.
   try{nativeRequested=requestNativeGps(acceptPosition,err=>{if(status)status.textContent='Native location: '+(err.message||'unavailable')+'; checking browser location…';});}catch(_){nativeRequested=false;}
   if(browserGps){
    try{watchId=navigator.geolocation.watchPosition(acceptPosition,acceptError,{enableHighAccuracy:true,timeout:25000,maximumAge:0});}catch(_){watchId=null;}
    try{navigator.geolocation.getCurrentPosition(acceptPosition,acceptError,{enableHighAccuracy:true,timeout:20000,maximumAge:0});}catch(_){ }
    // Network-assisted coarse fix is a secondary candidate, never a relaxed save rule.
    try{navigator.geolocation.getCurrentPosition(acceptPosition,acceptError,{enableHighAccuracy:false,timeout:15000,maximumAge:0});}catch(_){ }
   }
   if(!nativeRequested&&!browserGps)finish(new Error('No supported location provider is available on this device.'));
  });
  if(!best||!Number.isFinite(best.acc)||best.acc<=0||best.acc>1000)throw new Error('No valid GPS coordinate was received. Keep Location enabled and retry.');
  const accuracy=best.acc;
  let pin={lat:best.lat,lng:best.lng};
  // Every GPS capture, including Mark Done, requires an entrance-map pin confirmation.
  // Weak fixes may be inspected on-map, but saving stays disabled until accuracy is <=30 m.
  const selected=await chooseGpsPin(r,best);
  if(selected?.retry){if(status)status.textContent='Refreshing GPS…';return await captureGps(r,button,captureMode,options);}
  if(!selected){if(status)status.textContent='Map selection cancelled or GPS accuracy is above 30 m. No location was submitted.';button.textContent='Capture GPS again';return {saved:false,message:'Pin confirmation unavailable. GPS accuracy must be 30 m or better.'};}
  pin=selected;
  const payload={booking_key:String(r.booking||''),consumer_no:r.consumer,raw_lat:best.lat,raw_lng:best.lng,pin_lat:pin.lat,pin_lng:pin.lng,lat:pin.lat,lng:pin.lng,acc:accuracy,
   // Keep the device GPS fix separate from the entrance pin selected on the map.
   readings:[{lat:best.lat,lng:best.lng,acc:accuracy,ts:best.ts}],capture_mode:captureMode};
  try{
   const result=await api({action:'gps_capture',...payload});
   if(!r.manualGpsLookup)state.gpsCaptured.add(completionKey(r,state.rows.indexOf(r)));
   persist();
   if(status)status.textContent='Best GPS saved · '+Math.round(accuracy)+' m accuracy · pending office verification.';
   button.textContent='GPS saved · '+Math.round(accuracy)+' m';
   const msg=(result.message||'Best available GPS fix saved.')+' Accuracy: about '+Math.round(accuracy)+' metres.';
   if(!options.silent)alert(msg);
   return {saved:true,message:msg,accuracy};
  }catch(err){
   const networkFailure=!navigator.onLine||/failed to fetch|networkerror|load failed/i.test(err.message||'');
   if(!networkFailure)throw err;
   if(!state.pendingGps.some(x=>String(x.booking_key||'')===String(payload.booking_key||'')&&x.consumer_no===payload.consumer_no))state.pendingGps.push(payload);
   if(!r.manualGpsLookup)state.gpsCaptured.add(completionKey(r,state.rows.indexOf(r)));
   persist();
   if(status)status.textContent='Best GPS captured · '+Math.round(accuracy)+' m · waiting for internet sync.';
   button.textContent='GPS queued · '+Math.round(accuracy)+' m';
   const msg='Best GPS captured on this phone and queued to sync. Accuracy: about '+Math.round(accuracy)+' metres.';
   if(!options.silent)alert(msg);
   return {saved:false,queued:true,message:msg,accuracy};
  }
 }catch(err){
  const msg=err?.message||'GPS capture failed.';
  if(status)status.textContent=msg;
  button.textContent='Retry GPS';
  if(!options.silent)alert(msg);
  return {saved:false,message:msg};
 }finally{button.disabled=false}
}
if('serviceWorker'in navigator&&location.protocol!=='file:'){navigator.serviceWorker.register('./sw.js').catch(()=>{})}
restore();
