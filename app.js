'use strict';
const CLIENT_ID='805509803185-3q3mv8h0fuengvkugdocff1fipl82jel.apps.googleusercontent.com';
const EMAIL='nguyenhoanghieutrung0510200398@gmail.com';
const SCOPE='https://www.googleapis.com/auth/drive.appdata';
const KEY='nhip-hoc-v1',FILE='nhip-hoc.json',DAY=864e5,SUBJECTS=['Nội trú','Tiếng Anh','Khác'];
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day=(t=Date.now())=>new Date(t).toLocaleDateString('en-CA');
const fmt=s=>String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');

let db;try{db=JSON.parse(localStorage.getItem(KEY))||{records:[]}}catch{db={records:[]}}
let tab='tasks',token='',tokenExp=0,tc,syncTimer,rev=null;
const tm={min:25,left:1500,run:false,end:0,id:0};

/* ---------- Dữ liệu cục bộ ---------- */
const list=k=>db.records.filter(r=>r.kind===k&&!r.deleted);
const save=()=>{localStorage.setItem(KEY,JSON.stringify(db));schedule()};
function put(kind,data,id){
  const r=id&&db.records.find(x=>x.id===id);
  if(r){Object.assign(r.data,data);r.updatedAt=Date.now()}
  else db.records.push({id:crypto.randomUUID(),kind,data,updatedAt:Date.now(),deleted:false});
  save();render();
}
function del(id){const r=db.records.find(x=>x.id===id);if(r){r.deleted=true;r.updatedAt=Date.now();save();render()}}
function merge(remote){
  for(const r of remote){
    const l=db.records.find(x=>x.id===r.id);
    if(!l)db.records.push(r);else if(r.updatedAt>l.updatedAt)Object.assign(l,r);
  }
  localStorage.setItem(KEY,JSON.stringify(db));
}

/* ---------- Lịch ôn thẻ (SRS, lấy từ lib/flashcards.ts) ---------- */
function srs(d,g){
  const now=Date.now(),p=d.interval||0,e=Math.max(1.3,d.ease||2.5);let i=0,due=now,ne=e;
  if(g==='again'){due=now+6e4;ne=Math.max(1.3,e-.2)}
  else if(g==='hard'){i=p?Math.max(1,Math.round(p*1.2)):0;due=i?now+i*DAY:now+6e5;ne=Math.max(1.3,e-.15)}
  else if(g==='good'){i=p?Math.max(p+1,Math.round(p*e)):1;due=now+i*DAY}
  else{i=p?Math.max(p+1,Math.round(p*e*1.3)):4;due=now+i*DAY;ne=e+.15}
  return{interval:i,dueAt:due,ease:Math.round(ne*100)/100,reviews:(d.reviews||0)+1,lastGrade:g};
}
const dueCards=()=>list('card').filter(c=>!c.data.dueAt||c.data.dueAt<=Date.now());

/* ---------- Giao diện ---------- */
const opts=(a,sel)=>a.map(([v,t])=>`<option value="${esc(v)}"${v===sel?' selected':''}>${esc(t)}</option>`).join('');
const subjOpts=()=>opts(SUBJECTS.map(s=>[s,s]));

function vTasks(){
  const gs=list('goal'),ts=list('task').sort((a,b)=>(a.data.done-b.data.done)||String(a.data.date).localeCompare(String(b.data.date)));
  const prog=g=>{const l=ts.filter(t=>t.data.goalId===g.id);return l.length?Math.round(100*l.filter(t=>t.data.done).length/l.length):0};
  const gname=id=>gs.find(g=>g.id===id)?.data.title||'';
  return `<h2>Mục tiêu</h2>
  <form data-form="goal" class="row"><input name="title" placeholder="Ví dụ: Xong chuyên đề Tim mạch" required aria-label="Tên mục tiêu"><select name="subject" aria-label="Môn">${subjOpts()}</select><input type="date" name="due" aria-label="Hạn hoàn thành"><button>Thêm mục tiêu</button></form>
  <ul class="list">${gs.map(g=>`<li><div><b>${esc(g.data.title)}</b><small>${esc(g.data.subject)}${g.data.due?', hạn '+esc(g.data.due):''}</small><div class="bar"><i style="width:${prog(g)}%"></i></div></div><span>${prog(g)}%</span><button class="x" data-act="del" data-id="${g.id}">Xóa</button></li>`).join('')||'<li class="empty">Chưa có mục tiêu. Thêm mục tiêu đầu tiên ở trên.</li>'}</ul>
  <h2>Việc cần làm</h2>
  <form data-form="task" class="row"><input name="title" placeholder="Ví dụ: Làm 30 câu trắc nghiệm" required aria-label="Tên việc"><select name="goalId" aria-label="Mục tiêu"><option value="">Không gắn mục tiêu</option>${opts(gs.map(g=>[g.id,g.data.title]))}</select><input type="date" name="date" value="${day()}" aria-label="Ngày làm"><button>Thêm việc</button></form>
  <ul class="list">${ts.map(t=>`<li class="${t.data.done?'done':''}"><input type="checkbox" data-act="done" data-id="${t.id}" ${t.data.done?'checked':''} aria-label="Hoàn thành"><div><b>${esc(t.data.title)}</b><small>${esc(t.data.date||'')} ${esc(gname(t.data.goalId))}</small></div><button class="x" data-act="del" data-id="${t.id}">Xóa</button></li>`).join('')||'<li class="empty">Chưa có việc nào.</li>'}</ul>`;
}

