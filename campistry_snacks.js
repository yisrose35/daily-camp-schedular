// =============================================================================
// campistry_snacks.js — Campistry Snacks Manager Dashboard Logic
// Handles: Accounts, Deposits, Inventory, Restock, Limits, Analytics
// =============================================================================

(function(){
'use strict';
const C=[
{id:1,name:'Ethan Goldberg',div:'Senior',bunk:'Bunk 18',bal:45,limit:10,spent:3.5},
{id:2,name:'Maya Rosenberg',div:'Senior',bunk:'Bunk 19',bal:32.5,limit:8,spent:8},
{id:3,name:'Jake Cohen',div:'Junior',bunk:'Bunk 7',bal:60,limit:12,spent:0},
{id:4,name:'Lily Schwartz',div:'Junior',bunk:'Bunk 8',bal:5.25,limit:8,spent:6.5},
{id:5,name:'Noah Friedman',div:'Middler',bunk:'Bunk 12',bal:28,limit:10,spent:2},
{id:6,name:'Ava Klein',div:'Middler',bunk:'Bunk 13',bal:0,limit:8,spent:0},
{id:7,name:'Sam Levine',div:'Senior',bunk:'Bunk 20',bal:15.75,limit:10,spent:4.5},
{id:8,name:'Zoe Katz',div:'Junior',bunk:'Bunk 9',bal:42,limit:10,spent:1.5},
{id:9,name:'Ben Rosen',div:'Senior',bunk:'Bunk 21',bal:20,limit:10,spent:0},
{id:10,name:'Sophie Weiss',div:'Middler',bunk:'Bunk 14',bal:35,limit:10,spent:5}
];
const I=[
{id:1,name:'Water Bottle',cat:'drink',emoji:'💧',price:1.5,stock:120,sold:18,total:312},
{id:2,name:'Gatorade',cat:'drink',emoji:'🥤',price:2.5,stock:64,sold:12,total:248},
{id:3,name:'Chips',cat:'snack',emoji:'🍿',price:2,stock:45,sold:22,total:445},
{id:4,name:'Granola Bar',cat:'snack',emoji:'🥜',price:1.75,stock:80,sold:8,total:89},
{id:5,name:'Ice Pop',cat:'treat',emoji:'🧊',price:1,stock:200,sold:35,total:780},
{id:6,name:'Candy Bar',cat:'treat',emoji:'🍫',price:2,stock:8,sold:14,total:220},
{id:7,name:'Pretzel',cat:'snack',emoji:'🥨',price:1.5,stock:55,sold:10,total:155},
{id:8,name:'Juice Box',cat:'drink',emoji:'🧃',price:1.75,stock:0,sold:30,total:410},
{id:9,name:'Cookie',cat:'treat',emoji:'🍪',price:1.5,stock:32,sold:16,total:290},
{id:10,name:'Fruit Cup',cat:'snack',emoji:'🍇',price:3,stock:40,sold:5,total:62}
];
const TX=[
{time:'2:45 PM',camper:'Ethan Goldberg',items:'Ice Pop, Water Bottle',amount:2.5},
{time:'2:38 PM',camper:'Maya Rosenberg',items:'Gatorade, Chips',amount:4.5},
{time:'2:30 PM',camper:'Sam Levine',items:'Candy Bar, Cookie',amount:3.5},
{time:'2:22 PM',camper:'Zoe Katz',items:'Water Bottle',amount:1.5},
{time:'2:15 PM',camper:'Noah Friedman',items:'Chips',amount:2},
{time:'1:50 PM',camper:'Lily Schwartz',items:'Ice Pop ×2, Gatorade',amount:4.5},
{time:'1:32 PM',camper:'Jake Cohen',items:'Fruit Cup',amount:3}
];
const WK=[{day:'Mon',v:142},{day:'Tue',v:198},{day:'Wed',v:165},{day:'Thu',v:210},{day:'Fri',v:0}];
const HR={9:4,10:12,11:8,12:28,13:15,14:22,15:18,16:6};

function init(){rStats();rAccounts();rInventory();rAnalytics();initTabs();popSelects()}
function initTabs(){document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.getElementById('tab-'+b.dataset.tab).classList.add('active')}))}

function rStats(){document.getElementById('sA').textContent=C.length;document.getElementById('sB').textContent='$'+C.reduce((s,c)=>s+c.bal,0).toFixed(0);document.getElementById('sI').textContent=I.filter(i=>i.stock>0).length;document.getElementById('sS').textContent='$'+TX.reduce((s,t)=>s+t.amount,0).toFixed(0)}

