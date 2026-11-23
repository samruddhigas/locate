'use strict';
const API_URL='https://uggqsvgxjhvdfkddqzyh.supabase.co/functions/v1/lpg-api';
const PUBLISHABLE_KEY='sb_publishable_gvys5Rb8ugEbQrBk2unNQQ_6ZmJSV4q';
const $=id=>document.getElementById(id);
const AUTH_KEY='samruddhi_delivery_session_v3';
const DONE_KEY='samruddhi_delivery_done_v3';
const state={token:null,user:null,expires:0,rows:[],done:new Set()};
function api(body,token=state.token){
 const headers={'Content-Type':'application/json','apikey':PUBLISHABLE_KEY};
 if(token)headers['x-session-token']=token;
 return fetch(API_URL,{method:'POST',headers,body:JSON.stringify(body)}).then(async r=>{
  let d={};try{d=await r.json()}catch{}
  if(!r.ok||d.error)throw new Error(d.error||'Server error (HTTP '+r.status+')');
  return d;
 });
}
function message(s,error=false){$('message').textContent=s;$('message').className=error?'error':'muted'}
function setNetwork(){const e=$('network');e.textContent=navigator.onLine?'Online':'Offline';e.className='pill '+(navigator.onLine?'online':'offline')}
addEventListener('online',setNetwork);addEventListener('offline',setNetwork);setNetwork();
function localDateKey(){const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
function today(){return new Intl.DateTimeFormat('en-IN',{weekday:'long',day:'2-digit',month:'short',year:'numeric'}).format(new Date())}
$('todayText').textContent=today();
function readDone(){try{const saved=JSON.parse(localStorage.getItem(DONE_KEY)||'null');state.done=new Set(saved&&saved.date===localDateKey()&&Array.isArray(saved.items)?saved.items:[])}catch{state.done=new Set()}}
function saveDone(){localStorage.setItem(DONE_KEY,JSON.stringify({date:localDateKey(),items:[...state.done]}))}
function saveSession(){sessionStorage.setItem(AUTH_KEY,JSON.stringify({token:state.token,user:state.user,expires:state.expires}))}
function clearSession(){state.token=null;state.user=null;state.expires=0;sessionStorage.removeItem(AUTH_KEY)}
function showHome(){ $('loginView').hidden=true;$('homeView').hidden=false;$('welcome').textContent='Hello, '+state.user.name }
function showLogin(){ $('homeView').hidden=true;$('loginView').hidden=false }
function restoreSession(){
 try{const s=JSON.parse(sessionStorage.getItem(AUTH_KEY)||'null');if(s&&s.token&&s.user&&s.expires>Date.now()&&s.user.role==='delivery'){state.token=s.token;state.user=s.user;state.expires=s.expires;showHome();loadBookings(false);return}}catch{}
 clearSession();showLogin();
}
$('loginForm').addEventListener('submit',async e=>{
 e.preventDefault();const b=$('loginBtn');b.disabled=true;b.textContent='Signing in…';$('loginError').textContent='';
 try{
  const d=await api({action:'login',name:$('username').value.trim(),pin:$('pin').value},null);
  if(!d.token||!d.user)throw new Error('The server returned an incomplete login response.');
  if(d.user.role!=='delivery'){throw new Error('This app is only for delivery accounts. Please use your office Dashboard account there.')}
  state.token=d.token;state.user=d.user;state.expires=Date.now()+Math.max(60,Number(d.expiresIn)||28800)*1000;
  saveSession();showHome();await loadBookings(true);
 }catch(err){clearSession();$('loginError').textContent=err.message||'Login failed. Check username and PIN.'}
 finally{b.disabled=false;b.textContent='Sign in'}
});
$('logoutBtn').onclick=()=>{clearSession();state.rows=[];$('pin').value='';showLogin();message('')};
$('refreshBtn').onclick=()=>loadBookings(true);
$('search').addEventListener('input',render);
function pick(r,keys){for(const k of keys){const v=r?.[k];if(v!==undefined&&v!==null&&String(v).trim()!=='')return v}return ''}
function normalize(r){return {raw:r,consumer:String(pick(r,['consumer_no','consumer_number','consumerNo','consumer'])||''),name:String(pick(r,['consumer_name','name','customer_name'])||'Customer'),area:String(pick(r,['area','delivery_area','deliveryArea'])||''),address:String(pick(r,['address','consumer_address','consumerAddress'])||''),phone:String(pick(r,['mobile','mobile_no','phone','mobile_number'])||''),booking:String(pick(r,['booking_no','booking_number','bookingNo','order_no','order_number','id'])||''),qty:String(pick(r,['qty','quantity','order_quantity','cylinder_qty'])||'')}}
function keyOf(r,i){const who=state.user?.name||'unknown';const day=String(pick(r.raw,['delivery_date','booking_date','order_date','date'])||localDateKey()).slice(0,10);return who+'|'+day+'|'+(r.booking?'booking:'+r.booking:'row:'+r.consumer+'|'+r.area+'|'+r.address+'|'+r.phone+'|'+r.qty+'|'+i)}
async function loadBookings(showNotice=true){
 if(!state.token)return;
 if(state.expires<=Date.now()){clearSession();showLogin();$('loginError').textContent='Your session expired. Please sign in again.';return}
 const b=$('refreshBtn');b.disabled=true;b.textContent='Loading…';message('Loading your office-assigned bookings…');
 try{
  const rows=[];let offset=0;
  for(let p=0;p<15;p++){
   const d=await api({action:'db',table:'lpg_pending',op:'select',limit:1000,offset});
   const part=Array.isArray(d.data)?d.data:[];
   rows.push(...part);if(part.length<1000)break;offset+=part.length;
  }
  state.rows=rows.map(normalize);message(showNotice?'Updated '+state.rows.length+' assigned booking(s).':state.rows.length+' booking(s) loaded.');render();
 }catch(err){
  message(err.message||'Could not load bookings.',true);
  if(/session|invalid token|expired|unauthorized/i.test(err.message)){clearSession();showLogin();$('loginError').textContent='Your session expired. Please sign in again.'}
  if(!state.rows.length){$('bookingList').replaceChildren(Object.assign(document.createElement('div'),{className:'empty',textContent:'No bookings loaded. Check your internet and tap Refresh.'}))}
 }finally{b.disabled=false;b.textContent='↻ Refresh my bookings'}
}
function coords(r){
 const a=pick(r,['lat','latitude','gps_lat','location_lat']),o=pick(r,['lng','longitude','gps_lng','location_lng']);
 if(a===''||o==='')return null;
 const lat=Number(a),lng=Number(o);
 return Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180?{lat,lng}:null;
}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function render(){
 const q=$('search').value.trim().toLowerCase();
 const list=state.rows.map((r,i)=>({...r,_index:i,_key:keyOf(r,i)})).filter(r=>[r.consumer,r.name,r.area,r.address,r.phone,r.booking].join(' ').toLowerCase().includes(q));
 $('assignedCount').textContent=state.rows.length;
 $('pendingCount').textContent=state.rows.filter((r,i)=>!state.done.has(keyOf(r,i))).length;
 $('doneCount').textContent=state.rows.filter((r,i)=>state.done.has(keyOf(r,i))).length;
 const box=$('bookingList');box.replaceChildren();
 if(!list.length){box.append(el('div','empty',state.rows.length?'No booking matches your search.':'No bookings are currently assigned to your account.'));return}
 list.forEach(r=>{
  const done=state.done.has(r._key),card=el('article','booking'+(done?' done':''));
  const top=el('div','booking-top');top.append(el('span','number',String(r._index+1)));
  const info=el('div');info.append(el('div','customer',r.name),el('div','sub','Consumer '+(r.consumer||'—')+(r.area?' • '+r.area:'')));
  top.append(info);card.append(top);
  card.append(el('div','address',r.address||'Address not available in booking data'));
  const acts=el('div','actions');
  if(r.phone){const a=el('a','call','Call customer');a.href='tel:'+r.phone.replace(/[^0-9+]/g,'');acts.append(a)}
  const c=coords(r.raw),dest=c?c.lat+','+c.lng:r.address;
  if(dest){const a=el('a','map','Open Maps');a.href='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(dest);a.target='_blank';a.rel='noopener';acts.append(a)}
  const d=el('button','doneBtn',done?'Undo local Done':'Mark delivered (local only)');d.type='button';d.onclick=()=>{if(state.done.has(r._key))state.done.delete(r._key);else state.done.add(r._key);saveDone();render()};acts.append(d);
  const details=el('button','secondary','Details / GPS');details.type='button';details.onclick=()=>openDetails(r);acts.append(details);
  card.append(acts);box.append(card);
 });
}
function openDetails(r){
 const box=$('detailContent');box.replaceChildren();
 box.append(el('h2','',r.name),el('p','muted','Consumer '+(r.consumer||'—')+(r.area?' • '+r.area:'')));
 const table=el('div','');
 [['Booking',r.booking],['Phone',r.phone],['Address',r.address],['Quantity',r.qty]].forEach(([k,v])=>{const p=el('p','sub',k+': '+(v||'—'));box.append(p)});
 if(r.phone){const call=el('a','call','Call customer');call.href='tel:'+r.phone.replace(/[^0-9+]/g,'');box.append(call)}
 const c=coords(r.raw),dest=c?c.lat+','+c.lng:r.address;
 if(dest){const map=el('a','map','Navigate in Google Maps');map.href='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(dest);map.target='_blank';map.rel='noopener';map.style.display='block';map.style.marginTop='10px';box.append(map)}
 const section=el('section','');section.style.marginTop='16px';section.style.borderTop='1px solid #dce7e2';section.style.paddingTop='14px';
 section.append(el('b','', 'Capture customer GPS'));
 section.append(el('p','sub','Capture is available after you mark the delivery complete on this phone. Five precise readings (accuracy 5 metres or better) are submitted to the agency for office review. This does not create the official HPCL delivery record.'));
 const status=el('p','sub',state.done.has(r._key)?'Ready to capture the delivery location.':'First mark the delivery complete on this phone, then capture GPS.');const gps=el('button','secondary',state.done.has(r._key)?'Capture GPS after delivery':'Mark delivery done first');gps.style.width='100%';gps.disabled=!state.done.has(r._key);gps.onclick=()=>captureGps(r,gps,status);
 section.append(status,gps);box.append(section);$('detailDialog').showModal();
}
$('closeDialog').onclick=()=> $('detailDialog').close();
$('detailDialog').addEventListener('click',e=>{if(e.target===$('detailDialog'))$('detailDialog').close()});
function getPosition(){return new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:20000,maximumAge:0}))}
function meters(a,b){const rad=x=>x*Math.PI/180,R=6371000,d1=rad(b.lat-a.lat),d2=rad(b.lng-a.lng),x=Math.sin(d1/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(d2/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
async function captureGps(r,button,status){
 if(!r.consumer){status.textContent='Consumer number is missing; GPS capture is disabled.';return}
 if(!navigator.geolocation){status.textContent='This browser does not support GPS.';return}
 button.disabled=true;button.textContent='Collecting GPS…';const readings=[];
 try{
  for(let i=0;i<5;i++){const p=await getPosition(),c=p.coords;readings.push({lat:c.latitude,lng:c.longitude,acc:c.accuracy,ts:p.timestamp});status.textContent='Reading '+(i+1)+' of 5 • accuracy '+Math.round(c.accuracy)+' m';if(i<4)await new Promise(resolve=>setTimeout(resolve,900))}
  const avg={lat:readings.reduce((s,x)=>s+x.lat,0)/5,lng:readings.reduce((s,x)=>s+x.lng,0)/5};
  const spread=Math.max(...readings.map(x=>meters(avg,x)));
  if(readings.some(x=>x.acc>5)||spread>5)throw new Error('GPS is not precise or stable enough. Move outdoors, stand still, and retry.');
  const best=readings.reduce((a,b)=>a.acc<b.acc?a:b);
  const result=await api({action:'gps_capture',consumer_no:r.consumer,raw_lat:best.lat,raw_lng:best.lng,pin_lat:avg.lat,pin_lng:avg.lng,lat:avg.lat,lng:avg.lng,acc:best.acc,readings,capture_mode:'delivery_after_mark_delivered'});
  status.textContent=result.message||'GPS capture submitted. The server has accepted the request.';
  button.textContent='GPS submitted';
 }catch(err){status.textContent=err.message||'GPS capture failed.';button.textContent='Retry GPS capture'}
 finally{button.disabled=false}
}
if('serviceWorker'in navigator&&location.protocol!=='file:'){navigator.serviceWorker.register('./sw.js').catch(()=>{})}
readDone();restoreSession();