function vCards(){
  if(rev){
    const c=db.records.find(x=>x.id===rev.q[rev.i]);
    if(!c)return `<h2>Hoàn thành lượt ôn</h2><p>Bạn đã ôn ${rev.q.length} thẻ.</p><button class="p" data-act="stop">Quay lại</button>`;
    return `<h2>Ôn thẻ ${rev.i+1}/${rev.q.length}</h2><div class="face">${esc(c.data.front)}${rev.show?'<hr>'+esc(c.data.answer):''}</div>`+
      (rev.show?`<div class="grades">${[['again','Quên'],['hard','Khó'],['good','Tốt'],['easy','Dễ']].map(([g,t])=>`<button data-act="grade" data-g="${g}">${t}</button>`).join('')}</div>`:`<button class="p" data-act="show">Hiện đáp án</button>`)+
      ` <button class="x" data-act="stop">Dừng</button>`;
  }
  const cs=list('card'),due=dueCards().length;
  return `<h2>Thẻ ghi nhớ</h2><p>${due?`<span class="due">${due} thẻ cần ôn</span>`:'<span class="mute">Không có thẻ nào đến hạn.</span>'} Tổng: ${cs.length} thẻ.</p>
  ${due?'<button class="p" data-act="review">Bắt đầu ôn</button>':''}
  <h2>Thêm thẻ</h2>
  <form data-form="card"><textarea name="front" placeholder="Mặt trước (câu hỏi)" required aria-label="Mặt trước"></textarea><textarea name="answer" placeholder="Mặt sau (đáp án)" required aria-label="Mặt sau"></textarea><div class="row"><select name="subject" aria-label="Môn">${subjOpts()}</select><button>Thêm thẻ</button></div></form>
  <ul class="list">${cs.map(c=>`<li><div><b>${esc(c.data.front.slice(0,90))}</b><small>${esc(c.data.subject)}, ${c.data.dueAt?'ôn lại '+day(c.data.dueAt):'thẻ mới'}</small></div><button class="x" data-act="del" data-id="${c.id}">Xóa</button></li>`).join('')}</ul>`;
}

function vFocus(){
  const mins=list('session').filter(s=>day(s.data.at)===day()).reduce((n,s)=>n+s.data.minutes,0);
  return `<h2>Phiên tập trung</h2><div id="clock" role="timer">${fmt(tm.left)}</div>
  <div class="row"><input type="number" id="min" min="1" max="180" value="${tm.min}" ${tm.run?'disabled':''} aria-label="Số phút"><button class="p" data-act="${tm.run?'pause':'start'}">${tm.run?'Tạm dừng':'Bắt đầu'}</button><button data-act="reset">Đặt lại</button></div>
  <p class="mute">Hôm nay bạn đã tập trung ${mins} phút.</p>`;
}

function vSettings(){
  return `<h2>Đồng bộ Google Drive</h2>
  <p>Tài khoản: <b>${esc(EMAIL)}</b>. Dữ liệu lưu trong thư mục ẩn của ứng dụng trên Drive, chỉ Nhịp Học đọc được.</p>
  <button class="p" data-act="sync">Kết nối và đồng bộ ngay</button>
  <h2>Sao lưu</h2>
  <div class="row"><button data-act="export">Xuất JSON</button><button data-act="import">Nhập JSON</button></div>`;
}

