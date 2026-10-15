// /api/stripe-webhook.js
//
// Este es el "seguro de vida" del flujo de pago: Stripe llama a esta URL
// directamente desde SUS servidores (no desde el navegador del cliente)
// en cuanto un cobro se completa de verdad. Así, el pedido se marca como
// "pagado" en Firestore sin importar qué le pase al navegador del
// cliente después de pagar (que se cierre la pestaña, se vaya el
// internet, etc.) — antes, todo dependía de que el navegador del
// cliente terminara su trabajo, y si no lo hacía, el cliente quedaba
// cobrado sin ningún pedido registrado.
//
// CÓMO ACTIVARLO:
// 1) Sube este archivo a /api/stripe-webhook.js
// 2) Agrega "stripe" y "firebase-admin" a tu package.json (ver el archivo
//    que te dieron junto a este) y vuelve a desplegar.
// 3) En Vercel, agrega estas variables de entorno (aparte de las que ya
//    tenías):
//      STRIPE_WEBHOOK_SECRET = whsec_xxxxx  (te lo dio Stripe al crear el
//                               webhook en Dashboard > Developers > Webhooks)
//      FIREBASE_SERVICE_ACCOUNT_B64 = el archivo .json completo de cuenta
//                               de servicio de Firebase, codificado en
//                               Base64 (esto evita los errores de "llave
//                               privada mal pegada" que dan el típico
//                               error "DECODER routines::unsupported").
//      GMAIL_USER / GMAIL_APP_PASSWORD = las mismas que ya configuraste
//                               para send-status-email.js (se reutilizan
//                               aquí como respaldo, por si el correo desde
//                               el navegador del cliente nunca se mandó)
// 4) En Stripe Dashboard > Developers > Webhooks, confirma que los eventos
//    "payment_intent.succeeded" Y "payment_intent.payment_failed" estén
//    marcados para este endpoint.
//
// IMPORTANTE: este archivo necesita el cuerpo (body) de la petición SIN
// procesar, para poder verificar la firma de Stripe — por eso existe el
// "export const config" de abajo, que le dice a Vercel que no lo
// convierta a JSON automáticamente como hace con los demás endpoints.

import Stripe from 'stripe';
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { notifySellerLowStock } from './_lib/sellerLowStock.js';

export const config = {
  api: { bodyParser: false }
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// Normaliza FIREBASE_PRIVATE_KEY sin importar cómo se haya pegado en Vercel
// (respaldo, por si no se configuró FIREBASE_SERVICE_ACCOUNT_B64):
function normalizeFirebasePrivateKey(raw){
  if(!raw) return raw;
  let key = raw.trim();
  if((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))){
    key = key.slice(1, -1);
  }
  if(key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return key;
}

// MÉTODO PRINCIPAL: el archivo .json de cuenta de servicio completo,
// codificado en Base64 en una sola variable de entorno
// (FIREBASE_SERVICE_ACCOUNT_B64). Como nunca se pega/edita la llave a
// mano, es inmune a errores de copiado que rompen el formato PEM (el
// error "DECODER routines::unsupported" que daba antes).
function getServiceAccountCredentials(){
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if(b64){
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: json.private_key
    };
  }
  // Respaldo: las 3 variables sueltas (método anterior)
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: normalizeFirebasePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
  };
}

function getFirestore(){
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getServiceAccountCredentials())
    });
  }
  return admin.firestore();
}

