// E-commerce with Server-Side Rendering: every page is built as HTML on the server (Express) and sent ready to display.
const express=require('express'),{Pool}=require('pg'),crypto=require('crypto'),path=require('path'),fs=require('fs');
// Load a local .env file if present (for running on your own computer; on Render use the Environment tab instead)
try{for(const l of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^["']|["']$/g,'')}}catch(e){}
const SHOP=process.env.SHOP_NAME||'Metro Gear',PROD=process.env.NODE_ENV=='production',PORT=process.env.PORT||3000;
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
async function initDb(){
 await db.query(`
CREATE TABLE IF NOT EXISTS products(id SERIAL PRIMARY KEY,name TEXT NOT NULL,description TEXT,price REAL NOT NULL,stock INTEGER NOT NULL DEFAULT 0,image_url TEXT,status TEXT NOT NULL DEFAULT 'active',category TEXT NOT NULL DEFAULT 'General',purchase_price REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders(id SERIAL PRIMARY KEY,token TEXT UNIQUE,customer_name TEXT,email TEXT,phone TEXT,address TEXT,total REAL,payment TEXT DEFAULT 'KHQR',payment_status TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS order_items(id SERIAL PRIMARY KEY,order_id INTEGER,product_id INTEGER,name TEXT,price REAL,qty INTEGER);
CREATE TABLE IF NOT EXISTS carts(cid TEXT,product_id INTEGER,qty INTEGER,PRIMARY KEY(cid,product_id));
CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY,name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,email TEXT NOT NULL,created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS product_images(id SERIAL PRIMARY KEY,product_id INTEGER NOT NULL,url TEXT NOT NULL,sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS expenses(id SERIAL PRIMARY KEY,title TEXT NOT NULL,amount NUMERIC(10,2) NOT NULL DEFAULT 0,expense_date DATE NOT NULL DEFAULT CURRENT_DATE,created_at TIMESTAMPTZ DEFAULT NOW());`);
 const{rows}=await db.query('SELECT COUNT(*) c FROM products');
 if(!Number(rows[0].c)){
  const seed=[['Laptop Pro 15','Fast 15-inch laptop with 16GB RAM, 512GB SSD and a sharp Retina display. Great for study, work and design.',999,5,'laptop','Electronics',780],['Wireless Earbuds','Noise-cancelling earbuds with a charging case that has a touch display. Up to 20 hours of battery in total.',45,30,'earbuds','Electronics',28],['Phone Case','Shock-proof silicone case with sparkly 3D flower decoration. Fits most modern phones.',9.5,100,'case','Accessories',4],['Cotton T-Shirt','Soft 180gsm classic cotton T-shirt. Comfortable for every day, available in five colours.',14,40,'tshirt','Clothing',7],['Running Shoes','Lightweight running shoes with a cushioned sole and a grippy outsole for roads and trails.',65,12,'shoes','Clothing',38],['Kampot Pepper 100g','Famous Cambodian fermented Kampot black pepper, vacuum packed to keep it fresh. 100g.',6,60,'pepper','Food',3],['Coffee Beans 500g','Medium roast whole coffee beans, locally grown and small-batch roasted. 500g.',18,3,'coffee','Food',11],['Backpack','Water-resistant travel backpack with a laptop sleeve and many compartments for your essentials.',32,20,'backpack','Accessories',19]];
  for(const p of seed)await db.query('INSERT INTO products(name,description,price,stock,image_url,category,purchase_price) VALUES($1,$2,$3,$4,$5,$6,$7)',[p[0],p[1],p[2],p[3],'/img/'+p[4]+'.webp',p[5],p[6]]);
 }
}
initDb().then(()=>seedAdmin()).catch(e=>{console.error('Database init failed:',e);process.exit(1)});
/* ---------- helpers ---------- */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),M=n=>'$'+Number(n).toFixed(2),r2=n=>Math.round(n*100)/100;
const int=(v,d=0)=>{const n=parseInt(v,10);return Number.isFinite(n)?n:d};
const cookie=(req,k)=>(req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).find(a=>a[0]==k)?.[1];
const setCookie=(res,k,v,o)=>res.append('Set-Cookie',`${k}=${v}; HttpOnly; Path=/; ${o}${PROD?'; Secure':''}`);
const fmt=iso=>new Date(iso).toLocaleString('en-GB',{timeZone:process.env.SHOP_TZ||'Asia/Phnom_Penh',dateStyle:'medium',timeStyle:'short'});
const flash=req=>req.query.msg?`<p class="flash" role="status">${esc(req.query.msg)}</p>`:'';
const stockTxt=s=>s<=0?'<span class="bad">Out of stock</span>':'<span class="ok">In stock</span>';
async function cartItems(cid){const{rows}=await db.query("SELECT p.*,c.qty FROM carts c JOIN products p ON p.id=c.product_id WHERE c.cid=$1 AND p.status='active' ORDER BY p.id",[cid]);return rows}
const sum=it=>r2(it.reduce((a,i)=>a+i.price*i.qty,0));
async function mergeGuestCart(guestCid,email){const key='u:'+email;if(guestCid===key)return;
 const{rows:items}=await db.query('SELECT product_id,qty FROM carts WHERE cid=$1',[guestCid]);
 for(const i of items){
  const{rows:pRows}=await db.query('SELECT stock FROM products WHERE id=$1',[i.product_id]);
  const stock=pRows[0]?.stock||0;
  const{rows:cRows}=await db.query('SELECT qty FROM carts WHERE cid=$1 AND product_id=$2',[key,i.product_id]);
  const have=cRows[0]?.qty||0;
  const qty=Math.min(stock,have+i.qty);
  if(qty>0)await db.query('INSERT INTO carts VALUES($1,$2,$3) ON CONFLICT(cid,product_id) DO UPDATE SET qty=EXCLUDED.qty',[key,i.product_id,qty])}
 await db.query('DELETE FROM carts WHERE cid=$1',[guestCid])}

/* ---------- accounts & sessions ---------- */
const pwHash=(pw,salt)=>crypto.scryptSync(String(pw),salt,32).toString('hex');
const SESSION_MS=288e5;
async function startSession(res,email){const tk=crypto.randomBytes(24).toString('hex');
 await db.query('INSERT INTO sessions(token,email,created) VALUES($1,$2,$3)',[tk,email,Date.now()]);
 setCookie(res,'sid',tk,'SameSite=Lax; Max-Age=28800');return tk}
async function loadUser(req){const t=cookie(req,'sid');if(!t)return null;
 const{rows:sRows}=await db.query('SELECT * FROM sessions WHERE token=$1',[t]);
 const s=sRows[0];
 if(!s||Date.now()-Number(s.created)>SESSION_MS)return null;
 const{rows:uRows}=await db.query('SELECT email,name,role FROM users WHERE email=$1',[s.email]);
 return uRows[0]||null}
const requireAdmin=(req,res,next)=>req.user?.role=='admin'?next():res.redirect('/login?msg='+encodeURIComponent('Admins only')+'&next=/admin/dashboard');
async function seedAdmin(){
 const{rows}=await db.query("SELECT 1 FROM users WHERE role='admin'");
 if(rows.length)return;
 const email=(process.env.ADMIN_USER||'admin').includes('@')?process.env.ADMIN_USER:(process.env.ADMIN_USER||'admin')+'@'+SHOP.toLowerCase().replace(/[^a-z0-9]+/g,'')+'.local';
 const pass=process.env.ADMIN_PASSWORD||'admin123';
 if(!process.env.ADMIN_PASSWORD)console.warn('WARNING: default admin password in use. Set ADMIN_PASSWORD before going public.');
 const salt=crypto.randomBytes(16).toString('hex');
 await db.query('INSERT INTO users(email,name,salt,hash,role) VALUES($1,$2,$3,$4,$5)',[email,'Admin',salt,pwHash(pass,salt),'admin']);
 console.log('Admin account ready:',email)}

const page=(req,title,body,head='')=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ${esc(SHOP)}</title><link rel="stylesheet" href="/style.css">${head}</head><body>
<header><div class="wrap"><a class="brand" href="/" style="display:inline-flex;align-items:center;gap:10px"><img src="/img/Metro%20Gear.png" alt="${esc(SHOP)}" style="height:40px;width:auto;max-height:40px;object-fit:contain;border-radius:6px;display:inline-block;vertical-align:middle"><span>${esc(SHOP)}</span></a><nav><a href="/">Home</a><a href="/cart">Cart (${req.cartCount})</a>${req.user?(req.user.role=='admin'?`<a href="/admin/dashboard">Admin panel</a>`:`<a href="/my-orders">My Orders</a>`)+`<form method="post" action="/logout" style="margin:0"><button>Log out (${esc(req.user.name)})</button></form>`:`<a href="/login">Log in</a>`}</nav></div></header><main class="wrap">${flash(req)}${body}</main><footer class="wrap">&copy; ${esc(SHOP)}</footer></body></html>`;
const apage=(req,title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} | Admin</title><link rel="stylesheet" href="/style.css"></head><body>
<header class="no-print"><div class="wrap"><a class="brand" href="/admin/dashboard"><img src="/img/Metro%20Gear.png" alt="${esc(SHOP)}" style="height:40px;width:auto;max-height:40px;object-fit:contain;border-radius:6px;display:inline-block;vertical-align:middle"> Admin</a><nav><a href="/admin/dashboard">Dashboard</a><a href="/admin/products">Products</a><a href="/admin/orders">Order history</a><a href="/admin/reports">Reports</a><a href="/" target="_blank" rel="noopener">View shop</a><form method="post" action="/logout" style="margin:0"><button>Log out</button></form></nav></div></header><main class="wrap">${flash(req)}${body}</main></body></html>`;

const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});next()});
app.use(express.static(path.join(__dirname,'public'),{maxAge:'1h'}));app.use(express.urlencoded({extended:false,limit:'15mb'}));
app.use(async(req,res,next)=>{try{let c=cookie(req,'cid');if(!/^[a-f0-9]{32}$/.test(c||'')){c=crypto.randomBytes(16).toString('hex');setCookie(res,'cid',c,'SameSite=Lax; Max-Age=2592000')}
 req.cid=c;req.user=await loadUser(req);req.ck=req.user?'u:'+req.user.email:c;
 const{rows}=await db.query('SELECT COALESCE(SUM(qty),0) n FROM carts WHERE cid=$1',[req.ck]);
 req.cartCount=Number(rows[0].n);next()}catch(e){next(e)}});

