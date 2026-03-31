// =============================================================================
// campistry_snacks_pos.js — Campistry Snacks Selling Console Logic
// Handles: Camper selection, Quick Push POS, Cart, Charge
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

let sel=null,cart=[],cat='all';

// Clock
function tick(){document.getElementById('clock').textContent=new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'})}
setInterval(tick,1000);tick();

// === CAMPERS ===
window.renderCampers=function(){
const q=(document.getElementById('camperSearch').value||'').toLowerCase();
const el=document.getElementById('camperList');
const list=C.filter(c=>c.name.toLowerCase().includes(q));
el.innerHTML=list.map(c=>{
const rem=c.limit-c.spent;const cls=(c.bal<=0?'empty':c.bal<=5?'low':'');const limitHit=rem<=0&&c.bal>0;
const initials=c.name.split(' ').map(w=>w[0]).join('');
return '<div class="camper-item'+(sel===c.id?' selected':'')+(limitHit?' limit-hit':'')+'" onclick="pickCamper('+c.id+')"><div class="camper-avatar">'+initials+'</div><div class="camper-info"><div class="camper-name">'+esc(c.name)+'</div><div class="camper-meta">'+c.div+' · '+c.bunk+(limitHit?' · Limit hit':'')+'</div></div><div class="camper-balance '+cls+'">$'+c.bal.toFixed(2)+'</div></div>'
}).join('');
};

window.pickCamper=function(id){
sel=id;renderCampers();updateCamperBar();updateChargeBtn();
};

function updateCamperBar(){
const bar=document.getElementById('cartCamperBar');
if(!sel){bar.innerHTML='<span class="cart-camper-empty">← Select a camper</span>';return}
const c=C.find(x=>x.id===sel);
bar.innerHTML='<div class="camper-avatar" style="width:28px;height:28px;font-size:.6rem;background:var(--snacks);color:white">'+c.name.split(' ').map(w=>w[0]).join('')+'</div><div class="cart-camper-name">'+esc(c.name)+'</div><div class="cart-camper-bal">$'+c.bal.toFixed(2)+'</div>';
}

// === ITEMS ===
window.setCat=function(btn,c){cat=c;document.querySelectorAll('.cat-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderItems()};

window.renderItems=function(){
const q=(document.getElementById('itemSearch').value||'').toLowerCase();
const fil=I.filter(i=>(cat==='all'||i.cat===cat)&&i.name.toLowerCase().includes(q));
const sorted=[...fil].sort((a,b)=>b.total-a.total);
const maxT=Math.max(...I.map(i=>i.total),1);

// Quick push: top 5 in stock
const quick=sorted.filter(i=>i.stock>0).slice(0,5);
document.getElementById('quickGrid').innerHTML=quick.map((i,idx)=>{
let tier='';if(idx===0)tier='hot';else if(i.total/maxT>.4)tier='warm';
const rank=idx<3?'<div class="tile-rank">🔥 #'+(idx+1)+'</div>':'';
return '<div class="item-tile '+tier+(i.stock===0?' out':'')+'" onclick="addItem('+i.id+')">'+rank+'<div class="tile-emoji">'+i.emoji+'</div><div class="tile-name">'+esc(i.name)+'</div><div class="tile-price">$'+i.price.toFixed(2)+'</div><div class="tile-stock">'+(i.stock===0?'OUT':i.stock+' left')+'</div></div>'
}).join('');

// All
document.getElementById('allGrid').innerHTML=sorted.map(i=>'<div class="item-tile '+(i.stock===0?'out':'')+'" onclick="addItem('+i.id+')"><div class="tile-emoji">'+i.emoji+'</div><div class="tile-name">'+esc(i.name)+'</div><div class="tile-price">$'+i.price.toFixed(2)+'</div></div>').join('');
};

window.addItem=function(id){
const item=I.find(i=>i.id===id);if(!item||item.stock===0)return;
const ex=cart.find(c=>c.id===id);
if(ex){if(ex.qty>=item.stock)return;ex.qty++}else cart.push({id,qty:1});
renderCart();
};

// === CART ===
window.clearCart=function(){cart=[];renderCart()};
window.changeQty=function(id,d){const ci=cart.find(c=>c.id===id);if(!ci)return;ci.qty+=d;if(ci.qty<=0)cart=cart.filter(c=>c.id!==id);renderCart()};

function renderCart(){
const body=document.getElementById('cartBody'),totalEl=document.getElementById('cartTotal'),remEl=document.getElementById('cartRemaining');
if(!cart.length){body.innerHTML='<div class="cart-empty">Tap items to start</div>';totalEl.textContent='$0.00';remEl.textContent='';updateChargeBtn();return}
let total=0;
body.innerHTML=cart.map(ci=>{const item=I.find(i=>i.id===ci.id);const lt=item.price*ci.qty;total+=lt;
return '<div class="cart-line"><div class="cart-line-info"><div class="cart-line-name">'+item.emoji+' '+esc(item.name)+'</div><div class="cart-line-sub">$'+item.price.toFixed(2)+' ea</div></div><div class="cart-line-qty"><button onclick="changeQty('+ci.id+',-1)">−</button><span>'+ci.qty+'</span><button onclick="changeQty('+ci.id+',1)">+</button></div><div class="cart-line-total">$'+lt.toFixed(2)+'</div></div>'
}).join('');
totalEl.textContent='$'+total.toFixed(2);
if(sel){const c=C.find(x=>x.id===sel);const rem=c.limit-c.spent;remEl.textContent='Daily remaining: $'+Math.max(rem,0).toFixed(2)+' · Balance: $'+c.bal.toFixed(2)}
updateChargeBtn();
}

function updateChargeBtn(){
const btn=document.getElementById('chargeBtn');
const total=cart.reduce((s,ci)=>{const item=I.find(i=>i.id===ci.id);return s+item.price*ci.qty},0);
if(!sel||!cart.length||total===0){btn.disabled=true;btn.textContent='Charge';return}
const c=C.find(x=>x.id===sel);
btn.disabled=false;
btn.textContent='Charge $'+total.toFixed(2)+' → '+c.name.split(' ')[0];
}

// === CHARGE ===
window.charge=function(){
if(!sel||!cart.length)return;
const c=C.find(x=>x.id===sel);
const total=cart.reduce((s,ci)=>{const item=I.find(i=>i.id===ci.id);return s+item.price*ci.qty},0);
const rem=c.limit-c.spent;
if(total>rem){toast('Exceeds daily limit ($'+rem.toFixed(2)+' left)',true);return}
if(total>c.bal){toast('Insufficient balance ($'+c.bal.toFixed(2)+')',true);return}

// Process
c.bal-=total;c.spent+=total;
cart.forEach(ci=>{const item=I.find(i=>i.id===ci.id);item.stock-=ci.qty;item.sold+=ci.qty;item.total+=ci.qty});
cart=[];

// Flash success
document.querySelector('.cart-panel').classList.add('flash');
setTimeout(()=>document.querySelector('.cart-panel').classList.remove('flash'),600);

toast('✓ $'+total.toFixed(2)+' charged to '+c.name);
sel=null;
renderCampers();renderItems();renderCart();updateCamperBar();
document.getElementById('camperSearch').value='';
document.getElementById('camperSearch').focus();
};

function toast(msg,err){const el=document.getElementById('toast');el.textContent=msg;el.className='toast show'+(err?' err':'');setTimeout(()=>el.className='toast',2200)}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

// Boot
renderCampers();renderItems();renderCart();
})();