async function readRawBody(readable){
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

let cachedTransporter = null;
function getMailer(){
  if(cachedTransporter) return cachedTransporter;
  if(!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  return cachedTransporter;
}

// [FIX — "me llega una cotización de pedido al comprar una membresía"]
// Este correo de respaldo tenía el texto de "¡Pedido confirmado y
// pagado!" fijo en el código, sin importar qué se hubiera comprado — así
// que una membresía de ZAYDE Club (que no es un "pedido" con envío, se
// activa sola) también recibía ese mismo aviso pensado para piezas
// físicas. El frontend (zySendOrderConfirmationEmail, en index.html) ya
// distingue esto desde antes; aquí se aplica exactamente el mismo
// criterio, para que el correo de respaldo del webhook diga lo mismo que
// el correo normal sin importar cuál de los dos termine llegando primero.
function isDigitalOnlyOrder(order){
  const items = order.items || [];
  return items.length > 0 && items.every(it => it.isMembership || it.isGiftCard);
}
function buildConfirmationHeadline(order){
  const items = order.items || [];
  const membershipItem = items.find(it => it.isMembership);
  const giftItem = items.find(it => it.isGiftCard);
  if(isDigitalOnlyOrder(order)){
    if(membershipItem && giftItem) return '¡Tu membresía y tu tarjeta de regalo ZAYDE ya están activas!';
    if(membershipItem) return `¡Bienvenido a ZAYDE Club! Tu membresía ${membershipItem.tierName || ''} ya está activa.`;
    return '¡Tu tarjeta de regalo ZAYDE ya está activa y lista para usarse!';
  }
  return '¡Pedido confirmado y pagado! ✅';
}

// Correo de respaldo — solo se manda si, por lo que sea, el navegador del
// cliente nunca alcanzó a mandar el suyo (ver checkeo de idempotencia abajo).
async function sendBackupConfirmationEmail(order){
  const mailer = getMailer();
  if(!mailer || !order.email) return;
  const greetingName = order.name ? order.name.split(' ')[0] : 'Hola';
  const headline = buildConfirmationHeadline(order);
  const digitalOnly = isDigitalOnlyOrder(order);
  const html = `
    <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
      <h2 style="margin:0 0 16px;">ZAYDE</h2>
      <p>${greetingName}, tu pedido <b>${order.orderNum}</b> tiene una actualización:</p>
      <p style="font-size:18px; font-weight:700; margin:16px 0; padding:12px 16px; background:#F1F0EC; border-radius:6px;">
        ${headline}
      </p>
      ${digitalOnly
        ? `<p>Puedes ver el detalle en cualquier momento desde la sección "Rastrear pedido" en el sitio, usando tu número de pedido o teléfono.</p>`
        : `<p>Puedes revisar el detalle completo de tu pedido en cualquier momento desde la sección "Rastrear pedido" en el sitio, usando tu número de pedido o teléfono.</p>`}
      <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Gracias por tu compra en ZAYDE.</p>
    </div>
  `;
  try{
    await mailer.sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to: order.email,
      subject: `Tu pedido ${order.orderNum} — ${headline}`,
      html
    });
  }catch(e){ console.error('Webhook: no se pudo mandar el correo de respaldo:', e); }
}

// [NUEVO] Correo cuando el pago SÍ falla (tarjeta rechazada, fondos
// insuficientes, bloqueo antifraude, etc.) — a diferencia del de
// confirmación, este es el ÚNICO aviso que recibe el cliente en este caso,
// porque el navegador nunca llega a mostrar una pantalla de "éxito" que
// pueda mandar su propio correo: si el pago falla, el navegador se queda
// en la pantalla de checkout, y si el cliente simplemente cierra la
// pestaña ahí, antes no se enteraba nadie ni el cliente tenía claro qué
// pasó con su pedido "pendiente".
async function sendPaymentFailedEmail(order, reason){
  const mailer = getMailer();
  if(!mailer || !order.email) return;
  const greetingName = order.name ? order.name.split(' ')[0] : 'Hola';
  const whatsappNumber = process.env.ZAYDE_WHATSAPP_NUMBER || '';
  const html = `
    <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
      <h2 style="margin:0 0 16px;">ZAYDE</h2>
      <p>${greetingName}, tu pago para el pedido <b>${order.orderNum}</b> no se pudo procesar.</p>
      <p style="font-size:15px; font-weight:700; margin:16px 0; padding:12px 16px; background:#FBEAEA; color:#8A1F1F; border-radius:6px;">
        Pago rechazado ❌${reason ? ` — ${reason}` : ''}
      </p>
      <p>Esto suele pasar por fondos insuficientes, un bloqueo antifraude del banco, o un dato de la tarjeta capturado mal. Tu pedido sigue reservado como "pendiente"; no se te cobró nada.</p>
      <p>Puedes intentar de nuevo desde el sitio, o escribirnos por WhatsApp${whatsappNumber ? ` al ${whatsappNumber}` : ''} y te ayudamos a completar la compra por transferencia.</p>
      <p style="color:#6B6D76; font-size:13px; margin-top:24px;">— Equipo ZAYDE</p>
    </div>
  `;
  try{
    await mailer.sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to: order.email,
      subject: `Tu pedido ${order.orderNum} — no pudimos procesar el pago`,
      html
    });
  }catch(e){ console.error('Webhook: no se pudo mandar el correo de pago fallido:', e); }
}