/* ---------- PUBLIC PAGES ---------- */
const card=p=>`<article class="card"><a href="/product/${p.id}"><img src="${esc(p.image_url||'/img/none.svg')}" alt="${esc(p.name)}" loading="lazy"></a><h3><a href="/product/${p.id}">${esc(p.name)}</a></h3><p class="mut">${esc((p.description||'').slice(0,90))}${(p.description||'').length>90?'…':''}</p><div class="price">${M(p.price)}</div><div>${stockTxt(p.stock)}</div>
<div class="row"><a class="btn ghost" href="/product/${p.id}">View Details</a><form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}"><input type="hidden" name="qty" value="1"><button ${p.stock>0?'':'disabled'}>Add to Cart</button></form></div></article>`;
app.get('/',async(req,res,next)=>{try{const q=String(req.query.q||'').trim(),cat=String(req.query.cat||'').trim(),sort=String(req.query.sort||'new');
 const maxRaw=String(req.query.max||'').trim(),max=maxRaw!==''?Number(maxRaw):NaN;
 const{rows:catRows}=await db.query("SELECT DISTINCT category FROM products WHERE status='active' ORDER BY category");
 const cats=catRows.map(r=>r.category);
 const where=["status='active'"],args=[];
 if(q){args.push('%'+q+'%','%'+q+'%');where.push(`(name ILIKE $${args.length-1} OR description ILIKE $${args.length})`)}
 if(cat){args.push(cat);where.push(`category=$${args.length}`)}
 if(Number.isFinite(max)&&max>=0){args.push(max);where.push(`price<=$${args.length}`)}
 const order={new:'id DESC',low:'price ASC',high:'price DESC'}[sort]||'id DESC';
 const{rows:l}=await db.query(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY ${order}`,args);
 const qs=k=>esc(k=='q'?q:k=='cat'?cat:k=='max'?(maxRaw!==''&&Number.isFinite(max)?max:''):sort);
 const bar=`<form class="bar" method="get" action="/"><input type="search" name="q" placeholder="Search products" aria-label="Search" value="${qs('q')}">
<select name="cat" aria-label="Category" onchange="this.form.submit()"><option value="">All categories</option>${cats.map(c=>`<option value="${esc(c)}" ${cat==c?'selected':''}>${esc(c)}</option>`).join('')}</select>
<input type="number" name="max" min="0" step="0.01" placeholder="Max price $" aria-label="Max price" value="${qs('max')}" style="width:130px">
<select name="sort" aria-label="Sort" onchange="this.form.submit()"><option value="new" ${sort=='new'?'selected':''}>Newest</option><option value="low" ${sort=='low'?'selected':''}>Price: low to high</option><option value="high" ${sort=='high'?'selected':''}>Price: high to low</option></select>
<button class="btn ghost">Apply</button></form>`;
 res.send(page(req,'Home',`<h1>Our products</h1>${bar}<div class="grid">${l.map(card).join('')||'<p>No products match. Clear a filter and try again.</p>'}</div>`,`<meta name="description" content="Shop online at ${esc(SHOP)}">`))
}catch(e){next(e)}});

async function productImages(id,cover){const{rows}=await db.query('SELECT url FROM product_images WHERE product_id=$1 ORDER BY sort,id',[id]);
 return[...new Set([cover,...rows.map(r=>r.url)].filter(Boolean))]}
app.get('/product/:id',async(req,res,next)=>{try{
 const{rows}=await db.query("SELECT * FROM products WHERE id=$1 AND status='active'",[int(req.params.id)]);
 const p=rows[0];if(!p)return notFound(req,res);
 const url=(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`)+'/product/'+p.id,img=p.image_url?(/^https?:/.test(p.image_url)?p.image_url:(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`)+p.image_url):'',u=encodeURIComponent(url);
 const imgs=await productImages(p.id,p.image_url);if(!imgs.length)imgs.push('/img/none.svg');
 res.send(page(req,p.name,`<p><a href="/">&larr; Back to products</a></p><div class="two"><div><img id="mainImg" src="${esc(imgs[0])}" alt="${esc(p.name)}" style="width:100%;border-radius:10px;aspect-ratio:1/1;object-fit:cover">
${imgs.length>1?`<div class="row" style="margin-top:8px">${imgs.map(u2=>`<img src="${esc(u2)}" alt="" class="thumb gthumb" style="width:56px;height:56px;cursor:pointer" onclick="document.getElementById('mainImg').src=this.src">`).join('')}</div>`:''}
</div><div>
<h1>${esc(p.name)}</h1><span class="tag">${esc(p.category||'General')}</span><div class="price" style="font-size:26px">${M(p.price)}</div><p>${stockTxt(p.stock)}</p><p style="white-space:pre-line">${esc(p.description)}</p>
<form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}"><label for="q">Quantity</label><div class="row"><input id="q" type="number" name="qty" value="1" min="1" max="${Math.max(1,p.stock)}" ${p.stock>0?'':'disabled'}><button class="acc" ${p.stock>0?'':'disabled'}>Add to Cart</button></div></form>
<h2>Share this product</h2><div class="row"><a class="btn fb" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${u}">Share on Facebook</a><a class="btn tg" target="_blank" rel="noopener" href="https://t.me/share/url?url=${u}&text=${encodeURIComponent(p.name)}">Share on Telegram</a></div></div></div>`,
 `<meta name="description" content="${esc((p.description||'').slice(0,150))}"><meta property="og:type" content="product"><meta property="og:title" content="${esc(p.name)}"><meta property="og:description" content="${esc((p.description||'').slice(0,150))}"><meta property="og:url" content="${esc(url)}">${img?`<meta property="og:image" content="${esc(img)}">`:''}<link rel="canonical" href="${esc(url)}">`))
}catch(e){next(e)}});