window.rAccounts=function(f){
const q=f||(document.getElementById('aSearch')?.value||'');
document.getElementById('aBody').innerHTML=C.filter(c=>c.name.toLowerCase().includes(q.toLowerCase())).map(c=>{
const rem=c.limit-c.spent;let st;if(c.bal<=0)st='<span class="badge badge-red">No Funds</span>';else if(rem<=0)st='<span class="badge badge-amber">Limit Hit</span>';else st='<span class="badge badge-green">Active</span>';
return '<tr><td style="font-weight:600">'+esc(c.name)+'</td><td>'+c.div+'</td><td>'+c.bunk+'</td><td style="font-weight:700;color:'+(c.bal<=5?'var(--red-600)':'var(--text-primary)')+'">$'+c.bal.toFixed(2)+'</td><td>$'+c.limit.toFixed(2)+'</td><td>$'+c.spent.toFixed(2)+'</td><td>'+st+'</td><td><button class="btn btn-sm btn-primary" onclick="openM(\'dep\');document.getElementById(\'depCamper\').value=\''+c.id+'\'">+ Deposit</button></td></tr>'
}).join('')};

function rInventory(){
document.getElementById('iCount').textContent=I.length+' items';
document.getElementById('iBody').innerHTML=I.map(i=>{
let st;if(i.stock===0)st='<span class="badge badge-red">Out</span>';else if(i.stock<=10)st='<span class="badge badge-amber">Low</span>';else st='<span class="badge badge-green">OK</span>';
return '<tr><td style="font-size:1.2rem;text-align:center;width:36px">'+i.emoji+'</td><td style="font-weight:600">'+esc(i.name)+'</td><td><span class="badge badge-neutral">'+i.cat+'</span></td><td style="font-weight:600">$'+i.price.toFixed(2)+'</td><td style="font-weight:600;color:'+(i.stock===0?'var(--red-600)':i.stock<=10?'var(--amber-600)':'var(--text-primary)')+'">'+i.stock+'</td><td>'+i.sold+'</td><td>'+i.total+'</td><td>'+st+'</td><td><button class="btn btn-sm btn-secondary">Edit</button></td></tr>'
}).join('')}

function rAnalytics(){
const sal=TX.reduce((s,t)=>s+t.amount,0),tc=TX.length,units=I.reduce((s,i)=>s+i.sold,0),openStock=I.reduce((s,i)=>s+i.stock+i.sold,0);
document.getElementById('mRev').textContent='$'+sal.toFixed(2);document.getElementById('mTxn').textContent=tc+' txns';
document.getElementById('mAvg').textContent=tc?'$'+(sal/tc).toFixed(2):'$0';document.getElementById('mUnits').textContent=units;
document.getElementById('mLow').textContent=I.filter(i=>i.stock<=10).length;document.getElementById('mST').textContent=(openStock?Math.round(units/openStock*100):0)+'%';
const top=[...I].sort((a,b)=>b.sold-a.sold)[0];document.getElementById('mTop').textContent=top?top.emoji+' '+top.name:'—';document.getElementById('mTopN').textContent=top?top.sold+' today · '+top.total+' all-time':'';

const ranked=[...I].sort((a,b)=>b.total-a.total),maxT=ranked[0]?.total||1;
document.getElementById('popList').innerHTML=ranked.map((i,x)=>'<div class="rank-item"><div class="rank-pos">'+(x+1)+'</div><div class="rank-emoji">'+i.emoji+'</div><div class="rank-info"><div class="rank-name">'+esc(i.name)+'</div><div class="rank-bar-track"><div class="rank-bar-fill" style="width:'+Math.round(i.total/maxT*100)+'%"></div></div></div><div style="text-align:right"><div class="rank-count">'+i.total+'</div><div class="rank-revenue">$'+(i.total*i.price).toFixed(0)+'</div></div></div>').join('');

const cats={};I.forEach(i=>{if(!cats[i.cat])cats[i.cat]={u:0,r:0};cats[i.cat].u+=i.sold;cats[i.cat].r+=i.sold*i.price});
const cc={drink:'var(--blue-500)',snack:'var(--amber-500)',treat:'var(--purple-500)'};const tr=Object.values(cats).reduce((s,c)=>s+c.r,0)||1;
document.getElementById('catBrk').innerHTML=Object.entries(cats).sort((a,b)=>b[1].r-a[1].r).map(([k,d])=>'<div class="cat-row"><div class="cat-dot" style="background:'+(cc[k]||'gray')+'"></div><div class="cat-name">'+k.charAt(0).toUpperCase()+k.slice(1)+'s</div><div class="cat-value">$'+d.r.toFixed(2)+'</div><div class="cat-pct">'+Math.round(d.r/tr*100)+'%</div></div>').join('')+'<div style="display:flex;gap:3px;margin-top:1rem;height:8px;border-radius:4px;overflow:hidden">'+Object.entries(cats).sort((a,b)=>b[1].r-a[1].r).map(([k,d])=>'<div style="flex:'+Math.round(d.r/tr*100)+';background:'+(cc[k]||'gray')+'"></div>').join('')+'</div>';

const sp=[...C].sort((a,b)=>b.spent-a.spent).filter(c=>c.spent>0);
document.getElementById('spList').innerHTML=sp.map(c=>'<div class="spend-row"><div class="spend-avatar">'+c.name.split(' ').map(w=>w[0]).join('')+'</div><div class="spend-name">'+esc(c.name)+'<div style="font-size:.7rem;color:var(--text-muted)">'+c.div+'</div></div><div class="spend-amount">$'+c.spent.toFixed(2)+'</div></div>').join('')||'<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.8rem">No purchases yet</div>';

const hrs=Object.keys(HR).map(Number).sort((a,b)=>a-b),maxH=Math.max(...Object.values(HR),1);
document.getElementById('heatmap').innerHTML='<div style="font-size:.75rem;color:var(--text-muted);margin-bottom:.5rem">Darker = busier</div><div style="display:flex;gap:3px;flex-wrap:wrap">'+hrs.map(h=>{const v=HR[h]||0,p=v/maxH;const bg=p>.7?'var(--snacks)':p>.4?'var(--snacks-100)':p>0?'var(--green-50)':'var(--bg-tertiary)';const clr=p>.7?'white':'var(--text-muted)';return '<div style="text-align:center"><div class="heat-cell" style="background:'+bg+';color:'+clr+'">'+v+'</div><div class="heat-label">'+(h>12?h-12+'p':h+'a')+'</div></div>'}).join('')+'</div>';

WK[3].v=Math.round(sal);const mx=Math.max(...WK.map(d=>d.v),1);
document.getElementById('wChart').innerHTML=WK.map(d=>'<div class="bar-col"><div class="bar-value">$'+d.v+'</div><div class="bar" style="height:'+Math.max(d.v/mx*100,2)+'%;background:'+(d.day==='Thu'?'var(--snacks)':'var(--snacks-100)')+'"></div><div class="bar-label">'+d.day+'</div></div>').join('');
document.getElementById('txC').textContent=TX.length;
document.getElementById('txBody').innerHTML=TX.slice(0,10).map(t=>'<tr><td style="white-space:nowrap">'+esc(t.time)+'</td><td style="font-weight:600">'+esc(t.camper)+'</td><td>'+esc(t.items)+'</td><td style="font-weight:700">$'+t.amount.toFixed(2)+'</td></tr>').join('');
}