// Mensaje humano a partir del código de rechazo de Stripe, para que el
// correo/panel admin digan algo más útil que un código en inglés.
function humanDeclineReason(paymentIntent){
  const err = paymentIntent.last_payment_error;
  if(!err) return '';
  const code = err.decline_code || err.code || '';
  const map = {
    insufficient_funds: 'fondos insuficientes',
    card_declined: 'tarjeta rechazada por el banco',
    expired_card: 'tarjeta vencida',
    incorrect_cvc: 'CVC incorrecto',
    processing_error: 'error al procesar con el banco',
    fraudulent: 'bloqueada por prevención de fraude'
  };
  return map[code] || (err.message ? err.message : '');
}


// ============================================================
// [VENDEDORES] Ventas por vendedor (consignación)
//
// Cuando un pago se confirma de verdad (payment_intent.succeeded), por cada
// pieza del pedido que tenga sellerId se crea UNA fila en "sellerSales".
// Como esto corre en el servidor (SDK de Admin), nadie puede fabricar
// ventas falsas desde el navegador: solo existen ventas realmente pagadas.
//
// PRIVACIDAD: la fila de sellerSales NO lleva nombre, teléfono, dirección,
// correo ni el número de pedido (porque tus reglas dejan leer un pedido
// suelto, "get", a quien conozca su número: si el vendedor viera el folio,
// podría abrir el pedido completo del comprador). El ID de la fila es un
// código opaco (HMAC), y el vínculo con el pedido real vive aparte, en
// "sellerSalesPrivate", que solo lee el admin.
// ============================================================
const RESALE_DEFAULTS = {
  zayde: { 'Ropa':20, 'Sneakers':20, 'Joyería':25, 'Lentes de sol':22.8, 'Bolsos':23.3, 'Gorras':22 },
  zayg:  { 'Ropa':20, 'Joyería':25, 'Lentes de sol':23, 'Bolsos':24, 'Gorras':25 }
};

// Tabla de comisiones que guardas en la pestaña "Reventa" del panel admin
// (vive en admin_meta, junto con el resto de la configuración del sitio).
async function getResaleFees(db){
  let saved = {};
  try{
    const doc = await db.collection('admin_meta').doc(encodeURIComponent('zayde:admin:homeSettings')).get();
    if(doc.exists){
      const value = doc.data().value || {};
      saved = (value.resale && value.resale.fees) || {};
    }
  }catch(e){ console.error('Webhook: no se pudo leer la tabla de Reventa, se usan los porcentajes por defecto:', e); }
  return {
    zayde: Object.assign({}, RESALE_DEFAULTS.zayde, saved.zayde),
    zayg:  Object.assign({}, RESALE_DEFAULTS.zayg,  saved.zayg)
  };
}