app.post('/cart/add',async(req,res,next)=>{try{
 const{rows}=await db.query("SELECT * FROM products WHERE id=$1 AND status='active'",[int(req.body.id)]);
 const p=rows[0];
 if(!p||p.stock<1)return res.redirect('/cart?msg='+encodeURIComponent('That product is not available'));
 const{rows:cRows}=await db.query('SELECT qty FROM carts WHERE cid=$1 AND product_id=$2',[req.ck,p.id]);
 const have=cRows[0]?.qty||0,qty=Math.min(p.stock,have+Math.max(1,int(req.body.qty,1)));
 await db.query('INSERT INTO carts VALUES($1,$2,$3) ON CONFLICT(cid,product_id) DO UPDATE SET qty=EXCLUDED.qty',[req.ck,p.id,qty]);
 res.redirect('/cart?msg='+encodeURIComponent(qty<have+int(req.body.qty,1)?'Added. Limited stock available.':'Added to cart'))
}catch(e){next(e)}});
app.post('/cart/update',async(req,res,next)=>{try{
 const{rows}=await db.query('SELECT stock FROM products WHERE id=$1',[int(req.body.id)]);
 const p=rows[0],q=int(req.body.qty);
 if(!p||q<1)await db.query('DELETE FROM carts WHERE cid=$1 AND product_id=$2',[req.ck,int(req.body.id)]);
 else await db.query('UPDATE carts SET qty=$1 WHERE cid=$2 AND product_id=$3',[Math.min(q,p.stock),req.ck,int(req.body.id)]);
 res.redirect('/cart?msg=Cart+updated')
}catch(e){next(e)}});
app.post('/cart/remove',async(req,res,next)=>{try{
 await db.query('DELETE FROM carts WHERE cid=$1 AND product_id=$2',[req.ck,int(req.body.id)]);
 res.redirect('/cart?msg=Item+removed')
}catch(e){next(e)}});
app.get('/cart',async(req,res,next)=>{try{
 const it=await cartItems(req.ck);
 res.send(page(req,'Cart',`<h1>Your cart</h1>`+(it.length?`<div class="tw"><table><tr><th>Product</th><th>Unit price</th><th>Quantity</th><th>Subtotal</th><th></th></tr>${it.map(i=>`<tr><td><a href="/product/${i.id}">${esc(i.name)}</a></td><td>${M(i.price)}</td>
<td><form method="post" action="/cart/update" class="row" style="margin:0"><input type="hidden" name="id" value="${i.id}"><input type="number" name="qty" value="${i.qty}" min="0" max="${i.stock}" aria-label="Quantity for ${esc(i.name)}"><button class="btn ghost" style="color:var(--ink)">Update</button></form></td><td>${M(i.price*i.qty)}</td>
<td><form method="post" action="/cart/remove" style="margin:0"><input type="hidden" name="id" value="${i.id}"><button class="del">Remove</button></form></td></tr>`).join('')}<tr><th colspan="3">Total</th><th colspan="2" class="price">${M(sum(it))}</th></tr></table></div>
<div class="row"><a class="btn ghost" href="/">Continue shopping</a><a class="btn acc" href="/checkout">Proceed to Checkout</a></div>`:`<p>Your cart is empty. <a href="/">Browse products</a>.</p>`)))
}catch(e){next(e)}});

function checkoutPage(req,it,v={},errs=[]){const tot=sum(it);
 return page(req,'Checkout',`<h1>Checkout</h1>${errs.length?`<div class="err" role="alert"><b>Please check:</b><ul>${errs.map(e=>`<li>${esc(e)}</li>`).join('')}</ul></div>`:''}
<form method="post" action="/checkout" class="two"><div><h2>Your details</h2>
<label for="n">Full name</label><input id="n" name="name" required maxlength="100" autocomplete="name" value="${esc(v.name)}">
<label for="p">Phone number</label><input id="p" type="tel" name="phone" required maxlength="20" autocomplete="tel" value="${esc(v.phone)}">
<label for="a">Shipping address</label><textarea id="a" name="address" rows="3" required maxlength="300" autocomplete="street-address">${esc(v.address)}</textarea></div>
<div><h2>Order summary</h2><div class="card">${it.map(i=>`<div class="row" style="justify-content:space-between;margin:0 0 6px"><span>${esc(i.name)} &times; ${i.qty}</span><span>${M(i.price*i.qty)}</span></div>`).join('')}<div class="row price" style="justify-content:space-between"><span>Total</span><span>${M(tot)}</span></div></div>
<p class="mut">Pressing the button below saves your order and opens Telegram with your order details pre-filled, so you can send it to us to arrange payment and delivery.</p>
<button class="acc" style="width:100%;margin-top:14px">Order via Telegram</button></div></form>`)}
app.get('/checkout',async(req,res,next)=>{try{
 const it=await cartItems(req.ck);if(!it.length)return res.redirect('/cart?msg=Your+cart+is+empty');
 const v=req.user?{name:req.user.name}:{};
 res.send(checkoutPage(req,it,v,[]))
}catch(e){next(e)}});
function telegramInvoiceText(o,it){
 return[`New order #${o.id} - ${SHOP}`,`Name: ${o.customer_name}`,`Phone: ${o.phone}`,`Address: ${o.address}`,'','Items:',
  ...it.map(i=>`- ${i.name} x${i.qty} @ ${M(i.price)} = ${M(i.price*i.qty)}`),'',`Total: ${M(o.total)}`].join('\n')}
app.post('/checkout',async(req,res,next)=>{try{
 const it=await cartItems(req.ck);if(!it.length)return res.redirect('/cart?msg=Your+cart+is+empty');
 const b=req.body,v={name:String(b.name||'').trim(),phone:String(b.phone||'').trim(),address:String(b.address||'').trim()},errs=[];
 if(v.name.length<2||v.name.length>100)errs.push('Enter your full name');
 if(!/^\+?[0-9 ()-]{6,20}$/.test(v.phone))errs.push('Enter a valid phone number');if(v.address.length<5||v.address.length>300)errs.push('Enter your shipping address');
 if(errs.length)return res.status(400).send(checkoutPage(req,it,v,errs));
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const{rows:cur}=await client.query("SELECT p.*,c.qty FROM carts c JOIN products p ON p.id=c.product_id WHERE c.cid=$1 AND p.status='active' ORDER BY p.id",[req.ck]);
  if(!cur.length)throw new Error('Your cart is empty');
  for(const i of cur){const{rows:sRows}=await client.query('SELECT stock FROM products WHERE id=$1',[i.id]);const s=sRows[0]?.stock??0;if(i.qty>s)throw new Error(`${i.name}: not enough stock available`)}
  const t=crypto.randomBytes(16).toString('hex'),total=sum(cur),email=req.user?.email||'';
  const{rows:oRows}=await client.query('INSERT INTO orders(token,customer_name,email,phone,address,total,payment,payment_status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[t,v.name,email,v.phone,v.address,total,'Telegram','Pending',new Date().toISOString()]);
  const id=oRows[0].id;
  for(const i of cur){
   await client.query('INSERT INTO order_items(order_id,product_id,name,price,qty) VALUES($1,$2,$3,$4,$5)',[id,i.id,i.name,i.price,i.qty]);
   await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[i.qty,i.id]);
  }
  await client.query('DELETE FROM carts WHERE cid=$1',[req.ck]);
  await client.query('COMMIT');
  const tgLink='https://t.me/NoyPiseth?text='+encodeURIComponent(telegramInvoiceText({id,customer_name:v.name,phone:v.phone,address:v.address,total},cur));
  res.redirect(tgLink);
 }catch(e){
  await client.query('ROLLBACK');
  res.status(400).send(checkoutPage(req,await cartItems(req.ck),v,[e.message]));
 }finally{client.release()}
}catch(e){next(e)}});
app.get('/order/confirmation/:token',async(req,res,next)=>{try{
 const{rows:oRows}=await db.query('SELECT * FROM orders WHERE token=$1',[String(req.params.token)]);
 const o=oRows[0];if(!o)return notFound(req,res);
 const{rows:it}=await db.query('SELECT * FROM order_items WHERE order_id=$1',[o.id]);
 const tgLink='https://t.me/NoyPiseth?text='+encodeURIComponent(telegramInvoiceText(o,it));
 res.send(page(req,'Order confirmed',`<div class="success"><h1 style="margin:0">Thank you! Your order was placed successfully.</h1><p style="margin:6px 0 0">Press the button below to send your order details to us on Telegram so we can confirm payment and delivery.</p></div>
<div class="two" style="margin-top:20px"><div class="card"><h2 style="margin-top:0">Order #${o.id}</h2><p><b>Name:</b> ${esc(o.customer_name)}<br><b>Email:</b> ${esc(o.email)}<br><b>Phone:</b> ${esc(o.phone)}<br><b>Shipping address:</b> ${esc(o.address)}<br><b>Date:</b> ${fmt(o.created_at)}<br><b>Status:</b> ${esc(o.payment_status||'Pending')}</p></div>
<div class="card"><h2 style="margin-top:0">Items</h2>${it.map(i=>`<div class="row" style="justify-content:space-between;margin:0 0 6px"><span>${esc(i.name)} &times; ${i.qty}</span><span>${M(i.price*i.qty)}</span></div>`).join('')}<div class="row price" style="justify-content:space-between"><span>Total amount</span><span>${M(o.total)}</span></div></div></div>
<p><a class="btn acc" href="${tgLink}" target="_blank" rel="noopener">Send order on Telegram</a> <a class="btn ghost" href="/">Continue shopping</a></p>`))
}catch(e){next(e)}});

