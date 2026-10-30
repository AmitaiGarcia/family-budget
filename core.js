/* Family Budget — core logic (v3).
 * Pure functions only: no screen, no storage. The app (index.html) and the
 * automatic tests (tests.html) both use this file, so what is tested is exactly
 * what runs.
 *
 * Data ("db") shape:
 *   settings     { income, startMonth, categories[], cards[], accounts{} }
 *   bills        { id: {name, kind:'fixed'|'variable', amount, day, every, start, end,
 *                       category, method, pauses[{from,to}], skipped[], changes[{from,...}]} }
 *   transactions { id: {type:'expense'|'refund', date, amount, category, method, note,
 *                       person, billId?, billMonth?, statementMonth?, importKey?} }
 *   statements   { id: {card, month, amount, status:'final'|'partial', asOf?} }
 *   merchants    { key: {category} }   — learned from your corrections
 */
(function(root){'use strict';
const C={};

// ---- small helpers -------------------------------------------------------------
C.round2=x=>Math.round((Number(x)||0)*100)/100;
C.isMonth=v=>typeof v==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(v);
C.isDate=v=>typeof v==='string'&&/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)&&Number(v.slice(8))<=new Date(Date.UTC(+v.slice(0,4),+v.slice(5,7),0)).getUTCDate();
C.monthOf=d=>String(d||'').slice(0,7);
C.addMonths=(m,n)=>{const [y,mo]=m.split('-').map(Number);const t=y*12+(mo-1)+n;return Math.floor(t/12)+'-'+String(t%12+1).padStart(2,'0')};
C.monthsBetween=(a,b)=>{const [y1,m1]=a.split('-').map(Number),[y2,m2]=b.split('-').map(Number);return (y2-y1)*12+(m2-m1)};
C.lastDay=m=>{const [y,mo]=m.split('-').map(Number);return new Date(Date.UTC(y,mo,0)).getUTCDate()};
C.dateIn=(m,day)=>m+'-'+String(Math.min(Math.max(1,Number(day)||1),C.lastDay(m))).padStart(2,'0');
C.daysBetween=(a,b)=>Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
C.todayStr=(d=new Date())=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
C.sum=(list,f=x=>x)=>C.round2(list.reduce((a,x)=>a+Number(f(x)||0),0));
C.signed=t=>(t.type==='refund'?-1:1)*Number(t.amount||0);
C.safeId=s=>String(s).replace(/[\/.#\[\]\s:]+/g,'_').slice(0,120)||'x';
C.newId=()=>(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);

// ---- defaults ------------------------------------------------------------------
// Example values only — no real figures live in this public file.
C.defaultSettings=()=>({
 income:20000,startMonth:C.todayStr().slice(0,7),
 categories:[['bills','Bills & commitments',8000,false],['groceries','Groceries & household',4000,false],['fuel','Fuel',800,false],['dining','Restaurants & delivery',600,false],['fun','Family activities',500,true],['clothes','Clothing & shoes',400,true],['car','Car maintenance',400,true],['holidays','Holidays & birthdays',400,true],['medical','Medical & healthcare',400,true],['unexpected','Unexpected expenses',500,true],['savings','Emergency savings',500,true],['buffer','General buffer',300,false]].map(([id,name,limit,rollover])=>({id,name,limit,rollover,opening:0})),
 cards:[{id:'card-1',name:'Card 1',bank:'Leumi',day:10},{id:'card-2',name:'Card 2',bank:'Hapoalim',day:15}],
 accounts:{leumi:0,hapoalim:0,carReserve:0,carReserveDue:'',asOf:''}
});
const bill=(id,name,amount,day,method,extra={})=>({id,name,kind:'fixed',amount,day,every:1,start:C.todayStr().slice(0,7),end:'',category:'bills',method,pauses:[],skipped:[],changes:[],...extra});
// Example bills only. The family's real setup is imported from a private start file.
C.defaultBills=()=>[
 bill('auto-rent','Rent',5000,1,'bank-hapoalim'),
 bill('util-electricity','Electricity',400,15,'bank-hapoalim',{kind:'variable'}),
 bill('util-arnona','Arnona',600,15,'bank-hapoalim',{kind:'variable'}),
 bill('util-water','Water',150,15,'bank-hapoalim',{kind:'variable'}),
 bill('util-gas','Gas',30,15,'bank-hapoalim',{kind:'variable'})
];
C.emptyDb=()=>({settings:C.defaultSettings(),bills:Object.fromEntries(C.defaultBills().map(b=>[b.id,b])),transactions:{},statements:{},merchants:{}});

// ---- payment methods -------------------------------------------------------------
C.BANK_METHODS=[{id:'bank-leumi',name:'Bank transfer / Leumi',bank:'Leumi',type:'bank'},{id:'bank-hapoalim',name:'Bank transfer / Hapoalim',bank:'Hapoalim',type:'bank'},{id:'cash',name:'Cash / other',bank:null,type:'cash'}];
C.methods=s=>[...(s.cards||[]).map(c=>({id:c.id,name:c.name,bank:c.bank,type:'card',day:Number(c.day)||1})),...C.BANK_METHODS];
C.method=(s,id)=>C.methods(s).find(m=>m.id===id)||null;
C.card=(s,id)=>(s.cards||[]).find(c=>c.id===id)||null;
// Agreed rule: bought BEFORE the payment day → collected that month; ON/AFTER → next month.
C.collectionMonth=(date,card)=>Number(date.slice(8,10))<Number(card.day)?C.monthOf(date):C.addMonths(C.monthOf(date),1);
C.collectionDate=(month,card)=>C.dateIn(month,card.day);

// ---- regular bills -----------------------------------------------------------------
// A bill's values in a month: the base values, then every change dated on or before it.
C.billValues=(b,m)=>{const v={amount:Number(b.amount)||0,day:Number(b.day)||1,method:b.method,category:b.category||'bills'};for(const c of [...(b.changes||[])].sort((x,y)=>x.from.localeCompare(y.from)))if(c.from<=m)for(const k of ['amount','day','method','category'])if(c[k]!=null&&c[k]!=='')v[k]=k==='amount'||k==='day'?Number(c[k]):c[k];return v};
C.billOccursIn=(b,m)=>{
 if(!C.isMonth(b.start)||m<b.start||(b.end&&m>b.end))return false;
 const every=Number(b.every);
 if(every===0){if(m!==b.start)return false}else if(C.monthsBetween(b.start,m)%(every||1))return false;
 if((b.pauses||[]).some(p=>p.from<=m&&(!p.to||m<=p.to)))return false;
 return !(b.skipped||[]).includes(m);
};
const txList=db=>Object.entries(db.transactions||{}).map(([id,t])=>({...t,id}));
// The real transaction recorded for a bill occurrence, if any.
C.billActual=(db,billId,m)=>txList(db).find(t=>t.billId===billId&&t.billMonth===m)||null;
// Spread bills (e.g. electricity every 2 months): the budget sets aside an equal share
// every month, and the real bill — typed once — is split over the months it covers.
// The bank still pays the whole bill on its own date.
C.isSpread=b=>!!b&&b.spread===true&&Number(b.every)>1;
// The payment month whose bill covers month m. Most bills (electricity) are paid
// afterwards: the bill in month P covers the months up to P. Some (arnona) are paid
// in advance (covers:'ahead'): the bill in month P covers P and the months after it.
C.cycleMonth=(b,m)=>{const e=Number(b.every),d=C.monthsBetween(b.start,m);return C.addMonths(b.start,(b.covers==='ahead'?Math.floor(d/e):Math.ceil(d/e))*e)};
C.coveredMonths=(b,P)=>{const e=Number(b.every),out=[];for(let i=0;i<e;i++)out.push(b.covers==='ahead'?C.addMonths(P,i):C.addMonths(P,i-e+1));return out};
const paused=(b,m)=>(b.pauses||[]).some(p=>p.from<=m&&(!p.to||m<=p.to));
const spreadIds=db=>new Set(Object.entries(db.bills||{}).filter(([,b])=>C.isSpread(b)).map(([id])=>id));
// What the BUDGET sees in month m: bills not yet entered (fixed = spent automatically,
// variable = an estimate that is set aside), plus each spread bill's monthly share.
C.occurrences=(db,m)=>{
 const s=db.settings;if(!C.isMonth(m)||m<s.startMonth)return [];
 const linked=new Set(txList(db).filter(t=>t.billId).map(t=>t.billId+'|'+t.billMonth)),out=[];
 for(const [id,b] of Object.entries(db.bills||{})){
  if(C.isSpread(b)){
   if(!C.isMonth(b.start)||paused(b,m))continue;
   const P=C.cycleMonth(b,m),e=Number(b.every);
   if(!C.billOccursIn(b,P))continue;   // that bill was skipped, or is past the end
   const v=C.billValues(b,P),actual=C.billActual(db,id,P);
   out.push({id:'share:'+id+':'+m,virtual:true,share:true,billId:id,billMonth:P,type:'expense',date:C.dateIn(m,v.day),amount:C.round2((actual?Number(actual.amount):v.amount)/e),billAmount:actual?Number(actual.amount):v.amount,category:v.category,method:v.method,note:b.name,estimate:!actual,person:'Automatic'});
   continue;
  }
  if(!C.billOccursIn(b,m)||linked.has(id+'|'+m))continue;
  const v=C.billValues(b,m);
  out.push({id:'bill:'+id+':'+m,virtual:true,billId:id,billMonth:m,type:'expense',date:C.dateIn(m,v.day),amount:v.amount,category:v.category,method:v.method,note:b.name,estimate:b.kind==='variable',person:'Automatic'});
 }
 return out;
};
// What the BANK sees in month m: bills to be paid this month that aren't entered yet,
// at their full amount (spread bills included).
C.paymentOccurrences=(db,m)=>{
 const s=db.settings;if(!C.isMonth(m)||m<s.startMonth)return [];
 const linked=new Set(txList(db).filter(t=>t.billId).map(t=>t.billId+'|'+t.billMonth)),out=[];
 for(const [id,b] of Object.entries(db.bills||{})){
  if(!C.billOccursIn(b,m)||linked.has(id+'|'+m))continue;
  const v=C.billValues(b,m);
  out.push({id:'bill:'+id+':'+m,virtual:true,billId:id,billMonth:m,type:'expense',date:C.dateIn(m,v.day),amount:v.amount,category:v.category,method:v.method,note:b.name,estimate:b.kind==='variable'||C.isSpread(b),person:'Automatic'});
 }
 return out;
};
// Budget view: a spread bill's real payment is replaced by its monthly shares.
C.itemsForMonth=(db,m)=>{const sp=spreadIds(db);return [...txList(db).filter(t=>C.monthOf(t.date)===m&&!(t.billId&&sp.has(t.billId))),...C.occurrences(db,m)]};
// Bank view: every real payment on its own date, plus bills still to come.
C.paymentItemsForMonth=(db,m)=>[...txList(db).filter(t=>C.monthOf(t.date)===m),...C.paymentOccurrences(db,m)];

// ---- budget --------------------------------------------------------------------
C.categoryMonth=(db,catId,m)=>{let spent=0,reserved=0;for(const t of C.itemsForMonth(db,m)){if(t.category!==catId)continue;if(t.estimate)reserved+=Number(t.amount);else spent+=C.signed(t)}return {spent:C.round2(spent),reserved:C.round2(reserved)}};
C.available=(db,cat,m)=>{
 const s=db.settings,limit=Number(cat.limit)||0,{spent,reserved}=C.categoryMonth(db,cat.id,m);let left=limit-spent-reserved;
 if(cat.rollover&&m>=s.startMonth){left+=Number(cat.opening)||0;for(let mo=s.startMonth,g=0;mo<m&&g<600;g++,mo=C.addMonths(mo,1)){const x=C.categoryMonth(db,cat.id,mo);left+=limit-x.spent-x.reserved}}
 return C.round2(left);
};
C.budget=(db,m)=>{const cats=db.settings.categories.map(c=>({...c,...C.categoryMonth(db,c.id,m),available:C.available(db,c,m)}));return {cats,left:C.sum(cats,c=>c.available)}};

// ---- card collections ("the statement wins") -----------------------------------
C.dueMonthOf=(t,card)=>C.isMonth(t.statementMonth)?t.statementMonth:C.collectionMonth(t.date,card);
C.cardItems=(db,cardId,month)=>{
 const s=db.settings,card=C.card(s,cardId);if(!card)return [];
 const startDate=s.startMonth+'-01',out=[];
 for(const m of [C.addMonths(month,-2),C.addMonths(month,-1),month])
  for(const t of C.paymentItemsForMonth(db,m))if(t.method===cardId&&C.isDate(t.date)&&t.date>=startDate&&C.dueMonthOf(t,card)===month)out.push(t);
 // purchases moved to this statement by hand from further away
 for(const t of txList(db))if(t.method===cardId&&t.statementMonth===month&&C.isDate(t.date)&&t.date>=startDate&&C.monthsBetween(C.monthOf(t.date),month)>2)out.push(t);
 return out.sort((a,b)=>a.date.localeCompare(b.date));
};
C.statementFor=(db,cardId,month)=>{const e=Object.entries(db.statements||{}).find(([,x])=>x.card===cardId&&x.month===month);return e?{...e[1],id:e[0]}:null};
// How much the bank will collect for one card in one month:
//  - final statement entered  → exactly that amount
//  - partial ("known so far" on a date) → that amount + purchases dated after it
//  - nothing entered          → the sum of tracked purchases (an estimate)
C.cardCollection=(db,cardId,month)=>{
 const card=C.card(db.settings,cardId),items=C.cardItems(db,cardId,month),tracked=C.sum(items,C.signed),st=C.statementFor(db,cardId,month);
 let amount=tracked,basis='estimate',added=[];
 if(st&&st.status==='partial'){added=items.filter(t=>t.date>(st.asOf||''));amount=C.round2(Number(st.amount)+C.sum(added,C.signed));basis='partial'}
 else if(st){amount=C.round2(st.amount);basis='statement'}
 return {card,cardId,month,date:card?C.collectionDate(month,card):month+'-01',items,tracked,statement:st,amount,basis,added,hasEstimates:items.some(t=>t.estimate)};
};
C.bankPayments=(db,m)=>{
 const s=db.settings,banks={};
 for(const name of ['Leumi','Hapoalim'])banks[name]={bank:name,lines:[],total:0};
 for(const t of C.paymentItemsForMonth(db,m)){const meth=C.method(s,t.method);if(!meth||meth.type!=='bank'||t.type!=='expense')continue;banks[meth.bank].lines.push({kind:'direct',date:t.date,name:t.note||'Bank payment',amount:C.round2(t.amount),estimate:!!t.estimate,item:t})}
 for(const card of s.cards||[]){const col=C.cardCollection(db,card.id,m);if(!banks[card.bank])banks[card.bank]={bank:card.bank,lines:[],total:0};if(col.amount!==0||col.statement)banks[card.bank].lines.push({kind:'card',date:col.date,name:card.name,amount:col.amount,estimate:col.basis!=='statement',collection:col})}
 for(const b of Object.values(banks)){b.lines.sort((x,y)=>x.date.localeCompare(y.date)||x.name.localeCompare(y.name));b.total=C.sum(b.lines,l=>l.amount)}
 return Object.values(banks);
};

// ---- statement import ----------------------------------------------------------
C.parseAmount=v=>{if(typeof v==='number')return Number.isFinite(v)?v:null;if(v==null)return null;let s=String(v).trim();if(!s)return null;let neg=false;if(/^\(.*\)$/.test(s)){neg=true;s=s.slice(1,-1)}if(/-$/.test(s)){neg=true;s=s.slice(0,-1)}s=s.replace(/[₪$€\s]|ILS|NIS|ש"ח|ש״ח/gi,'').replace(/,/g,'');if(!/^-?\d+(\.\d+)?$/.test(s))return null;const n=Number(s);return neg?-Math.abs(n):n};
C.parseDate=v=>{
 if(typeof v==='number'&&v>20000&&v<80000){const d=new Date(Date.UTC(1899,11,30)+Math.round(v)*86400000);return d.toISOString().slice(0,10)}
 if(v instanceof Date&&!isNaN(v))return C.todayStr(v);
 const s=String(v??'').trim();let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);if(m){const r=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');return C.isDate(r)?r:null}
 m=s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);if(m){const y=m[3].length===2?'20'+m[3]:m[3],r=y+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');return C.isDate(r)?r:null}
 return null;
};
const HEAD={
 date:[/תאריך\s*(ה)?(עסקה|רכישה|ביצוע)/,/transaction\s*date|purchase\s*date/i,/^תאריך$/,/^date$/i],
 merchant:[/שם\s*בית\s*(ה)?עסק/,/בית\s*(ה)?עסק/,/merchant|business\s*name/i,/תיאור|פירוט/,/description|details/i],
 amount:[/סכום\s*(ה)?חיוב/,/charge(d)?\s*amount|amount\s*charged|billing\s*amount/i,/סכום\s*(ה)?עסקה/,/^סכום/,/amount|sum/i]
};
C.detectColumns=rows=>{
 for(let r=0;r<Math.min(rows.length,40);r++){
  const cells=(rows[r]||[]).map(x=>String(x??'').trim()),col={};
  for(const k of Object.keys(HEAD))for(const re of HEAD[k]){const i=cells.findIndex(c=>c&&re.test(c));if(i>=0){col[k]=i;break}}
  if(col.date!=null&&col.amount!=null)return {headerRow:r,...col};
 }
 // No headings: guess from the data itself.
 const sample=rows.slice(0,40).filter(r=>r&&r.length>1),score=(f)=>{const n=Math.max(...sample.map(r=>r.length),0),s=[];for(let i=0;i<n;i++)s.push(sample.filter(r=>f(r[i])).length);return s};
 const ds=score(v=>C.parseDate(v)!=null),as=score(v=>C.parseAmount(v)!=null&&C.parseDate(v)==null),ts=score(v=>typeof v==='string'&&v.trim().length>2&&C.parseAmount(v)==null&&C.parseDate(v)==null);
 const best=a=>a.length&&Math.max(...a)>0?a.indexOf(Math.max(...a)):null;
 const date=best(ds),amount=best(as.map((x,i)=>i===date?0:x)),merchant=best(ts.map((x,i)=>i===date||i===amount?0:x));
 return date!=null&&amount!=null?{headerRow:-1,date,amount,merchant}:null;
};
C.parseStatementRows=rows=>{
 const col=C.detectColumns(rows);if(!col)return {columns:null,rows:[]};
 const out=[];
 for(let r=col.headerRow+1;r<rows.length;r++){const row=rows[r]||[];const date=C.parseDate(row[col.date]),amount=C.parseAmount(row[col.amount]);if(!date||amount==null||amount===0)continue;out.push({date,amount:C.round2(Math.abs(amount)),type:amount<0?'refund':'expense',merchant:col.merchant!=null?String(row[col.merchant]??'').trim():'',row:r})}
 return {columns:col,rows:out};
};
C.parseCsv=text=>{const rows=[];let row=[],cell='',q=false;text=String(text).replace(/^﻿/,'');const delim=(text.split('\n')[0].match(/;/g)||[]).length>(text.split('\n')[0].match(/,/g)||[]).length?';':text.includes('\t')&&!text.includes(',')?'\t':',';for(let i=0;i<text.length;i++){const ch=text[i];if(q){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++}else q=false}else cell+=ch}else if(ch==='"')q=true;else if(ch===delim){row.push(cell);cell=''}else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell=''}else cell+=ch}if(cell!==''||row.length){row.push(cell);rows.push(row)}return rows};

// ---- categories: learned first, then keywords ------------------------------------
C.normMerchant=s=>String(s||'').toLowerCase().replace(/[0-9*#_\-.,'"()\/\\]+/g,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,3).join(' ');
const KEYWORDS={
 groceries:['shufersal','שופרסל','rami levy','רמי לוי','yochananof','יוחננוף','osher ad','אושר עד','victory','ויקטורי','tiv taam','טיב טעם','carrefour','קרפור','yenot bitan','יינות ביתן','hatzi hinam','חצי חינם','am pm','super','סופר','מכולת','ikea','איקאה','max stock','מקס סטוק','home center','הום סנטר'],
 fuel:['paz ','פז ','delek','דלק','sonol','סונול','dor alon','דור אלון','yellow','ילו','fuel'],
 dining:['wolt','וולט','10bis','תן ביס','cibus','סיבוס','mcdonald','מקדונלד','aroma','ארומה','cafe','קפה','pizza','פיצה','burger','בורגר','restaurant','מסעדה','domino','דומינו'],
 medical:['super-pharm','super pharm','סופר-פארם','סופר פארם','pharm','פארם','clinic','מרפאה','optic','אופטיק'],
 clothes:['fox','פוקס','castro','קסטרו','h&m','zara','זארה','terminal x','טרמינל','shoes','נעלי','renuar','רנואר','golf','גולף'],
 car:['garage','מוסך','tire','צמיג','car wash','שטיפת','רישוי'],
 bills:['netflix','נטפליקס','partner','פרטנר','cellcom','סלקום','bezeq','בזק','spotify','חברת החשמל','ארנונה','ביטוח','insurance'],
 fun:['cinema','סינמה','yes planet','קולנוע','museum','מוזיאון','toys','צעצוע','luna','לונה'],
 smoking:['tobacco','טבק','סיגר','kiosk','קיוסק','פיצוצ']
};
C.guessCategory=(merchant,merchants,categories)=>{
 const ids=new Set((categories||[]).map(c=>c.id)),key=C.normMerchant(merchant);
 const learned=merchants?.[C.safeId(key)]?.category;if(learned&&ids.has(learned))return {category:learned,source:'learned'};
 const text=' '+String(merchant||'').toLowerCase()+' ';let best=null,len=0;
 for(const [cat,words] of Object.entries(KEYWORDS))for(const w of words)if(w.length>len&&text.includes(w)&&ids.has(cat)){best=cat;len=w.length}
 return best?{category:best,source:'keyword'}:{category:null,source:'none'};
};

// ---- match imported rows against what is already recorded ---------------------
const words=s=>String(s||'').toLowerCase().replace(/—.*$/,'').split(/[^a-z֐-׿0-9]+/).filter(w=>w.length>=3&&!['the','and','estimate','family','com','ltd','בעמ'].includes(w));
C.namesMatch=(billName,merchant)=>{const a=words(billName),b=words(merchant);return a.some(w=>b.some(x=>x.includes(w)||w.includes(x)))};
// Which card a downloaded file belongs to: last 4 digits first, then the issuer's name.
C.guessCard=(cards,text)=>{const t=String(text||'').toLowerCase();const byDigits=cards.find(c=>{const d=(c.name.match(/\d{4}/)||[])[0];return d&&t.includes(d)});if(byDigits)return byDigits.id;
 const names=[[/amex|american|אמריקן|אמקס/,/american|amex/i],[/mastercard|master card|מסטרקארד|ישראכרט|isracard/,/master/i],[/(^|[^a-z])max([^a-z]|$)|מקס/,/^max/i],[/visa|ויזה|כאל|(^|[^a-z])cal([^a-z]|$)/,/visa/i]];
 for(const [inText,inName] of names)if(inText.test(t)){const hits=cards.filter(c=>inName.test(c.name));if(hits.length===1)return hits[0].id}
 return null};
C.importKey=(cardId,r,n)=>C.safeId(['imp',cardId,r.date,r.amount,C.normMerchant(r.merchant),n].join('|'));
C.matchImport=(db,cardId,rows)=>{
 const s=db.settings,txs=txList(db),usedTx=new Set(),usedOcc=new Set(),seenKeys={};
 const months=[...new Set(rows.map(r=>C.monthOf(r.date)))];
 const occ=[];for(const m of new Set(months.flatMap(m=>[C.addMonths(m,-1),m,C.addMonths(m,1)])))occ.push(...C.paymentOccurrences(db,m).filter(o=>o.method===cardId));
 return rows.map(r=>{
  const base=r.date+'|'+r.amount+'|'+C.normMerchant(r.merchant),n=seenKeys[base]=(seenKeys[base]||0)+1,key=C.importKey(cardId,r,n);
  const g=C.guessCategory(r.merchant,db.merchants,s.categories);
  const out={...r,key,category:g.category,guess:g.source,status:'new',include:true,match:null};
  if(txs.some(t=>t.importKey===key)){out.status='already';out.include=false;return out}
  const dup=txs.find(t=>!usedTx.has(t.id)&&t.method===cardId&&t.type===r.type&&Math.abs(Number(t.amount)-r.amount)<0.01&&C.isDate(t.date)&&Math.abs(C.daysBetween(t.date,r.date))<=3);
  if(dup){usedTx.add(dup.id);out.status='duplicate';out.include=false;out.match=dup;return out}
  // A card charge pays a regular bill only if the shop name fits the bill, or the
  // amount is exact and close to the due date. Amount alone is not enough.
  if(r.type==='expense'){const o=occ.find(o=>{if(usedOcc.has(o.id))return false;const days=Math.abs(C.daysBetween(o.date,r.date)),diff=Math.abs(o.amount-r.amount),named=C.namesMatch(o.note,r.merchant);
   if(o.estimate)return named&&days<=20&&diff<=o.amount*0.6;
   return days<=7&&diff<=Math.max(1,o.amount*0.01)&&(named||days<=3)||named&&days<=10&&diff<=o.amount*0.25});
   if(o){usedOcc.add(o.id);out.status='bill';out.match=o;out.category=o.category}}
  return out;
 });
};

// ---- migration from the single-file app (v27 / v28 backups) -------------------
// Old-app labels (e.g. "MAX / Leumi", "Visa 1234") are matched to the cards saved in
// Settings: by the card's 4 digits first, otherwise by its first word.
C.cardFromLabel=(s,l)=>{const t=String(l||'').toLowerCase(),cards=s.cards||[];const d=t.match(/\d{4}/);if(d){const c=cards.find(c=>c.name.includes(d[0]));if(c)return c.id}const w=t.split(/[^a-z֐-׿]+/).filter(Boolean)[0];const c=w&&cards.find(c=>c.name.toLowerCase().split(/[^a-z֐-׿]+/).filter(Boolean)[0]===w);return c?c.id:null};
C.methodFromLabel=(s,l)=>{const t=String(l||'').toLowerCase();if(/bank|transfer|העברה/.test(t))return /hapoalim|פועלים/.test(t)?'bank-hapoalim':'bank-leumi';if(/cash|other|מזומן/.test(t)||!t)return 'cash';return C.cardFromLabel(s,l)||'cash'};
C.isLegacyBackup=o=>!!o&&Array.isArray(o.transactions)&&Array.isArray(o.categories);
// `target` is the setup to migrate into (usually what is already in the app, e.g. from
// the private start file), so the old card labels map onto your real cards.
C.migrateLegacy=(old,target)=>{
 const base=C.emptyDb(),db=target&&target.settings?{...base,settings:JSON.parse(JSON.stringify(target.settings)),bills:JSON.parse(JSON.stringify(target.bills||{}))}:base,s=db.settings,num=v=>{const n=C.parseAmount(v);return n==null?0:n},date=v=>C.parseDate(v)||'',notes=[];
 if(Number.isFinite(num(old.income))&&old.income!=null)s.income=num(old.income);
 const opening=old.opening||{};
 if(old.categories.length)s.categories=old.categories.filter(c=>c&&c.id!=null).map(c=>({id:String(c.id),name:String(c.name??c.id),limit:num(c.limit),rollover:!!c.rollover,opening:num(opening[c.id])}));
 const ac=old.accounts||{};s.accounts={...s.accounts,leumi:ac.leumi!=null?num(ac.leumi):s.accounts.leumi,hapoalim:ac.hapoalim!=null?num(ac.hapoalim):s.accounts.hapoalim,carReserve:ac.carReserve!=null?num(ac.carReserve):s.accounts.carReserve,asOf:date(ac.asOf)||s.accounts.asOf};
 // regular bills
 if(Array.isArray(old.recurringRules)){
  const utils={};for(const [id,b] of Object.entries(db.bills))if(id.startsWith('util-'))utils[id]=b;
  db.bills={...utils};
  for(const r of old.recurringRules){if(!r||r.id==null)continue;const id=C.safeId(r.id),start=C.isMonth(r.start)?r.start:s.startMonth;const b={id,name:String(r.name||'Regular bill'),kind:r.variable===true?'variable':'fixed',amount:num(r.amount),day:Math.min(31,Math.max(1,Number(r.day)||1)),every:[1,2,3,6,12].includes(Number(r.frequency))?Number(r.frequency):1,start,end:C.isMonth(r.end)?r.end:'',category:String(r.category||'bills'),method:C.methodFromLabel(s,r.card),pauses:[],skipped:[],changes:[]};
   if(r.enabled===false)b.pauses.push({from:start});else if(C.isMonth(r.resumeFrom)&&r.resumeFrom>start)b.pauses.push({from:start,to:C.addMonths(r.resumeFrom,-1)});
   db.bills[id]=b}
 }
 for(const sk of old.recurringSkipped||[]){const m=String(sk).match(/^recurring:(.+):(\d{4}-\d{2})$/);if(m&&db.bills[C.safeId(m[1])])db.bills[C.safeId(m[1])].skipped.push(m[2])}
 // transactions
 const seen=new Set();
 for(const t of old.transactions||[]){
  if(!t||typeof t!=='object')continue;
  if(t.estimate===true)continue;   // v28 stored past estimates; the bill recreates them
  const rec=String(t.id||'').match(/^recurring:(.+):(\d{4}-\d{2})$/);
  const n={type:t.type==='refund'||t.type==='income'?'refund':'expense',date:date(t.date),amount:C.round2(Math.abs(num(t.amount))),category:String(t.category||'unexpected'),method:C.methodFromLabel(s,t.card),note:String(t.note||''),person:String(t.person||'')};
  if(C.isDate(t.cardDue)&&C.card(s,n.method))n.statementMonth=C.monthOf(t.cardDue);
  if(rec&&db.bills[C.safeId(rec[1])]){n.billId=C.safeId(rec[1]);n.billMonth=rec[2]}
  else if(t.utilityId&&db.bills['util-'+t.utilityId]&&n.date){n.billId='util-'+t.utilityId;n.billMonth=C.monthOf(n.date)}
  if(!n.date)notes.push('A transaction without a valid date was kept ('+(n.note||n.amount)+').');
  let id=C.safeId('m-'+(t.id||C.newId()));while(seen.has(id))id=C.safeId('m-'+C.newId());seen.add(id);
  db.transactions[id]=n;
 }
 // unpaid reminders become one-off bills
 for(const u of old.upcoming||[]){if(!u||u.paid)continue;const d=date(u.date);if(!d)continue;const id=C.safeId('once-'+(u.id||C.newId()));db.bills[id]={id,name:String(u.note||'Reminder'),kind:'variable',amount:num(u.amount),day:Number(d.slice(8)),every:0,start:C.monthOf(d),end:'',category:String(u.category||'unexpected'),method:'bank-hapoalim',pauses:[],skipped:[],changes:[]}}
 // card bills: the November opening totals were "known so far" on the snapshot date
 // the old app's built-in opening card bills had ids ending in "-nov"
 for(const p of old.cardPayments||[]){
  const card=C.cardFromLabel(s,p?.name),d=date(p?.date);if(!card||!d){notes.push('Card bill "'+(p?.name||'?')+'" was kept in the archive only.');continue}
  const actual=p.paid&&p.actualAmount!=null?num(p.actualAmount):null,id=C.safeId('st-'+card+'-'+C.monthOf(d));
  db.statements[id]=actual!=null?{card,month:C.monthOf(d),amount:actual,status:'final'}:/-nov$/.test(String(p.id))?{card,month:C.monthOf(d),amount:num(p.amount),status:'partial',asOf:s.accounts.asOf||'2026-10-29'}:{card,month:C.monthOf(d),amount:num(p.amount),status:'final'};
 }
 return {db,notes};
};

// ---- Firebase config pasted from the console -----------------------------------
// Accepts the whole snippet Firebase shows (imports and all), or just the { … } part.
C.parseFirebaseConfig=text=>{
 const m=String(text||'').match(/\{[^{}]*apiKey[^{}]*\}/);if(!m)throw Error('could not find the block with apiKey in it — copy the whole firebaseConfig section');
 const json=m[0].replace(/^\s*\/\/[^\n]*$/gm,'').replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g,'$1"$2":').replace(/'/g,'"').replace(/,\s*}/g,'}');
 let c;try{c=JSON.parse(json)}catch{throw Error('the config block could not be read — copy it again exactly as shown')}
 if(!c.apiKey||!c.projectId||!c.authDomain)throw Error('the config needs apiKey, authDomain and projectId');return c};

// ---- backups -------------------------------------------------------------------
C.BACKUP_FORMAT='family-budget-v3';
C.isBackup=o=>!!o&&o.format===C.BACKUP_FORMAT&&o.settings&&typeof o.bills==='object';
C.makeBackup=db=>({format:C.BACKUP_FORMAT,exportedAt:new Date().toISOString(),settings:db.settings,bills:db.bills,transactions:db.transactions,statements:db.statements,merchants:db.merchants});
C.fromBackup=o=>({settings:{...C.defaultSettings(),...o.settings},bills:o.bills||{},transactions:o.transactions||{},statements:o.statements||{},merchants:o.merchants||{}});

root.BudgetCore=C;
})(typeof window!=='undefined'?window:globalThis);
