// Route2Root backend: Express + SQLite. Auth, roles, dispatch/safety engine, SSE live updates.
const express=require('express'),crypto=require('crypto'),Database=require('better-sqlite3'),path=require('path');
const PORT=process.env.PORT||3000,SECRET=process.env.SECRET||'change-me-in-production';
const CFG={kmh:+process.env.SPEED_KMH||22,handover:5,resMin:10,stallMin:15,road:1.3};
const db=new Database(process.env.DB_FILE||'route2root.db');db.pragma('journal_mode=WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,name TEXT,pass TEXT,role TEXT,approved INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS shelters(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,lat REAL,lng REAL,demand INTEGER,open INTEGER DEFAULT 1,cook INTEGER DEFAULT 0,water INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS riders(user_id INTEGER PRIMARY KEY,online INTEGER DEFAULT 1,responsive INTEGER DEFAULT 1,cap INTEGER DEFAULT 40,lat REAL,lng REAL,seen INTEGER,sim INTEGER DEFAULT 0,vehicle TEXT);
CREATE TABLE IF NOT EXISTS donations(id INTEGER PRIMARY KEY,donor_id INTEGER,type TEXT,qty INTEGER,rem INTEGER,win INTEGER,deadline INTEGER,status TEXT,lat REAL,lng REAL,address TEXT,storage TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY,donation_id INTEGER,qty INTEGER,shelter_id INTEGER,rider_id INTEGER,status TEXT,deadline INTEGER,eta INTEGER,otp_pick TEXT,otp_drop TEXT,tf REAL DEFAULT 1,lat REAL,lng REAL,type TEXT,res_exp INTEGER,created INTEGER,delivered INTEGER);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,ts INTEGER,batch_id INTEGER,donation_id INTEGER,msg TEXT,sim INTEGER DEFAULT 0);
`);
const now=()=>Date.now(),q=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a),run=(s,...a)=>db.prepare(s).run(...a);
let SIM=0;
const ev=(b,msg,d)=>run('INSERT INTO events(ts,batch_id,donation_id,msg,sim) VALUES(?,?,?,?,?)',now(),b||null,d||null,(SIM?'[SIMULATED] ':'')+msg,SIM);
const need=(c,m)=>{if(!c)throw new Error(m)};
const km=(a,b)=>{const r=x=>x*Math.PI/180,dl=r(b.lat-a.lat),dn=r(b.lng-a.lng),h=Math.sin(dl/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dn/2)**2;return 12742*Math.asin(Math.sqrt(h))};
// ESTIMATE only (straight-line x road factor / assumed speed). No live traffic API is configured.
const mins=(a,b,tf=1)=>km(a,b)*CFG.road/CFG.kmh*60*tf;
const ACTIVE="('Reserved','Accepted','PickedUp','Handover')";
const compat=(t,s)=>/ration/i.test(t)?!!s.cook:/infant/i.test(t)?!!s.water:true;
const reservedQty=(sid,ex=0)=>one(`SELECT COALESCE(SUM(qty),0) n FROM batches WHERE shelter_id=? AND id!=? AND status IN ${ACTIVE}`,sid,ex).n;
const freeQty=(s,ex)=>s.open?Math.max(0,s.demand-reservedQty(s.id,ex)):0;
const busy=id=>!!one(`SELECT 1 x FROM batches WHERE rider_id=? AND status IN ${ACTIVE}`,id);
const idleRiders=()=>q('SELECT * FROM riders WHERE online=1 AND responsive=1 AND lat IS NOT NULL').filter(r=>!busy(r.user_id));
const otp=()=>String(1000+crypto.randomInt(9000));
const bat=id=>one('SELECT * FROM batches WHERE id=?',id);

// 1-3: matching, splitting by rider capacity + shelter demand, single-assignment reservation (one SQLite transaction)
const dispatch=db.transaction(did=>{
 const d=one('SELECT * FROM donations WHERE id=?',did);if(!d||d.status==='Cancelled')return;
 let rem=d.rem;const shelters=q('SELECT * FROM shelters').sort((a,b)=>km(d,a)-km(d,b));
 for(const s of shelters){
  if(!s.open)continue;
  if(!compat(d.type,s)){ev(null,`Shelter ${s.name} blocked for ${d.type}: ${/ration/i.test(d.type)?'no cooking facility':'no clean water'}`,d.id);continue}
  while(rem>0&&freeQty(s)>0){
   let best=null;
   for(const r of idleRiders()){const t=mins(r,d)+mins(d,s);if(now()+t*60000<=d.deadline&&(!best||t<best.t))best={r,t}}
   if(!best)break;
   const qty=Math.min(best.r.cap,rem,freeQty(s));
   const i=run(`INSERT INTO batches(donation_id,qty,shelter_id,rider_id,status,deadline,eta,otp_pick,otp_drop,lat,lng,type,res_exp,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,d.id,qty,s.id,best.r.user_id,'Reserved',d.deadline,Math.round(best.t),otp(),otp(),d.lat,d.lng,d.type,now()+CFG.resMin*60000,now()).lastInsertRowid;
   rem-=qty;ev(i,`Batch #${i}: ${qty} ${d.type} -> ${s.name}, ETA ${Math.round(best.t)}m. Rider must confirm within ${CFG.resMin}m`,d.id);
  }}
 run('UPDATE donations SET rem=?,status=? WHERE id=?',rem,rem>0?'Pending':'Dispatched',d.id);
 if(rem>0)ev(null,`${rem} ${d.type} unallocated (demand, compatibility, capacity or riders). Will retry automatically.`,d.id);
});
// 5,7-9,11-12: recovery. Deadline is NEVER reset. Replacement must reach cargo + handover + deliver in time, else safety hold.
function recover(b,why,o={}){
 b=bat(b.id);const picked=['PickedUp','Handover'].includes(b.status),from={lat:b.lat,lng:b.lng};
 const old=one('SELECT * FROM riders WHERE user_id=?',b.rider_id);
 const cands=o.keep&&old&&old.online&&old.responsive?[old]:idleRiders().filter(r=>r.user_id!==b.rider_id);
 let best=null;
 for(const s of q('SELECT * FROM shelters')){
  if(s.id===o.excl||!s.open||freeQty(s,b.id)<b.qty||!compat(b.type,s))continue;
  for(const r of cands){const same=r.user_id===b.rider_id;
   const t=(same?(picked?0:mins(r,from)):mins(r,from)+(picked?CFG.handover:0))+mins(from,s,same?b.tf:1);
   if(now()+t*60000<=b.deadline&&(!best||t<best.t))best={s,r,t,same}}}
 if(best){const st=best.same?b.status:(picked?'Handover':'Reserved');
  run('UPDATE batches SET shelter_id=?,rider_id=?,status=?,eta=?,tf=?,res_exp=? WHERE id=?',best.s.id,best.r.user_id,st,Math.round(best.t),best.same?b.tf:1,st==='Reserved'||st==='Handover'?now()+CFG.resMin*60000:null,b.id);
  ev(b.id,`Batch #${b.id} recovered (${why}): rider ${best.r.user_id}, shelter ${best.s.name}, ETA ${Math.round(best.t)}m, ${Math.round((b.deadline-now())/60000)}m safe time left. Original deadline kept.`,b.donation_id);return true}
 run(`UPDATE batches SET status='SafetyHold' WHERE id=?`,b.id);
 ev(b.id,`SAFETY HOLD batch #${b.id} (${why}): no compatible rider/shelter can finish within ${Math.max(0,Math.round((b.deadline-now())/60000))}m. Admin review required.`,b.donation_id);return false}