app.get('/my-orders',async(req,res,next)=>{try{if(!req.user)return res.redirect('/login?next=/my-orders');
 const{rows:l}=await db.query('SELECT * FROM orders WHERE email=$1 ORDER BY id DESC',[req.user.email]);
 res.send(page(req,'My orders',`<h1>My orders</h1><div class="tw"><table><tr><th>Order ID</th><th>Total</th><th>Payment</th><th>Order Date</th><th>Action</th></tr>${l.map(o=>`<tr><td>#${o.id}</td><td>${M(o.total)}</td><td>${esc(o.payment_status||'Pending verification')}</td><td>${fmt(o.created_at)}</td><td><a class="btn ghost" href="/my-orders/${o.id}">View Details</a></td></tr>`).join('')||'<tr><td colspan="5">No orders yet. <a href="/">Browse products</a>.</td></tr>'}</table></div>`))
}catch(e){next(e)}});
app.get('/my-orders/:id',async(req,res,next)=>{try{if(!req.user)return res.redirect('/login?next=/my-orders');
 const{rows:oRows}=await db.query('SELECT * FROM orders WHERE id=$1 AND email=$2',[int(req.params.id),req.user.email]);
 const o=oRows[0];if(!o)return notFound(req,res);
 const{rows:it}=await db.query('SELECT * FROM order_items WHERE order_id=$1',[o.id]);
 res.send(page(req,'Order #'+o.id,`<p><a href="/my-orders">&larr; Back to my orders</a></p><h1>Order #${o.id}</h1><div class="two"><div class="card"><h2 style="margin-top:0">Details</h2><p><b>Name:</b> ${esc(o.customer_name)}<br><b>Email:</b> ${esc(o.email)}<br><b>Phone:</b> ${esc(o.phone)}<br><b>Shipping address:</b> ${esc(o.address)}<br><b>Date:</b> ${fmt(o.created_at)}<br><b>Payment:</b> ${esc(o.payment)} (${esc(o.payment_status||'Pending verification')})</p></div>
<div class="card"><h2 style="margin-top:0">Items</h2>${it.map(i=>`<div class="row" style="justify-content:space-between;margin:0 0 6px"><span>${esc(i.name)} &times; ${i.qty}</span><span>${M(i.price*i.qty)}</span></div>`).join('')}<div class="row price" style="justify-content:space-between"><span>Total amount</span><span>${M(o.total)}</span></div></div></div>`))
}catch(e){next(e)}});

/* ---------- LOGIN / REGISTER (shared by customers and admin) ---------- */
const loginTries={};
const authPage=(req,title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ${esc(SHOP)}</title><link rel="stylesheet" href="/style.css"></head><body>
<header><div class="wrap"><a class="brand" href="/" style="display:inline-flex;align-items:center;gap:10px"><img src="/img/Metro%20Gear.png" alt="${esc(SHOP)}" style="height:40px;width:auto;max-height:40px;object-fit:contain;border-radius:6px;display:inline-block;vertical-align:middle"><span>${esc(SHOP)}</span></a><nav><a href="/">Home</a><a href="/cart">Cart (${req.cartCount})</a></nav></div></header><main class="wrap" style="max-width:420px">${flash(req)}${body}</main></body></html>`;
const loginForm=(req,err='')=>authPage(req,'Log in',`<h1>Log in</h1>${err?`<p class="err" role="alert">${esc(err)}</p>`:''}
<form method="post" action="/login" class="card"><input type="hidden" name="next" value="${esc(req.query.next||'')}">
<label for="e" style="margin-top:0">Email</label><input id="e" type="email" name="email" required autocomplete="username">
<label for="pw">Password</label><input id="pw" type="password" name="password" required autocomplete="current-password">
<p><button class="acc" style="width:100%">Log in</button></p></form>
<p><a href="/register${req.query.next?'?next='+encodeURIComponent(req.query.next):''}">No account? Register</a></p>`);
const registerForm=(req,err='')=>authPage(req,'Create account',`<h1>Create account</h1>${err?`<p class="err" role="alert">${esc(err)}</p>`:''}
<form method="post" action="/register" class="card"><input type="hidden" name="next" value="${esc(req.query.next||'')}">
<label for="n" style="margin-top:0">Full name</label><input id="n" name="name" required maxlength="100" autocomplete="name">
<label for="e">Email</label><input id="e" type="email" name="email" required autocomplete="username">
<label for="pw">Password</label><input id="pw" type="password" name="password" required minlength="6" autocomplete="new-password">
<p><button class="acc" style="width:100%">Register</button></p></form>
<p><a href="/login${req.query.next?'?next='+encodeURIComponent(req.query.next):''}">Have an account? Log in</a></p>`);
app.get('/login',(req,res)=>res.send(loginForm(req)));
app.post('/login',async(req,res,next)=>{try{const k=req.ip,t=loginTries[k]=(loginTries[k]||[]).filter(x=>Date.now()-x<9e5);if(t.length>=10)return res.status(429).send(loginForm(req,'Too many attempts. Try again in 15 minutes.'));
 const email=String(req.body.email||'').trim().toLowerCase();
 const{rows}=await db.query('SELECT * FROM users WHERE email=$1',[email]);
 const u=rows[0];
 if(!u||!crypto.timingSafeEqual(Buffer.from(pwHash(req.body.password||'',u.salt)),Buffer.from(u.hash))){t.push(Date.now());return res.status(401).send(loginForm(req,'Wrong email or password'))}
 await startSession(res,u.email);await mergeGuestCart(req.cid,u.email);const next=String(req.body.next||'');
 res.redirect(u.role=='admin'?'/admin/dashboard':(next&&next.startsWith('/')?next:'/'))
}catch(e){next(e)}});
app.get('/register',(req,res)=>res.send(registerForm(req)));
app.post('/register',async(req,res,next)=>{try{const email=String(req.body.email||'').trim().toLowerCase(),name=String(req.body.name||'').trim(),pw=String(req.body.password||'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).send(registerForm(req,'Enter a valid email address'));
 if(!name||name.length>100)return res.status(400).send(registerForm(req,'Enter your full name'));
 if(pw.length<6)return res.status(400).send(registerForm(req,'Use a password with 6 or more characters'));
 const{rows:existing}=await db.query('SELECT 1 FROM users WHERE email=$1',[email]);
 if(existing.length)return res.status(409).send(registerForm(req,'That email already has an account'));
 const salt=crypto.randomBytes(16).toString('hex');
 await db.query('INSERT INTO users(email,name,salt,hash,role) VALUES($1,$2,$3,$4,$5)',[email,name,salt,pwHash(pw,salt),'customer']);
 await startSession(res,email);await mergeGuestCart(req.cid,email);const next=String(req.body.next||'');res.redirect(next&&next.startsWith('/')?next:'/')
}catch(e){next(e)}});
app.post('/logout',async(req,res,next)=>{try{const t=cookie(req,'sid');if(t)await db.query('DELETE FROM sessions WHERE token=$1',[t]);setCookie(res,'sid','','SameSite=Lax; Max-Age=0');res.redirect('/')
}catch(e){next(e)}});

/* ---------- ADMIN ---------- */
app.use('/admin',requireAdmin);
app.get('/admin',(req,res)=>res.redirect('/admin/dashboard'));
app.get('/admin/dashboard',async(req,res,next)=>{try{
 const{rows:orders}=await db.query('SELECT * FROM orders ORDER BY id DESC');
 const sales=r2(orders.reduce((a,o)=>a+o.total,0));
 const{rows:costRows}=await db.query('SELECT oi.qty,p.purchase_price FROM order_items oi JOIN products p ON p.id=oi.product_id');
 const cost=r2(costRows.reduce((a,r)=>a+r.qty*r.purchase_price,0));
 const profit=r2(sales-cost);
 const customers=new Set(orders.map(o=>o.email)).size;
 const{rows:low}=await db.query("SELECT * FROM products WHERE status='active' AND stock<=5 ORDER BY stock");
 const pending=orders.filter(o=>o.payment_status!='Paid').slice(0,8);
 const{rows:invRows}=await db.query("SELECT COUNT(*)::int total_products,COALESCE(SUM(stock),0)::int total_units,COALESCE(SUM(price*stock),0) stock_value,COALESCE(SUM(purchase_price*stock),0) import_cost FROM products");
 const inv=invRows[0];
 res.send(apage(req,'Dashboard',`<h1>Admin panel</h1>
<div class="grid"><div class="card"><div class="mut">Total selling (sales)</div><div class="price">${M(sales)}</div></div><div class="card"><div class="mut">Total purchasing (cost)</div><div class="price">${M(cost)}</div></div>
<div class="card"><div class="mut">Profit</div><div class="price">${M(profit)}</div></div><div class="card"><div class="mut">Orders</div><div class="price">${orders.length}</div></div>
<div class="card"><div class="mut">Customers</div><div class="price">${customers}</div></div><div class="card"><div class="mut">Low stock items</div><div class="price ${low.length?'bad':''}">${low.length}</div></div>
<div class="card"><div class="mut">Total Products</div><div class="price">${inv.total_products}</div></div><div class="card"><div class="mut">Total Units</div><div class="price">${inv.total_units}</div></div>
<div class="card"><div class="mut">Total Stock Value</div><div class="price">${M(inv.stock_value)}</div></div><div class="card"><div class="mut">Total Import Cost</div><div class="price">${M(inv.import_cost)}</div></div></div>
<h2>Orders to process</h2>${pending.length?`<div class="tw"><table><tr><th>Order ID</th><th>Customer</th><th>Total</th><th>Payment</th></tr>${pending.map(o=>`<tr><td><a href="/admin/orders/${o.id}">#${o.id}</a></td><td>${esc(o.customer_name)}</td><td>${M(o.total)}</td><td>${esc(o.payment_status||'Pending verification')}</td></tr>`).join('')}</table></div>`:'<p class="mut">Nothing waiting.</p>'}`))
}catch(e){next(e)}});

app.get('/admin/products',async(req,res,next)=>{try{
 const{rows:l}=await db.query('SELECT * FROM products ORDER BY id');
 res.send(apage(req,'Products',`<div class="row" style="justify-content:space-between;margin:0 0 12px"><h1 style="margin:0">Products</h1><a class="btn acc" href="/admin/products/new">+ Add New Product</a></div><div class="tw"><table><tr><th>ID</th><th>Name</th><th>Category</th><th>Purchase</th><th>Price</th><th>Margin</th><th>Stock</th><th>Status</th><th>Actions</th></tr>${l.map(p=>{const margin=p.price>0?Math.round((1-p.purchase_price/p.price)*100):0;return`<tr><td>${p.id}</td><td><div class="row" style="margin:0;flex-wrap:nowrap"><img class="thumb" src="${esc(p.image_url||'/img/none.svg')}" alt=""><span>${esc(p.name)}</span></div></td><td><span class="tag">${esc(p.category||'General')}</span></td><td>${M(p.purchase_price)}</td><td>${M(p.price)}</td><td>${margin}%</td><td class="${p.stock<=5?'bad':''}">${p.stock}</td><td><span class="tag">${p.status=='active'?'Active':'Inactive'}</span></td>
<td><div class="row" style="margin:0"><a class="btn ghost" href="/admin/products/${p.id}/edit">Edit</a><form method="post" action="/admin/products/${p.id}/delete" style="margin:0" onsubmit="return confirm('Delete ${esc(p.name).replace(/'/g,'')}?')"><button class="del">Delete</button></form></div></td></tr>`}).join('')||'<tr><td colspan="9">No products yet.</td></tr>'}</table></div>`))
}catch(e){next(e)}});
const pform=(req,p,action,title,errs=[])=>apage(req,title,`<h1>${title}</h1>${errs.length?`<div class="err" role="alert"><ul>${errs.map(e=>`<li>${esc(e)}</li>`).join('')}</ul></div>`:''}<form method="post" action="${action}" class="card" style="max-width:640px">
<label for="n" style="margin-top:0">Name</label><input id="n" name="name" required maxlength="120" value="${esc(p.name)}"><label for="d">Description</label><textarea id="d" name="description" rows="5" maxlength="2000">${esc(p.description)}</textarea>
<label for="c">Category</label><input id="c" name="category" maxlength="40" placeholder="e.g. Electronics" value="${esc(p.category||'')}">
<label for="pp">Purchase price ($)</label><input id="pp" type="number" name="purchase_price" step="0.01" min="0" value="${esc(p.purchase_price??0)}" style="width:100%">
<label for="pr">Price ($)</label><input id="pr" type="number" name="price" step="0.01" min="0" required value="${esc(p.price)}" style="width:100%"><label for="s">Stock quantity</label><input id="s" type="number" name="stock" min="0" step="1" required value="${esc(p.stock)}" style="width:100%">
<label for="i">Main image</label><input id="i" name="image_url" placeholder="https://... or /img/laptop.webp" value="${esc(p.image_url)}">
<input type="file" accept="image/*" aria-label="Upload main image" onchange="const f=this.files[0];if(f){const r=new FileReader();r.onload=()=>{document.getElementById('i').value=r.result};r.readAsDataURL(f)}">
<p class="mut" style="margin:4px 0 0">Choose a photo to upload it (stored in the database, so it survives redeploys), or type an image URL above. Max 1MB per photo.</p>
<label for="ei">Additional images (one per line, optional)</label><textarea id="ei" name="extra_images" rows="4" placeholder="https://...&#10;/img/laptop-2.webp">${esc((p.extra_images||[]).join('\n'))}</textarea>
<input type="file" accept="image/*" multiple aria-label="Upload additional images" onchange="for(const f of this.files){const r=new FileReader();r.onload=()=>{const t=document.getElementById('ei');t.value=(t.value?t.value+'\n':'')+r.result};r.readAsDataURL(f)}">
<label for="st">Status</label><select id="st" name="status"><option value="active" ${p.status!='inactive'?'selected':''}>Active (visible in shop)</option><option value="inactive" ${p.status=='inactive'?'selected':''}>Inactive (hidden)</option></select>
<div class="row"><button class="acc">Save</button><a class="btn ghost" href="/admin/products">Cancel</a></div></form>`);
const MAX_IMAGE_BYTES=1024*1024;
const isImageRef=u=>/^https?:\/\//i.test(u)||/^\//.test(u)||/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(u);
const imageTooBig=u=>{if(!/^data:/i.test(u))return false;const b64=u.slice(u.indexOf(',')+1);return b64.length*0.75>MAX_IMAGE_BYTES};
function readProd(b){const p={name:String(b.name||'').trim(),description:String(b.description||'').trim(),category:String(b.category||'').trim()||'General',price:Number(b.price),purchase_price:Number(b.purchase_price||0),stock:Number(b.stock),image_url:String(b.image_url||'').trim(),status:b.status=='inactive'?'inactive':'active',
  extra_images:String(b.extra_images||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).slice(0,8)},e=[];
 if(!p.name||p.name.length>120)e.push('Name is required (max 120 characters)');if(p.description.length>2000)e.push('Description is too long');if(p.category.length>40)e.push('Category is too long');
 if(!(p.price>=0)||p.price>1e6)e.push('Price must be 0 or more');if(!(p.purchase_price>=0)||p.purchase_price>1e6)e.push('Purchase price must be 0 or more');if(!Number.isInteger(p.stock)||p.stock<0)e.push('Stock must be a whole number, 0 or more');
 if(p.image_url){if(!isImageRef(p.image_url))e.push('Main image must be an uploaded photo or a URL starting with http://, https:// or /');else if(imageTooBig(p.image_url))e.push('Main image is too large (max 1MB)')}
 for(const u of p.extra_images){if(!isImageRef(u))e.push('Each additional image must be an uploaded photo or a URL starting with http://, https:// or /');else if(imageTooBig(u))e.push('An additional image is too large (max 1MB)')}
 return{p,e}}
async function saveExtraImages(id,urls){await db.query('DELETE FROM product_images WHERE product_id=$1',[id]);
 for(let i=0;i<urls.length;i++)await db.query('INSERT INTO product_images(product_id,url,sort) VALUES($1,$2,$3)',[id,urls[i],i])}
app.get('/admin/products/new',(req,res)=>res.send(pform(req,{status:'active',stock:0,category:'General',purchase_price:0},'/admin/products','Add New Product')));
app.post('/admin/products',async(req,res,next)=>{try{
 const{p,e}=readProd(req.body);if(e.length)return res.status(400).send(pform(req,p,'/admin/products','Add New Product',e));
 const{rows}=await db.query('INSERT INTO products(name,description,price,stock,image_url,status,category,purchase_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[p.name,p.description,p.price,p.stock,p.image_url,p.status,p.category,p.purchase_price]);
 await saveExtraImages(rows[0].id,p.extra_images);res.redirect('/admin/products?msg=Product+added')
}catch(e){next(e)}});
app.get('/admin/products/:id/edit',async(req,res,next)=>{try{
 const{rows}=await db.query('SELECT * FROM products WHERE id=$1',[int(req.params.id)]);
 const p=rows[0];if(!p)return notFound(req,res);
 const{rows:imgRows}=await db.query('SELECT url FROM product_images WHERE product_id=$1 ORDER BY sort,id',[p.id]);
 p.extra_images=imgRows.map(r=>r.url);
 res.send(pform(req,p,'/admin/products/'+p.id,'Edit Product #'+p.id))
}catch(e){next(e)}});
app.post('/admin/products/:id/delete',async(req,res,next)=>{try{
 const id=int(req.params.id);
 await db.query('DELETE FROM products WHERE id=$1',[id]);
 await db.query('DELETE FROM carts WHERE product_id=$1',[id]);
 await db.query('DELETE FROM product_images WHERE product_id=$1',[id]);
 res.redirect('/admin/products?msg=Product+deleted')
}catch(e){next(e)}});
app.post('/admin/products/:id',async(req,res,next)=>{try{
 const id=int(req.params.id);
 const{rows:existing}=await db.query('SELECT 1 FROM products WHERE id=$1',[id]);
 if(!existing.length)return notFound(req,res);
 const{p,e}=readProd(req.body);p.id=id;
 if(e.length)return res.status(400).send(pform(req,p,'/admin/products/'+id,'Edit Product #'+id,e));
 await db.query('UPDATE products SET name=$1,description=$2,price=$3,stock=$4,image_url=$5,status=$6,category=$7,purchase_price=$8 WHERE id=$9',[p.name,p.description,p.price,p.stock,p.image_url,p.status,p.category,p.purchase_price,id]);
 await saveExtraImages(id,p.extra_images);res.redirect('/admin/products?msg=Product+saved')
}catch(e){next(e)}});
app.get('/admin/orders',async(req,res,next)=>{try{
 const{rows:l}=await db.query('SELECT * FROM orders ORDER BY id DESC');
 res.send(apage(req,'Order history',`<h1>Order history</h1>
<div class="tw"><table><tr><th>Order ID</th><th>Customer Name</th><th>Phone Number</th><th>Total Amount</th><th>Status</th><th>Order Date</th><th>Action</th></tr>${l.map(o=>`<tr><td>#${o.id}</td><td>${esc(o.customer_name)}</td><td>${esc(o.phone)}</td><td>${M(o.total)}</td><td>${esc(o.payment_status||'Pending verification')}</td><td>${fmt(o.created_at)}</td><td><div class="row" style="margin:0"><a class="btn ghost" href="/admin/orders/${o.id}">View Order Details</a><a class="btn ghost" href="/admin/orders/${o.id}/invoice" target="_blank">Invoice</a><form method="post" action="/admin/orders/${o.id}/delete" onsubmit="return confirm('Delete order #${o.id}? This cannot be undone.')" style="margin:0"><button class="del">Delete</button></form></div></td></tr>`).join('')||'<tr><td colspan="7">No orders yet.</td></tr>'}</table></div>`))
}catch(e){next(e)}});
app.get('/admin/orders/:id',async(req,res,next)=>{try{
 const{rows:oRows}=await db.query('SELECT * FROM orders WHERE id=$1',[int(req.params.id)]);
 const o=oRows[0];if(!o)return notFound(req,res);
 const{rows:it}=await db.query('SELECT * FROM order_items WHERE order_id=$1',[o.id]);
 const statusOpts=['Pending','Paid','Completed','Cancelled'];
 res.send(apage(req,'Order #'+o.id,`<p><a href="/admin/orders">&larr; Back to order history</a></p><div class="row" style="justify-content:space-between"><h1 style="margin:0">Order #${o.id}</h1><div class="row" style="margin:0"><a class="btn acc" href="/admin/orders/${o.id}/invoice" target="_blank">Print Invoice</a><form method="post" action="/admin/orders/${o.id}/delete" onsubmit="return confirm('Delete order #${o.id}? This cannot be undone.')" style="margin:0"><button class="del">Delete Order</button></form></div></div><div class="two"><div class="card"><h2 style="margin-top:0">Customer</h2><p><b>Name:</b> ${esc(o.customer_name)}<br><b>Email:</b> ${esc(o.email)}<br><b>Phone:</b> ${esc(o.phone)}<br><b>Shipping address:</b> ${esc(o.address)}<br><b>Date:</b> ${fmt(o.created_at)}<br><b>Payment:</b> ${esc(o.payment)} (${esc(o.payment_status||'Pending verification')})</p>
<form method="post" action="/admin/orders/${o.id}/status" class="row"><label for="ps" style="margin:0">Payment status</label><select id="ps" name="payment_status">${statusOpts.map(s=>`<option value="${s}" ${(o.payment_status||'Pending')==s?'selected':''}>${s}</option>`).join('')}</select><button>Update</button></form></div>
<div class="card"><h2 style="margin-top:0">Purchased items</h2><div class="tw"><table><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Subtotal</th></tr>${it.map(i=>`<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${M(i.price)}</td><td>${M(i.price*i.qty)}</td></tr>`).join('')}<tr><th colspan="3">Total</th><th>${M(o.total)}</th></tr></table></div></div></div>`))
}catch(e){next(e)}});
app.post('/admin/orders/:id/status',async(req,res,next)=>{try{
 const id=int(req.params.id);
 const{rows:oRows}=await db.query('SELECT id FROM orders WHERE id=$1',[id]);
 if(!oRows[0])return notFound(req,res);
 const allowed=['Pending','Paid','Completed','Cancelled'];
 const status=allowed.includes(req.body.payment_status)?req.body.payment_status:'Pending';
 await db.query('UPDATE orders SET payment_status=$1 WHERE id=$2',[status,id]);
 res.redirect('/admin/orders/'+id+'?msg='+encodeURIComponent('Status updated'))
}catch(e){next(e)}});
app.post('/admin/orders/:id/delete',async(req,res,next)=>{try{
 const id=int(req.params.id);
 await db.query('DELETE FROM order_items WHERE order_id=$1',[id]);
 const{rowCount}=await db.query('DELETE FROM orders WHERE id=$1',[id]);
 if(!rowCount)return notFound(req,res);
 res.redirect('/admin/orders?msg='+encodeURIComponent('Order deleted'))
}catch(e){next(e)}});

function invoicePage(o,it){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Invoice #${o.id} | ${esc(SHOP)}</title><link rel="stylesheet" href="/style.css"></head><body>
<div class="wrap" style="max-width:720px;padding-top:24px">
<div class="row no-print" style="justify-content:flex-end"><button onclick="window.print()">Print</button><a class="btn ghost" href="/admin/orders/${o.id}">Back</a></div>
<div class="card">
<div class="row" style="justify-content:space-between;align-items:flex-start">
<div><h1 style="margin:0">${esc(SHOP)}</h1><p class="mut" style="margin:4px 0">${esc(process.env.MERCHANT_CITY||'Phnom Penh')}</p></div>
<div style="text-align:right"><h2 style="margin:0">INVOICE</h2><p class="mut" style="margin:4px 0">#${o.id}<br>${fmt(o.created_at)}</p></div>
</div>
<hr style="border:none;border-top:1px solid var(--line);margin:18px 0">
<div class="two">
<div><h3 style="margin-top:0">Bill to</h3><p style="margin:0">${esc(o.customer_name)}<br>${esc(o.email)}<br>${esc(o.phone)}<br>${esc(o.address)}</p></div>
<div style="text-align:right"><h3 style="margin-top:0">Payment</h3><p style="margin:0">Method: ${esc(o.payment)}<br>Status: ${esc(o.payment_status||'Pending verification')}</p></div>
</div>
<table style="margin-top:20px"><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Subtotal</th></tr>${it.map(i=>`<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${M(i.price)}</td><td>${M(i.price*i.qty)}</td></tr>`).join('')}<tr><th colspan="3" style="text-align:right">Total</th><th>${M(o.total)}</th></tr></table>
<p class="mut" style="margin-top:24px">Thank you for your purchase.</p>
</div></div></body></html>`}
app.get('/admin/orders/:id/invoice',async(req,res,next)=>{try{
 const{rows:oRows}=await db.query('SELECT * FROM orders WHERE id=$1',[int(req.params.id)]);
 const o=oRows[0];if(!o)return notFound(req,res);
 const{rows:it}=await db.query('SELECT * FROM order_items WHERE order_id=$1',[o.id]);
 res.send(invoicePage(o,it))
}catch(e){next(e)}});

const reportsReturnQs=req=>req.query.all=='1'?'all=1':(req.query.from&&req.query.to?`from=${encodeURIComponent(req.query.from)}&to=${encodeURIComponent(req.query.to)}`:'');
app.post('/admin/reports/expenses',async(req,res,next)=>{try{
 const title=String(req.body.title||'').trim(),amount=Number(req.body.amount),expense_date=String(req.body.expense_date||'').trim();
 await db.query('INSERT INTO expenses(title,amount,expense_date) VALUES($1,$2,$3)',[title,amount,expense_date||new Date().toISOString().slice(0,10)]);
 const qs=reportsReturnQs(req);
 res.redirect('/admin/reports'+(qs?'?'+qs:''))
}catch(e){next(e)}});
app.post('/admin/reports/expenses/:id/delete',async(req,res,next)=>{try{
 await db.query('DELETE FROM expenses WHERE id=$1',[int(req.params.id)]);
 const qs=reportsReturnQs(req);
 res.redirect('/admin/reports'+(qs?'?'+qs:''))
}catch(e){next(e)}});

app.get('/admin/reports',async(req,res,next)=>{try{
 const TZ=process.env.SHOP_TZ||'Asia/Phnom_Penh';
 const tzDate=d=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(d);
 const todayStr=tzDate(new Date());
 const todayD=new Date(todayStr+'T00:00:00Z');
 const mondayD=new Date(todayD);mondayD.setUTCDate(todayD.getUTCDate()-((todayD.getUTCDay()+6)%7));
 const weekFrom=mondayD.toISOString().slice(0,10);
 const monthFromDay=todayStr.slice(0,7)+'-01';
 const isAll=req.query.all=='1';
 const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''));
 const from=isAll?'':(validDate(req.query.from)?req.query.from:monthFromDay);
 const to=isAll?'':(validDate(req.query.to)?req.query.to:todayStr);
 const rangeDateCond=isAll?'':`AND (created_at::timestamptz AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`;
 const rangeDateCondO=isAll?'':`AND (o.created_at::timestamptz AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`;
 const rangeParams=isAll?[]:[TZ,from,to];
 const{rows:rangeRevRows}=await db.query(`SELECT COALESCE(SUM(total),0) rev,COUNT(*) n FROM orders WHERE payment_status IN ('Paid','Completed') ${rangeDateCond}`,rangeParams);
 const{rows:rangeCostRows}=await db.query(`SELECT COALESCE(SUM(oi.qty*p.purchase_price),0) cost FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE o.payment_status IN ('Paid','Completed') ${rangeDateCondO}`,rangeParams);
 const{rows:rangePendingRows}=await db.query(`SELECT COALESCE(SUM(total),0) total,COUNT(*) n FROM orders WHERE payment_status='Pending' ${rangeDateCond}`,rangeParams);
 const rangeRev=r2(rangeRevRows[0].rev),rangeCost=r2(rangeCostRows[0].cost),rangeProfit=r2(rangeRev-rangeCost),rangeOrders=Number(rangeRevRows[0].n);
 const rangePendingTotal=r2(rangePendingRows[0].total),rangePendingOrders=Number(rangePendingRows[0].n);
 const expenseDateCond=isAll?'':`WHERE expense_date BETWEEN $1::date AND $2::date`;
 const expenseParams=isAll?[]:[from,to];
 const{rows:expenses}=await db.query(`SELECT * FROM expenses ${expenseDateCond} ORDER BY expense_date DESC,id DESC`,expenseParams);
 const dateOnly=d=>d instanceof Date?d.toISOString().slice(0,10):String(d).slice(0,10);
 const expensesTotal=r2(expenses.reduce((a,e)=>a+Number(e.amount),0));
 const netProfit=r2(rangeRev-rangeCost-expensesTotal);
 const rangeLabel=isAll?'All time':`${esc(from)} to ${esc(to)}`;
 const exportQs=isAll?'all=1':`from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
 const dateFilterBar=`<form method="get" class="row no-print" style="margin-bottom:16px">
<a class="btn ghost" href="?from=${todayStr}&amp;to=${todayStr}">Today</a>
<a class="btn ghost" href="?from=${weekFrom}&amp;to=${todayStr}">This Week</a>
<a class="btn ghost" href="?from=${monthFromDay}&amp;to=${todayStr}">This Month</a>
<a class="btn ghost" href="?all=1">All Time</a>
<label for="from" style="margin:0">From</label><input id="from" type="date" name="from" value="${esc(from)}" onclick="this.showPicker?.()" ondblclick="this.showPicker?.()">
<label for="to" style="margin:0">To</label><input id="to" type="date" name="to" value="${esc(to)}" onclick="this.showPicker?.()" ondblclick="this.showPicker?.()">
<button>Apply</button>
<a class="btn ghost" href="/admin/reports/export?${exportQs}">Export Excel (CSV)</a>
<button type="button" onclick="window.print()">Export PDF</button>
</form>`;
 const{rows:perf}=await db.query(`SELECT p.id,p.name,p.category,p.image_url,
 COALESCE(SUM(oi.qty),0) pqty,
 COALESCE(SUM(oi.qty*oi.price),0) prev,
 COALESCE(SUM(oi.qty*p.purchase_price),0) pcost,
 COALESCE(SUM(oi.qty*(oi.price-p.purchase_price)),0) pprofit
 FROM products p JOIN order_items oi ON oi.product_id=p.id JOIN orders o ON o.id=oi.order_id
 WHERE o.payment_status IN ('Paid','Completed') ${rangeDateCondO}
 GROUP BY p.id HAVING COALESCE(SUM(oi.qty),0)>0 ORDER BY pqty DESC`,rangeParams);
 const perfTotals=perf.reduce((a,p)=>({qty:a.qty+Number(p.pqty),rev:a.rev+Number(p.prev),cost:a.cost+Number(p.pcost),profit:a.profit+Number(p.pprofit)}),{qty:0,rev:0,cost:0,profit:0});
 res.send(apage(req,'Reports',`<h1>Reports</h1>
${dateFilterBar}
<h2>${rangeLabel}</h2>
<div class="grid"><div class="card"><div class="mut">Revenue</div><div class="price">${M(rangeRev)}</div></div><div class="card"><div class="mut">Cost</div><div class="price">${M(rangeCost)}</div></div><div class="card"><div class="mut">Other Expenses</div><div class="price">${M(expensesTotal)}</div></div><div class="card"><div class="mut">Profit</div><div class="price">${M(netProfit)}</div></div><div class="card"><div class="mut">Orders</div><div class="price">${rangeOrders}</div></div><div class="card"><div class="mut">Pending (Telegram)</div><div class="price">${rangePendingOrders} / ${M(rangePendingTotal)}</div></div></div>
<h2 style="margin-top:28px">Product Sales Breakdown</h2>
${perf.length?`<div class="tw"><table><tr><th>Product Name</th><th>Category</th><th>Units Sold</th><th>Revenue</th><th>Cost</th><th>Profit</th></tr>${perf.map(p=>`<tr><td>${p.image_url?`<img src="${esc(p.image_url)}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px">`:`<span style="display:inline-block;width:36px;height:36px;border-radius:6px;vertical-align:middle;margin-right:8px;background:#eee"></span>`}${esc(p.name)}</td><td><span class="tag">${esc(p.category)}</span></td><td>${p.pqty}</td><td>${M(p.prev)}</td><td>${M(p.pcost)}</td><td>${M(p.pprofit)}</td></tr>`).join('')}<tfoot><tr style="font-weight:700"><td colspan="2">Total</td><td>${perfTotals.qty}</td><td>${M(perfTotals.rev)}</td><td>${M(perfTotals.cost)}</td><td>${M(perfTotals.profit)}</td></tr></tfoot></table></div>`:'<p class="mut">No product sales recorded in this period.</p>'}
<h2 style="margin-top:28px">Other Expenses</h2>
<form method="post" action="/admin/reports/expenses?${exportQs}" class="row no-print">
<label for="et" style="margin:0">Title</label><input id="et" name="title" required maxlength="120" placeholder="e.g., FB Boost, Packing">
<label for="ea" style="margin:0">Amount</label><input id="ea" type="number" name="amount" step="0.01" min="0" required style="width:120px">
<label for="ed" style="margin:0">Date</label><input id="ed" type="date" name="expense_date" value="${esc(todayStr)}" onclick="this.showPicker?.()" ondblclick="this.showPicker?.()">
<button>Add Expense</button>
</form>
${expenses.length?`<div class="tw"><table><tr><th>Date</th><th>Description</th><th>Amount</th><th></th></tr>${expenses.map(e=>`<tr><td>${esc(dateOnly(e.expense_date))}</td><td>${esc(e.title)}</td><td>${M(e.amount)}</td><td><form method="post" action="/admin/reports/expenses/${e.id}/delete" class="no-print" onsubmit="return confirm('Delete this expense?')" style="margin:0"><button class="del">Delete</button></form></td></tr>`).join('')}<tfoot><tr style="font-weight:700"><td colspan="2">Total</td><td>${M(expensesTotal)}</td><td></td></tr></tfoot></table></div>`:'<p class="mut">No expenses recorded in this period.</p>'}
`))
}catch(e){next(e)}});

app.get('/admin/reports/export',async(req,res,next)=>{try{
 const isAll=req.query.all=='1';
 const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''));
 const from=isAll?'':(validDate(req.query.from)?req.query.from:'');
 const to=isAll?'':(validDate(req.query.to)?req.query.to:'');
 if(!isAll&&(!from||!to))return res.status(400).send('Invalid from/to date');
 const TZ=process.env.SHOP_TZ||'Asia/Phnom_Penh';
 const rangeDateCondO=isAll?'':`AND (o.created_at::timestamptz AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`;
 const rangeParams=isAll?[]:[TZ,from,to];
 const{rows:perf}=await db.query(`SELECT p.id,p.name,p.category,
 COALESCE(SUM(oi.qty),0) pqty,
 COALESCE(SUM(oi.qty*oi.price),0) prev,
 COALESCE(SUM(oi.qty*p.purchase_price),0) pcost,
 COALESCE(SUM(oi.qty*(oi.price-p.purchase_price)),0) pprofit
 FROM products p JOIN order_items oi ON oi.product_id=p.id JOIN orders o ON o.id=oi.order_id
 WHERE o.payment_status IN ('Paid','Completed') ${rangeDateCondO}
 GROUP BY p.id HAVING COALESCE(SUM(oi.qty),0)>0 ORDER BY pqty DESC`,rangeParams);
 const perfTotals=perf.reduce((a,p)=>({qty:a.qty+Number(p.pqty),rev:a.rev+Number(p.prev),cost:a.cost+Number(p.pcost),profit:a.profit+Number(p.pprofit)}),{qty:0,rev:0,cost:0,profit:0});
 const expenseDateCond=isAll?'':`WHERE expense_date BETWEEN $1::date AND $2::date`;
 const expenseParams=isAll?[]:[from,to];
 const{rows:expenses}=await db.query(`SELECT * FROM expenses ${expenseDateCond} ORDER BY expense_date ASC,id ASC`,expenseParams);
 const expensesTotal=r2(expenses.reduce((a,e)=>a+Number(e.amount),0));
 const netProfit=r2(perfTotals.profit-expensesTotal);
 const csvCell=v=>`"${String(v).replace(/"/g,'""')}"`;
 const header=['Product Name','Category','Units Sold','Revenue','Cost','Profit'];
 const lines=[header.join(',')]
  .concat(perf.map(p=>[p.name,p.category,p.pqty,r2(p.prev),r2(p.pcost),r2(p.pprofit)].map(csvCell).join(',')))
  .concat([['Total','',perfTotals.qty,r2(perfTotals.rev),r2(perfTotals.cost),r2(perfTotals.profit)].map(csvCell).join(',')])
  .concat([''])
  .concat([['Other Expenses','','','','Amount'].join(',')])
  .concat(expenses.map(e=>[e.expense_date instanceof Date?e.expense_date.toISOString().slice(0,10):String(e.expense_date).slice(0,10),e.title,'','',r2(e.amount)].map(csvCell).join(',')))
  .concat([['Total Expenses','','','',r2(expensesTotal)].map(csvCell).join(',')])
  .concat([''])
  .concat([['Net Profit','','','',r2(netProfit)].map(csvCell).join(',')]);
 const fname=`sales-report-${isAll?'all-time':from+'_to_'+to}.csv`;
 res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${fname}"`});
 res.send('﻿'+lines.join('\r\n'))
}catch(e){next(e)}});

function notFound(req,res){res.status(404).send(page(req,'Not found','<h1>Page not found</h1><p><a href="/">Back to the shop</a></p>'))}
app.use((req,res)=>notFound(req,res));
app.use((err,req,res,next)=>{console.error(err);res.status(500).send(page(req,'Error','<h1>Something went wrong</h1><p><a href="/">Back to the shop</a></p>'))});
app.listen(PORT,()=>console.log(`${SHOP} running on port ${PORT}`));