function render(){
  document.querySelectorAll('#nav button').forEach(b=>b.toggleAttribute('aria-current',b.dataset.tab===tab)||b.removeAttribute('aria-current'));
  document.querySelectorAll('#nav button').forEach(b=>b.dataset.tab===tab?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current'));
  $('#view').innerHTML={tasks:vTasks,cards:vCards,focus:vFocus,settings:vSettings}[tab]();
}

/* ---------- Đồng hồ tập trung ---------- */
function tick(){
  if(!tm.run)return;
  tm.left=Math.max(0,Math.round((tm.end-Date.now())/1e3));
  const el=$('#clock');if(el)el.textContent=fmt(tm.left);
  if(!tm.left){
    tm.run=false;clearInterval(tm.id);
    try{new Notification('Nhịp Học',{body:'Hết phiên tập trung. Nghỉ một chút nhé.'})}catch{}
    put('session',{minutes:tm.min,at:Date.now()});tm.left=tm.min*60;
  }
}

/* ---------- Google Drive ---------- */
const setStatus=t=>{$('#sync').textContent=t};
function auth(){
  return new Promise((ok,no)=>{
    if(token&&Date.now()<tokenExp)return ok(token);
    if(!window.google?.accounts)return no(Error('Chưa tải được Google. Kiểm tra mạng và mở trang qua http(s).'));
    tc??=google.accounts.oauth2.initTokenClient({client_id:CLIENT_ID,scope:SCOPE,login_hint:EMAIL,
      callback:r=>{if(r.error)return tc.rej(Error(r.error));token=r.access_token;tokenExp=Date.now()+(r.expires_in-60)*1e3;tc.res(token)},
      error_callback:e=>tc.rej(Error(e.message||e.type))});
    tc.res=ok;tc.rej=no;tc.requestAccessToken({prompt:''});
  });
}
async function g(url,opt={}){
  const r=await fetch(url,{...opt,headers:{Authorization:'Bearer '+await auth(),...opt.headers}});
  if(!r.ok)throw Error('Drive trả lỗi '+r.status+(r.status===403?'. Bật Google Drive API và thêm địa chỉ trang vào Authorized JavaScript origins.':''));
  return r;
}
async function sync(){
  clearTimeout(syncTimer);setStatus('Đang đồng bộ…');
  try{
    const api='https://www.googleapis.com/';
    const q=encodeURIComponent(`name='${FILE}'`);
    const f=(await(await g(`${api}drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json()).files[0];
    if(f)merge((await(await g(`${api}drive/v3/files/${f.id}?alt=media`)).json()).records||[]);
    const data=JSON.stringify({app:'nhip-hoc',version:1,records:db.records});
    if(f)await g(`${api}upload/drive/v3/files/${f.id}?uploadType=media`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:data});
    else{
      const b='nhip',meta=JSON.stringify({name:FILE,parents:['appDataFolder']});
      await g(`${api}upload/drive/v3/files?uploadType=multipart`,{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+b},
        body:`--${b}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${data}\r\n--${b}--`});
    }
    localStorage.setItem(KEY+':drive','1');setStatus('Đã đồng bộ '+new Date().toLocaleTimeString('vi-VN'));render();
  }catch(e){setStatus('Lỗi đồng bộ: '+e.message)}
}
function schedule(){
  clearTimeout(syncTimer);
  if(token&&Date.now()<tokenExp)syncTimer=setTimeout(sync,3000);
  else if(localStorage.getItem(KEY+':drive'))setStatus('Có thay đổi chưa đồng bộ. Vào Cài đặt để đồng bộ.');
}

/* ---------- Sự kiện ---------- */
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');if(!b)return;
  const a=b.dataset.act,id=b.dataset.id;
  if(a==='tab'){tab=b.dataset.tab;rev=null;render()}
  else if(a==='done')put('task',{done:b.checked},id);
  else if(a==='del'){if(confirm('Xóa mục này?'))del(id)}
  else if(a==='review'){rev={q:dueCards().map(c=>c.id),i:0,show:false};render()}
  else if(a==='show'){rev.show=true;render()}
  else if(a==='stop'){rev=null;render()}
  else if(a==='grade'){const c=db.records.find(x=>x.id===rev.q[rev.i]);rev.i++;rev.show=false;put('card',srs(c.data,b.dataset.g),c.id)}
  else if(a==='start'){tm.min=Math.max(1,Math.min(180,+$('#min').value||25));if(!tm.run&&tm.left===1500||tm.left>tm.min*60||tm.left===0)tm.left=tm.min*60;
    tm.end=Date.now()+tm.left*1e3;tm.run=true;tm.id=setInterval(tick,500);try{Notification.requestPermission()}catch{}render()}
  else if(a==='pause'){tick();tm.run=false;clearInterval(tm.id);render()}
  else if(a==='reset'){tm.run=false;clearInterval(tm.id);tm.min=Math.max(1,+($('#min')?.value)||tm.min);tm.left=tm.min*60;render()}
  else if(a==='sync')sync();
  else if(a==='export'){
    const u=URL.createObjectURL(new Blob([JSON.stringify({app:'nhip-hoc',version:1,records:db.records})],{type:'application/json'}));
    Object.assign(document.createElement('a'),{href:u,download:`nhip-hoc-${day()}.json`}).click();setTimeout(()=>URL.revokeObjectURL(u),5e3);
  }
  else if(a==='import')$('#imp').click();
});
document.addEventListener('submit',e=>{
  const f=e.target.closest('[data-form]');if(!f)return;e.preventDefault();
  const d=Object.fromEntries(new FormData(f));
  if(f.dataset.form==='task')d.done=false;
  put(f.dataset.form,d);
});
$('#imp').addEventListener('change',async e=>{
  try{const j=JSON.parse(await e.target.files[0].text());if(j.app!=='nhip-hoc'||!Array.isArray(j.records))throw 0;merge(j.records);render();setStatus('Đã nhập bản sao lưu')}
  catch{alert('Tệp không phải bản sao lưu Nhịp Học.')}
  e.target.value='';
});
setStatus(localStorage.getItem(KEY+':drive')?'Drive đã kết nối. Vào Cài đặt để đồng bộ.':'Chưa kết nối Google Drive');
render();