window.openM=function(n){document.getElementById('m-'+n).classList.add('open');if(n==='dep'||n==='limit')popSelects()};
window.closeM=function(n){document.getElementById('m-'+n).classList.remove('open')};
function popSelects(){
const s1=document.getElementById('depCamper'),s2=document.getElementById('limCamper'),s3=document.getElementById('rItem');
const opts='<option value="">— Select —</option>'+C.map(c=>'<option value="'+c.id+'">'+esc(c.name)+' ('+c.div+')</option>').join('');
if(s1)s1.innerHTML=opts;if(s2)s2.innerHTML=opts;
if(s3)s3.innerHTML='<option value="">— Select —</option>'+I.map(i=>'<option value="'+i.id+'">'+i.emoji+' '+esc(i.name)+' ('+i.stock+' in stock)</option>').join('');
}

window.addDep=function(){const cid=+document.getElementById('depCamper').value,amt=parseFloat(document.getElementById('depAmt').value);if(!cid||!amt||amt<=0){toast('Enter valid info',1);return}const c=C.find(x=>x.id===cid);c.bal+=amt;closeM('dep');rStats();rAccounts();toast('Added $'+amt.toFixed(2)+' to '+c.name);document.getElementById('depAmt').value='';document.getElementById('depNote').value=''};
window.setLimit=function(){const cid=+document.getElementById('limCamper').value,amt=parseFloat(document.getElementById('limAmt').value);if(!cid||!amt){toast('Enter valid info',1);return}const c=C.find(x=>x.id===cid);c.limit=amt;closeM('limit');rAccounts();toast('Limit set to $'+amt.toFixed(2)+' for '+c.name)};
window.addItem=function(){const name=document.getElementById('niName').value.trim(),cat=document.getElementById('niCat').value,emoji=document.getElementById('niEmoji').value.trim()||'📦',price=parseFloat(document.getElementById('niPrice').value),stock=parseInt(document.getElementById('niStock').value)||0;if(!name||!price){toast('Fill required fields',1);return}I.push({id:I.length+1,name,cat,emoji,price,stock,sold:0,total:0});closeM('item');rInventory();rStats();rAnalytics();toast('Added '+emoji+' '+name);['niName','niEmoji','niPrice','niStock'].forEach(x=>document.getElementById(x).value='')};
window.restock=function(){const iid=+document.getElementById('rItem').value,qty=parseInt(document.getElementById('rQty').value);if(!iid||!qty){toast('Select item and quantity',1);return}const i=I.find(x=>x.id===iid);i.stock+=qty;closeM('restock');rInventory();rStats();rAnalytics();toast('Restocked '+i.emoji+' '+i.name+' +'+qty)};

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function toast(m,e){const el=document.getElementById('toast');el.textContent=m;el.className='toast show'+(e?' err':'');setTimeout(()=>el.className='toast',2500)}
document.addEventListener('DOMContentLoaded',init);
})();