const onShelterChange=sid=>{const s=one('SELECT * FROM shelters WHERE id=?',sid);
 q(`SELECT * FROM batches WHERE shelter_id=? AND status IN ${ACTIVE}`,sid).forEach(b=>{if(!s.open||freeQty(s,b.id)<b.qty)recover(b,s.open?'shelter demand changed':'shelter closed',{keep:1,excl:sid})})};
// 6,10,12 periodic safety loop
function tick(){
 run('UPDATE riders SET seen=? WHERE sim=1 AND responsive=1',now());
 q(`SELECT * FROM batches WHERE status IN ('Reserved','Handover') AND res_exp<?`,now()).forEach(b=>{ev(b.id,`Reservation for batch #${b.id} expired (no confirmation). Released.`,b.donation_id);recover(b,'reservation expired')});
 q(`SELECT b.* FROM batches b JOIN riders r ON r.user_id=b.rider_id WHERE b.status IN ('Accepted','PickedUp') AND (r.responsive=0 OR r.seen<?)`,now()-CFG.stallMin*60000).forEach(b=>recover(b,`rider unresponsive >${CFG.stallMin}m`));
 q(`SELECT * FROM batches WHERE status IN ('Accepted','PickedUp')`).forEach(b=>{const s=one('SELECT * FROM shelters WHERE id=?',b.shelter_id),t=mins({lat:b.lat,lng:b.lng},s,b.tf);
  if(now()+t*60000>b.deadline){ev(b.id,`ETA ${Math.round(t)}m exceeds remaining safe time for batch #${b.id}. Escalating immediately.`,b.donation_id);recover(b,'ETA infeasible',{keep:0})}});
 q(`SELECT * FROM batches WHERE status IN ${ACTIVE} AND deadline<?`,now()).forEach(b=>{run(`UPDATE batches SET status='SafetyHold' WHERE id=?`,b.id);ev(b.id,`Deadline passed for batch #${b.id}. Safety hold; late arrival is never marked safe.`,b.donation_id)});
 q(`SELECT id FROM donations WHERE status='Pending' AND deadline>?`,now()).forEach(d=>{if(idleRiders().length)dispatch(d.id)});
}
// completion (OTP verified at shelter). Partial delivery re-plans only unresolved quantity.
function complete(b,qty){
 if(now()>b.deadline){run(`UPDATE batches SET status='SafetyHold' WHERE id=?`,b.id);ev(b.id,`Arrival after deadline for batch #${b.id}: NOT accepted as safe. Safety hold.`,b.donation_id);throw new Error('Past safety deadline: batch placed on safety hold for admin review')}
 qty=Math.min(qty||b.qty,b.qty);
 if(qty<b.qty){run(`INSERT INTO batches(donation_id,qty,shelter_id,rider_id,status,deadline,eta,otp_pick,otp_drop,tf,lat,lng,type,created,delivered) SELECT donation_id,?,shelter_id,rider_id,'Delivered',deadline,eta,otp_pick,otp_drop,tf,lat,lng,type,created,? FROM batches WHERE id=?`,qty,now(),b.id);
  run('UPDATE batches SET qty=qty-? WHERE id=?',qty,b.id);ev(b.id,`Partial delivery: ${qty} delivered, ${b.qty-qty} unresolved re-planned.`,b.donation_id)}
 else run(`UPDATE batches SET status='Delivered',delivered=? WHERE id=?`,now(),b.id);
 run('UPDATE shelters SET demand=MAX(0,demand-?) WHERE id=?',qty,b.shelter_id);
 if(qty<b.qty)recover(bat(b.id),'partial delivery',{keep:1});
 else ev(b.id,`Batch #${b.id} delivered (${qty} ${b.type}), ${Math.round((b.deadline-now())/60000)}m before deadline.`,b.donation_id);
 const d=one('SELECT rem FROM donations WHERE id=?',b.donation_id);
 if(d.rem===0&&!one(`SELECT 1 x FROM batches WHERE donation_id=? AND status!='Delivered'`,b.donation_id))run(`UPDATE donations SET status='Delivered' WHERE id=?`,b.donation_id)}