// ID opaco y estable (misma pieza del mismo pedido = mismo ID, así un
// reintento de Stripe nunca duplica la venta) pero imposible de adivinar
// o de convertir de vuelta al número de pedido sin la llave secreta.
function saleIdFor(orderNum, itemIndex){
  return crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${orderNum}:${itemIndex}`).digest('hex').slice(0, 24);
}

const round2 = n => Math.round(n * 100) / 100;

async function createSellerSales(db, orderNum, order, paymentIntent){
  const items = order.items || [];
  const sellerItems = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => it && it.sellerId && !it.isMembership && !it.isGiftCard);
  if(!sellerItems.length) return 0;

  const fees = await getResaleFees(db);
  const sellerCache = {};
  let created = 0;
  const toNotify = []; // ventas nuevas (o con aviso pendiente) para mandarle correo al vendedor

  for(const { it, index } of sellerItems){
    const saleId = saleIdFor(orderNum, index);

    if(!(it.sellerId in sellerCache)){
      const sdoc = await db.collection('sellers').doc(String(it.sellerId)).get();
      sellerCache[it.sellerId] = sdoc.exists ? sdoc.data() : null;
    }
    const seller = sellerCache[it.sellerId];

    // Tienda y categoría: vienen en el item (index.html las copia al comprar).
    // Si es un pedido anterior a este cambio, se buscan en el producto.
    let store = it.store, category = it.category;
    if(!category){
      try{
        const pdoc = await db.collection('admin_products').doc(String(it.id)).get();
        if(pdoc.exists){ category = pdoc.data().category || null; store = store || pdoc.data().store || null; }
      }catch(e){ /* sigue sin categoría: la venta queda marcada para revisión */ }
    }
    const line = store === 'clothesg' ? 'zayg' : 'zayde';

    // Comisión: primero la propia del vendedor; si no tiene, la tabla de Reventa.
    let pct = null;
    if(seller && seller.commissionPct != null && isFinite(Number(seller.commissionPct))){
      pct = Number(seller.commissionPct);
    } else if(category && fees[line] && fees[line][category] != null){
      pct = Number(fees[line][category]);
    }

    const qty = Number(it.qty) || 1;
    const unitPrice = Number(it.price) || 0;
    const gross = round2(unitPrice * qty);
    const commission = pct == null ? null : round2(gross * pct / 100);
    const net = commission == null ? null : round2(gross - commission);

    const now = Date.now();
    const sale = {
      sellerId: String(it.sellerId),
      productId: it.id != null ? String(it.id) : null,
      productName: it.name || '',
      brand: it.brand || null,
      size: it.size || null,
      qty,
      unitPrice,
      gross,
      commissionPct: pct,
      commission,
      net,
      needsReview: pct == null,      // sin comisión definida: revísala y complétala en el panel
      status: 'pagado',              // pagado → en verificación → enviado → entregado / devuelto
      settled: false,                // true cuando ya le liquidaste esta venta
      createdAt: now,
      paidAt: now
    };

    try{
      await db.collection('sellerSales').doc(saleId).create(sale);
      // Vínculo privado con el pedido real: solo lo lee el admin.
      await db.collection('sellerSalesPrivate').doc(saleId).set({
        orderNum, itemIndex: index, stripePaymentIntentId: paymentIntent.id
      }, { merge: true });
      created++;
      toNotify.push({ saleId, sale });
    }catch(e){
      // ALREADY_EXISTS (código 6): Stripe reenvió el evento y esta pieza ya
      // estaba registrada. No se duplica; pero si por algún motivo su correo
      // al vendedor nunca salió (notifiedAt vacío), se reintenta ahora.
      if(e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))){
        try{
          const prev = await db.collection('sellerSales').doc(saleId).get();
          if(prev.exists && !prev.data().notifiedAt) toNotify.push({ saleId, sale: prev.data() });
        }catch(err){ console.error('Webhook: no se pudo revisar el aviso pendiente de una venta:', err); }
        continue;
      }
      throw e;
    }
  }

  // Un correo por vendedor con sus piezas de este pedido. Si el correo falla
  // NO se rompe el webhook: la venta ya quedó registrada y el vendedor la ve
  // en su portal; el aviso se reintenta si Stripe vuelve a mandar el evento.
  try{ await notifySellers(db, toNotify, sellerCache); }
  catch(e){ console.error('Webhook: error avisando a los vendedores:', e); }

  return created;
}

// ------------------------------------------------------------
// Correo al vendedor cuando se vende una pieza suya.
// PRIVACIDAD: solo lleva datos de la pieza y lo que le toca. Nunca nombre,
// teléfono, dirección, correo ni número de pedido del comprador.
// ------------------------------------------------------------
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const moneyMx = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function notifySellers(db, toNotify, sellerCache){
  if(!toNotify.length) return;
  const mailer = getMailer();
  if(!mailer){ console.error('Webhook: sin GMAIL_USER / GMAIL_APP_PASSWORD, no se avisa a los vendedores.'); return; }

  const bySeller = {};
  toNotify.forEach(n => { (bySeller[n.sale.sellerId] = bySeller[n.sale.sellerId] || []).push(n); });

  const siteUrl = process.env.ZAYDE_SITE_URL || 'https://zayde.com.mx';

  for(const sellerId of Object.keys(bySeller)){
    const seller = sellerCache[sellerId];
    if(!seller || !seller.email || seller.status === 'pausado') continue;
    const list = bySeller[sellerId];
    const greetingName = seller.name ? String(seller.name).split(' ')[0] : 'Hola';
    const pending = list.some(n => n.sale.net == null);
    const total = list.reduce((t, n) => t + (Number(n.sale.net) || 0), 0);

    const rows = list.map(({ sale }) => `
      <tr>
        <td style="padding:10px 0; border-bottom:1px solid #EEEDE8;">
          <b>${escHtml((sale.brand ? sale.brand + ' ' : '') + (sale.productName || 'Pieza'))}</b><br>
          <span style="color:#6B6D76; font-size:13px;">${sale.size ? 'Talla ' + escHtml(sale.size) + ' · ' : ''}Cantidad ${escHtml(sale.qty || 1)} · Venta ${moneyMx(sale.gross)}</span>
        </td>
        <td style="padding:10px 0; border-bottom:1px solid #EEEDE8; text-align:right; white-space:nowrap;">
          ${sale.net == null ? '<span style="color:#9a5b00;">Comisión por definir</span>' : '<b>' + moneyMx(sale.net) + '</b>'}
        </td>
      </tr>`).join('');

    const subject = list.length === 1
      ? `¡Vendiste una pieza en ZAYDE! ${list[0].sale.productName || ''}`.trim()
      : `¡Vendiste ${list.length} piezas en ZAYDE!`;

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
        <h2 style="margin:0 0 16px;">ZAYDE</h2>
        <p>${escHtml(greetingName)}, ${list.length === 1 ? '¡se vendió una pieza tuya!' : '¡se vendieron ' + list.length + ' piezas tuyas!'} 🎉</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">${rows}</table>
        ${total > 0 ? `<p style="font-size:16px; margin:14px 0;">Te tocan <b>${moneyMx(total)}</b>${pending ? ' (más lo de las piezas con comisión por definir)' : ''}.</p>` : (pending ? '<p>Te confirmaremos lo que te toca en cuanto definamos la comisión.</p>' : '')}
        <p style="color:#555; font-size:13px;">Verificaremos la pieza y la enviaremos. Puedes seguir el estado de tus ventas y tu stock en tu portal.</p>
        <p><a href="${escHtml(siteUrl)}/vendedor" style="display:inline-block; background:#0E0E10; color:#fff; text-decoration:none; padding:12px 22px; border-radius:6px; font-weight:700;">Abrir mi portal de vendedor</a></p>
        <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Recibes este correo porque eres vendedor de ZAYDE.</p>
      </div>`;

    try{
      await mailer.sendMail({ from: `"ZAYDE" <${process.env.GMAIL_USER}>`, to: seller.email, subject, html });
      const batch = db.batch();
      list.forEach(n => batch.update(db.collection('sellerSales').doc(n.saleId), { notifiedAt: Date.now() }));
      await batch.commit();
    }catch(e){
      console.error('Webhook: no se pudo avisar por correo a un vendedor:', e);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Método no permitido');
    return;
  }

  if(!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY){
    console.error('Webhook: faltan STRIPE_WEBHOOK_SECRET o STRIPE_SECRET_KEY en Vercel.');
    res.status(500).send('Falta configuración del servidor.');
    return;
  }

  let event;
  try{
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  }catch(err){
    // Firma inválida: alguien (o algo) que no es Stripe de verdad está
    // llamando a esta URL — se rechaza, no se procesa nada.
    console.error('Webhook: firma inválida —', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try{
    if(event.type === 'payment_intent.succeeded'){
      const paymentIntent = event.data.object;
      const orderNum = paymentIntent.metadata && paymentIntent.metadata.orderNum;

      if(!orderNum){
        console.error('Webhook: el PaymentIntent', paymentIntent.id, 'no trae orderNum en metadata — no se puede confirmar ningún pedido.');
        res.status(200).json({ received: true, warning: 'sin orderNum' });
        return;
      }

      const db = getFirestore();
      const orderRef = db.collection('orders').doc(orderNum);
      const snap = await orderRef.get();

      if(!snap.exists){
        // No debería pasar casi nunca (el pedido se guarda como "pendiente"
        // ANTES de cobrar), pero por si acaso: se registra el error para
        // poder investigarlo manualmente en vez de perder el rastro del pago.
        console.error(`Webhook: no se encontró el pedido ${orderNum} en Firestore para el pago ${paymentIntent.id}.`);
        res.status(200).json({ received: true, warning: 'pedido no encontrado' });
        return;
      }

      const order = snap.data();

      // Idempotencia: Stripe puede reenviar el mismo evento más de una vez.
      // Si ya estaba marcado como pagado (porque el navegador del cliente sí
      // alcanzó a hacerlo), no se hace nada más — así nunca se manda un
      // correo de confirmación duplicado.
      if(order.paymentStatus !== 'pagado'){
        await orderRef.update({
          paymentStatus: 'pagado',
          stripePaymentIntentId: paymentIntent.id,
          paymentFailReason: admin.firestore.FieldValue.delete() // limpia un posible intento fallido anterior del mismo pedido
        });
        await sendBackupConfirmationEmail({ ...order, stripePaymentIntentId: paymentIntent.id });
      }

      // [VENDEDORES] Crea las filas de sellerSales de este pedido. Va FUERA
      // del "if" de arriba a propósito: si un intento anterior marcó el
      // pedido como pagado pero falló antes de registrar las ventas (y
      // Stripe reintenta), aquí se completan sin duplicar nada.
      const salesCreated = await createSellerSales(db, orderNum, order, paymentIntent);
      if(salesCreated) console.log(`Webhook: ${salesCreated} venta(s) de vendedor registradas para el pedido ${orderNum}.`);

      // [VENDEDORES] Aviso de stock bajo: si esta compra dejó a una talla de un
      // vendedor en 1 unidad o en 0, se le avisa por correo. Comparte la lógica
      // (y el tope de 6 h por pieza/talla) con /api/send-email type
      // "seller-low-stock", así que si el navegador también lo pide, el
      // vendedor recibe un solo correo. Si esto falla NO se rompe el webhook
      // (la venta ya quedó registrada): solo se anota el error.
      try{
        const physicalItems = (order.items || [])
          .filter(it => it && it.sellerId && it.id != null && it.size && !it.isMembership && !it.isGiftCard)
          .map(it => ({ id: it.id, size: it.size, qty: it.qty }));
        if(physicalItems.length){
          await notifySellerLowStock(db, physicalItems, { mailer: getMailer(), siteUrl: process.env.ZAYDE_SITE_URL });
        }
      }catch(e){ console.error('Webhook: error en el aviso de stock bajo a vendedores:', e); }
    }

    // [NUEVO] Pago rechazado: el banco/Stripe no autorizó el cobro (fondos
    // insuficientes, antifraude, tarjeta vencida, etc.). El pedido NO se
    // pierde — sigue existiendo como "pendiente" en Firestore desde que se
    // creó antes de cobrar — pero antes no había ninguna señal de que el
    // pago había fallado: ni el cliente se enteraba claramente (si cerraba
    // la pestaña del checkout), ni tú lo veías distinto a un pedido
    // cualquiera "pendiente" en el panel.
    if(event.type === 'payment_intent.payment_failed'){
      const paymentIntent = event.data.object;
      const orderNum = paymentIntent.metadata && paymentIntent.metadata.orderNum;

      if(!orderNum){
        console.error('Webhook: PaymentIntent fallido', paymentIntent.id, 'sin orderNum en metadata.');
        res.status(200).json({ received: true, warning: 'sin orderNum' });
        return;
      }

      const db = getFirestore();
      const orderRef = db.collection('orders').doc(orderNum);
      const snap = await orderRef.get();

      if(!snap.exists){
        console.error(`Webhook: no se encontró el pedido ${orderNum} para el pago fallido ${paymentIntent.id}.`);
        res.status(200).json({ received: true, warning: 'pedido no encontrado' });
        return;
      }

      const order = snap.data();
      const reason = humanDeclineReason(paymentIntent);

      // Si el pedido YA está pagado (ej. el cliente reintentó y la segunda
      // vez sí funcionó, y ese evento de éxito llegó primero), no lo
      // pisamos con "fallido" — solo se registra el intento fallido si el
      // pedido sigue sin pagarse.
      if(order.paymentStatus !== 'pagado'){
        await orderRef.update({
          paymentStatus: 'fallido',
          paymentFailReason: reason || 'motivo no especificado',
          paymentFailedAt: Date.now()
        });
        await sendPaymentFailedEmail({ ...order }, reason);
      }
    }

    res.status(200).json({ received: true });
  }catch(err){
    console.error('Webhook: error procesando el evento:', err);
    // 500 le dice a Stripe "algo salió mal, reinténtalo más tarde" —
    // Stripe reintenta automáticamente los webhooks que fallan.
    res.status(500).json({ error: 'Error procesando el webhook.' });
  }
}