// ---------- auth ----------
const hash=(p,s=crypto.randomBytes(8).toString('hex'))=>s+':'+crypto.scryptSync(p,s,32).toString('hex');
const verify=(p,h)=>{const a=Buffer.from(hash(p,h.split(':')[0])),b=Buffer.from(h);return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const mac=b=>crypto.createHmac('sha256',SECRET).update(b).digest('base64url');
const sign=u=>{const b=Buffer.from(JSON.stringify({id:u.id,exp:now()+864e5})).toString('base64url');return b+'.'+mac(b)};
const parse=t=>{try{const[b,s]=t.split('.');if(s!==mac(b))return;const p=JSON.parse(Buffer.from(b,'base64url'));if(p.exp<now())return;return one('SELECT * FROM users WHERE id=?',p.id)}catch{}};
const auth=(...roles)=>(req,res,next)=>{const u=parse((req.headers.authorization||'').replace('Bearer ','')||req.query.t||'');
 if(!u)return res.status(401).json({error:'Login required'});if(!u.approved)return res.status(403).json({error:'Account awaiting admin approval'});
 if(u.role!=='admin')return res.status(403).json({error:'Route2Root is configured for single-admin console access'});
 if(roles.length&&!roles.includes(u.role))return res.status(403).json({error:'Forbidden for your role'});req.user=u;next()};
const clients=new Set(),bcast=()=>clients.forEach(c=>c.write('data: u\n\n'));
const h=f=>(req,res)=>{try{const r=f(req,res);res.json(r===undefined?{ok:true}:r)}catch(e){res.status(400).json({error:e.message})}};
const mut=f=>h(r=>{const x=f(r);bcast();return x});
const app=express();app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
const num=(v,m,x,n)=>{v=+v;need(Number.isFinite(v)&&v>=m&&v<=x,n+` must be ${m}-${x}`);return v};

app.post('/api/register',h(({body:b})=>{
 need(/^\S+@\S+\.\S+$/.test(b.email||''),'Valid email required');need((b.password||'').length>=8,'Password min 8 chars');need((b.name||'').trim(),'Name required');
 need(['donor','rider','shelter'].includes(b.role),'Invalid role');need(!one('SELECT 1 x FROM users WHERE email=?',b.email),'Email already registered');
 const u=run('INSERT INTO users(email,name,pass,role,approved) VALUES(?,?,?,?,0)',b.email,b.name.trim(),hash(b.password),b.role).lastInsertRowid;
 if(b.role==='rider')run('INSERT INTO riders(user_id,cap,vehicle,seen) VALUES(?,?,?,?)',u,num(b.cap||40,1,200,'Capacity'),b.vehicle||'Two-wheeler',now());
 if(b.role==='shelter')run('INSERT INTO shelters(user_id,name,lat,lng,demand,cook,water) VALUES(?,?,?,?,?,?,?)',u,b.name.trim(),num(b.lat,-90,90,'Lat'),num(b.lng,-180,180,'Lng'),num(b.demand||0,0,5000,'Demand'),b.cook?1:0,b.water===false?0:1);
 return{message:'Registered. An admin must approve your account before you can log in.'}}));
app.post('/api/login',h(({body:b})=>{const u=one('SELECT * FROM users WHERE email=?',b.email||'');
 need(u&&u.role==='admin'&&verify(b.password||'',u.pass),'Invalid admin email or password');need(u.approved,'Account awaiting admin approval');return{token:sign(u)}}));
app.get('/api/stream',auth(),(req,res)=>{res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.flushHeaders();clients.add(res);req.on('close',()=>clients.delete(res))});

app.get('/api/state',auth(),h(({user:u})=>{
 const A=u.role==='admin',sh=q('SELECT * FROM shelters').map(s=>({...s,reserved:reservedQty(s.id)}));
 const mine=q('SELECT id FROM shelters WHERE user_id=?',u.id).map(s=>s.id);
 const B=`SELECT b.*,s.name shelter,ru.name rider,d.address,d.donor_id,du.name donor FROM batches b JOIN shelters s ON s.id=b.shelter_id LEFT JOIN users ru ON ru.id=b.rider_id JOIN donations d ON d.id=b.donation_id JOIN users du ON du.id=d.donor_id`;
 let batches=q(B+' ORDER BY b.id DESC');
 if(u.role==='donor')batches=batches.filter(b=>b.donor_id===u.id);if(u.role==='rider')batches=batches.filter(b=>b.rider_id===u.id);if(u.role==='shelter')batches=batches.filter(b=>mine.includes(b.shelter_id));
 batches=batches.map(b=>({...b,otp_pick:A||u.role==='donor'?b.otp_pick:undefined,otp_drop:A||u.role==='shelter'?b.otp_drop:undefined}));
 const donations=q('SELECT d.*,u.name donor FROM donations d JOIN users u ON u.id=d.donor_id ORDER BY d.id DESC').filter(d=>A||(u.role==='donor'&&d.donor_id===u.id)||(u.role==='rider'||u.role==='shelter')&&batches.some(b=>b.donation_id===d.id));
 const ids=batches.map(b=>b.id),dids=donations.map(d=>d.id);
 let events=q('SELECT * FROM events ORDER BY id DESC LIMIT 200');if(!A)events=events.filter(e=>ids.includes(e.batch_id)||(u.role==='donor'&&dids.includes(e.donation_id)));
 const riders=q('SELECT r.*,u.name FROM riders r JOIN users u ON u.id=r.user_id').filter(r=>A||r.user_id===u.id);
 return{me:{id:u.id,name:u.name,role:u.role},now:now(),cfg:CFG,shelters:sh,riders,donations,batches,events:events.slice(0,60),
  pending:A?q('SELECT id,email,name,role FROM users WHERE approved=0'):[]}}));

app.post('/api/donations',auth('donor','admin'),mut(({user:u,body:b})=>{
 const qty=num(b.qty,1,5000,'Quantity'),win=num(b.win,5,10080,'Safety window (min)');need(['Cooked meals','Ration kits','Medical supplies','Infant formula'].includes(b.type),'Unknown category');
 need((b.address||'').trim(),'Pickup address required');const lat=num(b.lat,-90,90,'Lat'),lng=num(b.lng,-180,180,'Lng');
 const donorUserId=u.role==='admin'?one("SELECT id FROM users WHERE role='donor' ORDER BY id LIMIT 1")?.id:u.id;need(donorUserId,'Create a donor account first');const id=run('INSERT INTO donations(donor_id,type,qty,rem,win,deadline,status,lat,lng,address,storage,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',donorUserId,b.type,qty,qty,win,now()+win*60000,'Available',lat,lng,b.address.trim(),b.storage||'',now()).lastInsertRowid;
 ev(null,`Donation #${id} listed: ${qty} ${b.type}, safety window ${win}m (conservative: counted from listing until pickup is verified).`,id);
 if(b.dispatch)dispatch(id);return{id}}));
const ownDon=(u,id)=>{const d=one('SELECT * FROM donations WHERE id=?',id);need(d&&(u.role==='admin'||d.donor_id===u.id),'Not found');return d};
app.post('/api/donations/:id/dispatch',auth('donor','admin'),mut(({user:u,params:p})=>{const d=ownDon(u,p.id);need(['Available','Pending'].includes(d.status),'Already dispatched');dispatch(d.id)}));
app.delete('/api/donations/:id',auth('donor','admin'),mut(({user:u,params:p})=>{const d=ownDon(u,p.id);
 need(!one(`SELECT 1 x FROM batches WHERE donation_id=? AND status IN ('PickedUp','Handover','Delivered')`,d.id),'Cannot cancel after pickup');
 run(`UPDATE batches SET status='Cancelled' WHERE donation_id=? AND status IN ('Reserved','Accepted')`,d.id);run(`UPDATE donations SET status='Cancelled' WHERE id=?`,d.id);ev(null,`Donation #${d.id} cancelled by donor.`,d.id)}));

app.post('/api/batches/:id/:action',auth('rider','shelter','admin'),mut(({user:u,params:p,body:b})=>{
 const bt=bat(p.id);need(bt,'Batch not found');const sh=one('SELECT * FROM shelters WHERE id=?',bt.shelter_id);
 if(u.role==='rider')need(bt.rider_id===u.id,'Not your batch');if(u.role==='shelter')need(sh.user_id===u.id,'Not your shelter');
 const A=p.action,live=['Reserved','Accepted','PickedUp','Handover'].includes(bt.status);need(live||A==='x','Batch is '+bt.status);
 if(u.role==='rider'||u.role==='admin'){
  if(A==='accept'){need(['Reserved','Handover'].includes(bt.status),'Nothing to accept');need(now()<=bt.res_exp,'Reservation expired');
   run('UPDATE batches SET status=?,res_exp=NULL WHERE id=?',bt.status==='Handover'?'PickedUp':'Accepted',bt.id);ev(bt.id,`Rider accepted batch #${bt.id}.`,bt.donation_id);return}
  if(A==='reject'){ev(bt.id,`Rider rejected batch #${bt.id}.`,bt.donation_id);recover(bt,'rider rejected');return}
  if(A==='pickup'){need(bt.status==='Accepted','Accept the batch first');need(now()<=bt.deadline,'Past deadline');need(String(b.otp)===bt.otp_pick,'Wrong pickup OTP');
   const r=one('SELECT * FROM riders WHERE user_id=?',bt.rider_id);run(`UPDATE batches SET status='PickedUp',lat=?,lng=? WHERE id=?`,r.lat,r.lng,bt.id);ev(bt.id,`Pickup verified (OTP) for batch #${bt.id}. Deadline unchanged: ${new Date(bt.deadline).toLocaleTimeString()}.`,bt.donation_id);return}
  if(A==='deliver'){need(bt.status==='PickedUp','Batch not in transit');need(String(b.otp)===bt.otp_drop,'Wrong delivery OTP (ask the shelter)');complete(bt,b.qty?num(b.qty,1,bt.qty,'Quantity'):bt.qty);return}
  if(A==='report'){need(['traffic','breakdown','emergency'].includes(b.kind),'Bad report');
   if(b.kind==='traffic'){run('UPDATE batches SET tf=tf*1.6 WHERE id=?',bt.id);ev(bt.id,`Rider reported traffic on batch #${bt.id}.`,bt.donation_id);tick()}
   else{run('UPDATE riders SET online=0 WHERE user_id=?',bt.rider_id);ev(bt.id,`Rider reported ${b.kind} on batch #${bt.id}.`,bt.donation_id);recover(bt,'rider reported '+b.kind)}return}}
 if(A==='srej'){ev(bt.id,`Shelter ${sh.name} rejected batch #${bt.id}: ${b.reason||'no reason'}.`,bt.donation_id);recover(bt,'rejected by shelter',{keep:1,excl:sh.id});return}
 throw new Error('Action not allowed')}));
app.patch('/api/shelters/:id',auth('shelter','admin'),mut(({user:u,params:p,body:b})=>{const s=one('SELECT * FROM shelters WHERE id=?',p.id);need(s&&(u.role==='admin'||s.user_id===u.id),'Not found');
 run('UPDATE shelters SET demand=?,open=?,cook=?,water=? WHERE id=?',b.demand!==undefined?num(b.demand,0,5000,'Demand'):s.demand,b.open!==undefined?+!!b.open:s.open,b.cook!==undefined?+!!b.cook:s.cook,b.water!==undefined?+!!b.water:s.water,s.id);
 ev(null,`Shelter ${s.name} updated (demand ${b.demand??s.demand}, ${(b.open??s.open)?'open':'closed'}).`);onShelterChange(s.id)}));
app.post('/api/rider',auth('rider'),mut(({user:u,body:b})=>{
 if(b.lat!==undefined){const lat=num(b.lat,-90,90,'Lat'),lng=num(b.lng,-180,180,'Lng');run('UPDATE riders SET lat=?,lng=?,seen=? WHERE user_id=?',lat,lng,now(),u.id);run(`UPDATE batches SET lat=?,lng=? WHERE rider_id=? AND status='PickedUp'`,lat,lng,u.id)}
 if(b.online!==undefined)run('UPDATE riders SET online=?,seen=? WHERE user_id=?',+!!b.online,now(),u.id);run('UPDATE riders SET seen=? WHERE user_id=?',now(),u.id)}));

// ---------- admin ----------
app.patch('/api/admin/riders/:id/status',auth('admin'),mut(({params:p,body:b})=>{
 const r=one('SELECT * FROM riders WHERE user_id=?',p.id);need(r,'Rider not found');
 const online=b.online===undefined?r.online:+!!b.online;
 const responsive=b.responsive===undefined?r.responsive:+!!b.responsive;
 run('UPDATE riders SET online=?,responsive=?,seen=? WHERE user_id=?',online,responsive,(responsive&&online)?now():r.seen,r.user_id);
 if(!online||!responsive){
  q(`SELECT * FROM batches WHERE rider_id=? AND status IN ('Reserved','Accepted','PickedUp','Handover')`,r.user_id).forEach(bt=>recover(bt,!online?'rider set offline by admin':'rider marked unresponsive by admin'));
  ev(null,`Rider ${r.user_id} status changed: ${online?'online':'offline'}, ${responsive?'responsive':'unresponsive'}. Recovery checks triggered.`);
 } else ev(null,`Rider ${r.user_id} is online and responsive again.`);
 return {ok:true};
}));
app.post('/api/admin/approve/:id',auth('admin'),mut(({params:p})=>{run('UPDATE users SET approved=1 WHERE id=?',p.id)}));
app.post('/api/admin/batches/:id/resolve',auth('admin'),mut(({params:p,body:b})=>{const bt=bat(p.id);need(bt&&bt.status==='SafetyHold','Not on safety hold');
 run(`UPDATE batches SET status='Discarded' WHERE id=?`,bt.id);ev(bt.id,`Admin closed safety hold on batch #${bt.id}: ${b.note||'disposed per handling procedure'}.`,bt.donation_id)}));
const donorId=()=>one(`SELECT id FROM users WHERE role='donor' ORDER BY id`).id;
const firstActive=st=>one(`SELECT * FROM batches WHERE status IN ${st||ACTIVE} ORDER BY id`);
const mk=(type,qty,win)=>{const id=run('INSERT INTO donations(donor_id,type,qty,rem,win,deadline,status,lat,lng,address,storage,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',donorId(),type,qty,qty,win,now()+win*60000,'Available',18.5362,73.8938,'Sunrise Restaurant, Koregaon Park, Pune','',now()).lastInsertRowid;dispatch(id);return id};
const SIMS={
 demo180:()=>mk('Cooked meals',180,75),
 unconfirmed:()=>{const b=firstActive("('Reserved')");need(b,'No reserved batch');run('UPDATE batches SET res_exp=? WHERE id=?',now()-1,b.id);tick()},
 unresponsive:()=>{const b=firstActive("('Accepted','PickedUp')");need(b,'Accept a batch first (use "Auto-accept" sim)');run('UPDATE riders SET responsive=0,seen=0 WHERE user_id=?',b.rider_id);tick()},
 autoaccept:()=>q(`SELECT * FROM batches WHERE status='Reserved'`).forEach(b=>run(`UPDATE batches SET status='Accepted',res_exp=NULL WHERE id=?`,b.id)),
 eta80:()=>{const b=firstActive("('Accepted','PickedUp')");need(b,'Accept a batch first');const s=one('SELECT * FROM shelters WHERE id=?',b.shelter_id);
  run('UPDATE batches SET tf=?,eta=80 WHERE id=?',80/Math.max(1,mins({lat:b.lat,lng:b.lng},s)),b.id);tick()},
 shelterzero:()=>{const s=one('SELECT * FROM shelters ORDER BY id');run('UPDATE shelters SET demand=0 WHERE id=?',s.id);onShelterChange(s.id)},
 shelterclose:()=>{const b=firstActive();need(b,'No active batch');run('UPDATE shelters SET open=0 WHERE id=?',b.shelter_id);onShelterChange(b.shelter_id)},
 breakdown:()=>{const b=firstActive("('PickedUp','Accepted')");need(b,'Accept a batch first');run('UPDATE riders SET online=0 WHERE user_id=?',b.rider_id);recover(b,'rider breakdown')},
 partial:()=>{const b=firstActive("('PickedUp')");need(b,'No batch in transit: pick up first');complete(b,Math.min(20,b.qty-1))},
 norider:()=>{run('UPDATE riders SET online=0');mk('Cooked meals',60,75)},
 ration:()=>mk('Ration kits',50,360),
 deadline:()=>{const b=firstActive();need(b,'No active batch');run('UPDATE batches SET deadline=? WHERE id=?',now()-1000,b.id);tick()},
 reset:()=>{['batches','donations','events'].forEach(t=>run('DELETE FROM '+t));run('UPDATE riders SET online=1,responsive=1,seen=?',now());seedShelters()}};
app.post('/api/admin/sim/:name',auth('admin'),mut(({params:p})=>{need(SIMS[p.name],'Unknown scenario');SIM=1;try{SIMS[p.name]()}finally{SIM=0}}));

// ---------- seed (sample data; riders marked sim=1 have SIMULATED positions) ----------
function seedShelters(){[['Shivajinagar Night Shelter',18.5308,73.8475,50,1,1],['Hadapsar Relief Camp',18.5089,73.9259,80,0,1],['Kothrud Care Home',18.5074,73.8077,60,1,1]].forEach((s,i)=>run('UPDATE shelters SET demand=?,open=1,cook=?,water=? WHERE id=?',s[3],s[4],s[5],i+1))}
if(!one('SELECT 1 x FROM users')){
 const add=(e,n,r)=>run('INSERT INTO users(email,name,pass,role,approved) VALUES(?,?,?,?,1)',e,n,hash('demo1234'),r).lastInsertRowid;
 add('admin@demo.in','Admin','admin');add('donor@demo.in','Sunrise Restaurant','donor');
 [[18.5204,73.8567],[18.5314,73.8446],[18.5018,73.9078],[18.5590,73.8070]].forEach((p,i)=>{const id=add(`rider${i+1}@demo.in`,'Rider '+(i+1),'rider');run('INSERT INTO riders(user_id,cap,lat,lng,seen,sim,vehicle) VALUES(?,?,?,?,?,1,?)',id,40,p[0],p[1],now(),'Two-wheeler')});
 [['Shivajinagar Night Shelter',18.5308,73.8475,50,1,1],['Hadapsar Relief Camp',18.5089,73.9259,80,0,1],['Kothrud Care Home',18.5074,73.8077,60,1,1]].forEach((s,i)=>run('INSERT INTO shelters(user_id,name,lat,lng,demand,cook,water) VALUES(?,?,?,?,?,?,?)',add(`shelter${'abc'[i]}@demo.in`,s[0],'shelter'),...s.slice(0,3),s[3],s[4],s[5]));
 // Seed realistic demo orders so the admin dashboard is populated on first launch.
 const demoDonor=one("SELECT id FROM users WHERE email='donor@demo.in'").id;
 [['Cooked meals',180,75,18.5362,73.8938,'Sunrise Restaurant, Koregaon Park, Pune','Sealed meal boxes'],['Ration kits',45,360,18.5270,73.8560,'Community Store, Shivajinagar, Pune','Dry ration kits'],['Medical supplies',24,720,18.5204,73.8567,'City Pharmacy, Pune','Sealed essential kits']].forEach(x=>{const id=run('INSERT INTO donations(donor_id,type,qty,rem,win,deadline,status,lat,lng,address,storage,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',demoDonor,x[0],x[1],x[1],x[2],now()+x[2]*60000,'Available',x[3],x[4],x[5],x[6],now()).lastInsertRowid;dispatch(id)});
 console.log('Seeded admin demo account (password demo1234): admin@demo.in; demo donor/rider/shelter records and initial orders created')}
setInterval(()=>{try{tick();bcast()}catch(e){console.error(e)}},20000);
app.listen(PORT,()=>console.log('Route2Root running on http://localhost:'+PORT));
