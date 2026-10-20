// /api/send-email.js
//
// Endpoint unificado que reemplaza a send-coupon-email.js, send-drop-email.js
// y send-status-email.js. Se combinaron para bajar el conteo de funciones
// serverless (Vercel Hobby permite máx. 12; con los 3 archivos separados
// se llegaba a 14).
//
// Cómo se elige qué correo mandar: el body debe incluir { type: '...' }
// con uno de estos valores:
//   - "status"  -> antes era /api/send-status-email.js   (Gmail)
//   - "drop"    -> antes era /api/send-drop-email.js      (Gmail)
//   - "coupon"  -> antes era /api/send-coupon-email.js    (Resend)
//   - "otp"     -> [NUEVO] código de acceso del login (Gmail) — antes se
//                  mandaba con EmailJS (plantilla default sin editar, en
//                  inglés, con el pie "Email sent via EmailJS.com"). Ahora
//                  usa el mismo Gmail que ya manda "status" y "drop", sin
//                  nada nuevo que configurar.
//   - "giftcard"-> [NUEVO] avisa al destinatario de una tarjeta de regalo
//                  con su código (Gmail). No depende de un orderNum como
//                  "status" — verifica contra la colección "giftcards" en
//                  vez de "orders", porque una tarjeta de regalo puede no
//                  tener pedido asociado y su destinatario suele ser
//                  distinto de quien pagó.
//   - "membership"-> [NUEVO] confirma al cliente que su membresía ZAYDE
//                  Club ya está activa (Gmail). Igual que "giftcard", NO
//                  depende de un orderNum ni de la colección "orders" —
//                  comprar una membresía no genera ningún pedido. Verifica
//                  contra la colección "digitalConfirmations" (doc = code),
//                  donde el frontend guarda el código de confirmación antes
//                  de pedir el envío del correo.
//
//   - "find-user" -> [VENDEDORES] SOLO ADMIN. Devuelve el UID de una cuenta
//                  que ya existe con ese correo, para convertir en vendedor
//                  a alguien que ya es cliente de ZAYDE sin crearle otra
//                  cuenta. Body: { type:"find-user", email }.
//   - "seller-notice" -> [VENDEDORES] SOLO ADMIN. Manda un aviso por Gmail a
//                  uno, varios o todos los vendedores activos. Los correos
//                  se leen de la colección "sellers" en el servidor (el
//                  navegador nunca manda direcciones), así que no sirve
//                  para escribirle a correos ajenos. Body:
//                  { type:"seller-notice", sellerIds:[...] | "all",
//                    subject, message }.
//   Los dos exigen el token de Firebase del admin en el encabezado
//   Authorization: Bearer <token>, y que ese UID exista en "admins".
//   - "seller-low-stock" -> [VENDEDORES] PÚBLICO (lo llama el navegador del
//                  comprador tras pagar). Avisa al vendedor cuando a una de
//                  sus tallas le queda 1 unidad o se agota. El navegador solo
//                  manda QUÉ se compró; el stock real, el dueño de la pieza y
//                  el destinatario salen de Firestore. Body:
//                  { type:"seller-low-stock", items:[{ id, size, qty }] }.
//                  La lógica vive en _lib/sellerLowStock.js (la comparte con
//                  stripe-webhook.js; un tope de 6 h por pieza/talla evita
//                  correos repetidos).
//   - "seller-event" -> [VENDEDORES] SOLO ADMIN (token en Authorization). Correos
//                  automáticos al vendedor, sin datos del comprador. La lógica y
//                  las plantillas viven en _lib/sellerEvents.js. Body:
//                  { type:"seller-event", event:"sale-status", saleIds:[...] }  (cambio de estado / devolución)
//                  { type:"seller-event", event:"commission",  saleIds:[...] }  (comisión definida)
//                  { type:"seller-event", event:"payout",      payoutId }       (liquidación registrada)
//                  { type:"seller-event", event:"pieces",      sellerId, productIds:[...], pieces?:[...] } (piezas publicadas)
//                  { type:"seller-event", event:"welcome",     sellerId, existingAccount?, resend? }       (bienvenida / reenviar acceso)
//   - "stock-reserve" / "stock-release" -> [SEGURIDAD] PÚBLICOS. Reserva y devuelve stock del inventario
//                  desde el servidor (antes lo hacía el navegador escribiendo en Firestore). Ver handleStock().
//   - GET /api/send-email (sin body) -> [CRON] aviso diario "ya tienes dinero listo para liquidar".
//                  Lo llama Vercel Cron (ver "crons" en vercel.json); exige CRON_SECRET:
//                  cualquier GET sin ese secreto recibe 401 y no hace nada.
//
// El resto de los campos del body son los mismos que ya mandaba tu
// frontend a cada endpoint original — no cambia nada más que la URL
// (ahora /api/send-email) y que hay que agregar "type".
//
// Variables de entorno necesarias (las mismas de antes, sin nada nuevo):
//   GMAIL_USER, GMAIL_APP_PASSWORD   -> para type "status", "drop" y "otp"
//   FIREBASE_SERVICE_ACCOUNT_B64     -> para type "status" y "drop"
//   RESEND_API_KEY                   -> para type "coupon"
//   OTP_SECRET                       -> [NUEVO] para type "otp" / "otp-verify" (cadena larga aleatoria)

import nodemailer from 'nodemailer';
import admin from 'firebase-admin';
import { checkRateLimit } from './_lib/rateLimit.js';
import { notifySellerLowStock } from './_lib/sellerLowStock.js';
import { sendSellerEvent, sendReleaseNotices, layout, note } from './_lib/sellerEvents.js';
import { normalizeItems, ORDER_RE, reserveStock, releaseReservation, sweepStale } from './_lib/stockReservations.js';
import { timingSafeEqual, randomInt, createHmac } from 'crypto';

// [FIX #3] Escapa texto antes de meterlo en HTML de correos. TODO dato que venga
// del body (nombre, etiquetas, etc.) o de la base de datos debe pasar por aquí.
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'))
    ),
  });
}

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return cachedTransporter;
}

export default async function handler(req, res) {
  // [CRON] Tarea diaria de Vercel (GET /api/send-email). Protegida con CRON_SECRET: sin el secreto correcto no hace nada.
  if (req.method === 'GET') return sellerReleaseJob(req, res);

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const { type } = req.body || {};

  if (type === 'status') return sendStatusEmail(req, res);
  if (type === 'drop') return sendDropEmail(req, res);
  if (type === 'coupon') return sendCouponEmail(req, res);
  if (type === 'otp') return sendOtpEmail(req, res);
  if (type === 'otp-verify') return verifyOtpEmail(req, res);
  if (type === 'giftcard') return sendGiftCardEmail(req, res);
  if (type === 'membership') return sendMembershipEmail(req, res);
  if (type === 'find-user') return findUserByEmail(req, res);
  if (type === 'seller-notice') return sendSellerNotice(req, res);
  if (type === 'seller-low-stock') return sendSellerLowStock(req, res);
  if (type === 'seller-event') return sendSellerEventType(req, res);
  if (type === 'stock-reserve' || type === 'stock-release') return handleStock(req, res, type);

  res.status(400).json({ error: 'Falta "type" o no es válido. Usa "status", "drop", "coupon", "otp", "otp-verify", "giftcard", "membership", "find-user", "seller-notice", "seller-low-stock", "seller-event", "stock-reserve" o "stock-release".' });
}


// ============================================================
// type: "stock-reserve" y "stock-release"  (PÚBLICOS: los llama el navegador
// del comprador durante el pago)
//
// [SEGURIDAD] Antes el navegador modificaba directo inventory/stock en Firestore
// (por eso esa colección estaba abierta a escritura pública). Ahora lo hace el
// servidor. Vive AQUÍ (y no en un archivo nuevo de /api) para no pasar el límite
// de 12 funciones de Vercel Hobby. La lógica está en _lib/stockReservations.js
// (la carpeta _lib no cuenta como función).
//
//   { type:"stock-reserve", orderNum, items:[{id,size,qty}] }
//        -> 200 { ok:true, reservationId }  |  409 { ok:false, code:"STOCK_INSUFICIENTE", itemId, size }
//   { type:"stock-release", orderNum, reservationId }
//        -> 200 { ok:true, result }   (solo devuelve stock si el pedido NO está pagado)
// ============================================================
async function handleStock(req, res, type) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const db = admin.firestore();
    const rl = await checkRateLimit(db, req, 'reserve-stock', { windowMs: 15 * 60 * 1000, max: 40 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ ok: false, error: 'Demasiadas solicitudes.' });
      return;
    }

    const body = req.body || {};
    const orderNum = String(body.orderNum || '');
    if (!ORDER_RE.test(orderNum)) {
      res.status(400).json({ ok: false, error: 'orderNum inválido' });
      return;
    }

    if (type === 'stock-reserve') {
      const items = normalizeItems(body.items);
      if (!items) { res.status(400).json({ ok: false, error: 'items inválidos' }); return; }
      // Limpieza de reservas abandonadas; si falla no frena la compra.
      try { await sweepStale(db); } catch (e) { console.error('stock-reserve: error limpiando reservas viejas:', e); }
      try {
        const reservationId = await reserveStock(db, { orderNum, items });
        res.status(200).json({ ok: true, reservationId });
      } catch (e) {
        if (e && e.code === 'STOCK_INSUFICIENTE') {
          res.status(409).json({ ok: false, code: 'STOCK_INSUFICIENTE', itemId: e.item.id, size: e.item.size });
          return;
        }
        throw e;
      }
      return;
    }

    // type === 'stock-release'
    const result = await releaseReservation(db, { reservationId: String(body.reservationId || ''), orderNum });
    res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('stock (reserve/release): error:', err);
    res.status(500).json({ ok: false, error: 'Error del servidor.' });
  }
}

// ============================================================
// [CRON] Aviso diario "ya tienes dinero listo para liquidar" a los vendedores.
// Vercel llama a esta URL por GET una vez al día (ver vercel.json) y manda el
// encabezado Authorization: Bearer <CRON_SECRET>. Sin CRON_SECRET configurado, o
// con un secreto distinto, no hace nada (así nadie puede dispararlo desde fuera).
// ============================================================
async function sellerReleaseJob(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Falta CRON_SECRET en las variables de entorno de Vercel.' });
    return;
  }
  const given = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from('Bearer ' + secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }
  try {
    const result = await sendReleaseNotices(admin.firestore(), getTransporter());
    res.status(200).json({ success: true, sent: result.sent, sales: result.sales });
  } catch (err) {
    console.error('seller-release: error inesperado:', err);
    res.status(500).json({ error: 'Error del servidor al enviar los avisos.' });
  }
}

// ============================================================
// type: "seller-event"  [VENDEDORES] SOLO ADMIN — correos automáticos al vendedor
// ============================================================
async function sendSellerEventType(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }
  try {
    const caller = await requireAdmin(req, res);
    if (!caller) return;

    const db = admin.firestore();
    const rl = await checkRateLimit(db, req, 'send-seller-event', { windowMs: 60 * 60 * 1000, max: 200 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ error: 'Demasiados avisos en poco tiempo. Intenta de nuevo en unos minutos.' });
      return;
    }

    const result = await sendSellerEvent(db, getTransporter(), req.body || {}, { auth: admin.auth() });
    res.status(200).json({ success: true, sent: result.sent });
  } catch (err) {
    if (err && err.code === 'invalid-event') {
      res.status(400).json({ error: 'Evento no válido.' });
      return;
    }
    console.error('seller-event: error inesperado:', err);
    res.status(500).json({ error: 'Error del servidor al enviar el aviso.' });
  }
}

// ============================================================
// type: "seller-low-stock"  [VENDEDORES] — aviso de stock bajo
// ============================================================
async function sendSellerLowStock(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 20) : [];
    if (!items.length) {
      res.status(200).json({ sent: 0 });
      return;
    }

    const db = admin.firestore();

    // Endpoint público: tope por IP además del tope por pieza/talla (6 h) que
    // ya trae la lógica compartida.
    const rl = await checkRateLimit(db, req, 'seller-low-stock', { windowMs: 60 * 60 * 1000, max: 30 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
      return;
    }

    const mailer = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ? getTransporter() : null;
    const sent = await notifySellerLowStock(db, items, { mailer });
    res.status(200).json({ sent });
  } catch (err) {
    console.error('seller-low-stock: error inesperado:', err);
    res.status(500).json({ error: 'No se pudo revisar el stock' });
  }
}

// ============================================================
// type: "status"  (antes send-status-email.js)
// ============================================================
async function sendStatusEmail(req, res) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }

  const db = admin.firestore();

  const rl = await checkRateLimit(db, req, 'send-status-email', { windowMs: 60 * 60 * 1000, max: 10 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    const { to, name, orderNum, statusLabel, isDigitalOnly } = req.body || {};

    if (!to || !orderNum || !statusLabel) {
      res.status(400).json({ error: 'Faltan datos para enviar el correo.' });
      return;
    }

    const orderSnap = await db.collection('orders').doc(String(orderNum)).get();
    if (!orderSnap.exists || String(orderSnap.data().email || '').toLowerCase() !== String(to).toLowerCase()) {
      res.status(403).json({ error: 'El pedido y el correo no coinciden.' });
      return;
    }

    const greetingName = name ? escHtml(String(name).split(' ')[0]) : 'Hola';

    // [FIX — "el correo dice 'tu pedido tiene una actualización' hasta
    // cuando compras solo membresía + tarjeta de regalo"] Antes este
    // envoltorio SIEMPRE decía "tu pedido X tiene una actualización",
    // sin importar qué venía en statusLabel — sonaba a aviso de envío
    // aunque la compra fuera 100% digital. El frontend (zayde.com.mx)
    // ahora manda isDigitalOnly:true cuando el "pedido" es solo
    // membresía y/o tarjeta de regalo (sin ningún producto físico), y
    // aquí usamos un envoltorio distinto para ese caso: sin la palabra
    // "pedido" ni nada de rastreo/envío, más acorde a una confirmación
    // de compra digital. orderNum se sigue guardando y usando para el
    // lookup de seguridad de arriba, solo cambia el texto visible.
    const cleanStatus = String(statusLabel).replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
    const introHtml = isDigitalOnly
      ? `<p>${greetingName}, ¡gracias por tu compra en ZAYDE!</p>`
      : `<p>${greetingName}, tu pedido <b>${escHtml(orderNum)}</b> tiene una actualización:</p>`;
    const footerHtml = isDigitalOnly
      ? `<p>Puedes ver el detalle de tu compra en cualquier momento desde tu cuenta en el sitio, en las secciones "Membresía" y/o "Tarjeta de regalo".</p>`
      : `<p>Puedes revisar el detalle completo de tu pedido en cualquier momento desde la sección "Rastrear pedido" en el sitio, usando tu número de pedido o teléfono.</p>`;
    const subjectText = isDigitalOnly ? cleanStatus : `Tu pedido ${String(orderNum).replace(/[\r\n]+/g, ' ')} — ${cleanStatus}`;

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
        <h2 style="margin:0 0 16px;">ZAYDE</h2>
        ${introHtml}
        <p style="font-size:18px; font-weight:700; margin:16px 0; padding:12px 16px; background:#F1F0EC; border-radius:6px;">
          ${escHtml(cleanStatus)}
        </p>
        ${footerHtml}
        <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Gracias por tu compra en ZAYDE.</p>
      </div>
    `;

    await getTransporter().sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to,
      subject: subjectText,
      html,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando email de estatus (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}

// ============================================================
// type: "drop"  (antes send-drop-email.js)
// ============================================================
async function sendDropEmail(req, res) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }

  const db = admin.firestore();

  const rl = await checkRateLimit(db, req, 'send-drop-email', { windowMs: 60 * 60 * 1000, max: 10 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    const { to, name } = req.body || {}; // [FIX #3] dropText ya NO se acepta del navegador

    if (!to) {
      res.status(400).json({ error: 'Falta el correo del destinatario.' });
      return;
    }

    // [FIX — "no me llega ningún gmail de aviso"] Antes esto SOLO aceptaba
    // correos ya presentes en newsletterSubscribers (el popup de 10% de
    // descuento). Pero la lista real de "avísenme del Drop" ahora vive en
    // su propia colección pública, dropSubscribers (ver zyGetDropEmailRecipients
    // y zyAdminAddDropSubscriber en el frontend) — alguien puede pedir que
    // le avisen del Drop sin necesariamente haberse suscrito al newsletter.
    // Por eso ahora se acepta si el correo existe en CUALQUIERA de las dos
    // colecciones.
    const emailKey = encodeURIComponent(String(to).toLowerCase());
    const [dropSnap, newsletterSnap] = await Promise.all([
      db.collection('dropSubscribers').doc(emailKey).get(),
      db.collection('newsletterSubscribers').doc(emailKey).get(),
    ]);
    if (!dropSnap.exists && !newsletterSnap.exists) {
      res.status(403).json({ error: 'Ese correo no está suscrito a los avisos de Drop.' });
      return;
    }

    const greetingName = name ? escHtml(String(name).split(' ')[0]) : 'Hola';
    // [FIX #3] El texto del Drop se lee de la configuración guardada por el admin
    // (admin_meta / zayde:admin:homeSettings → value.dropText), NO del body. Antes
    // cualquiera podía mandar a un suscriptor un correo con el texto/HTML que quisiera
    // desde tu Gmail oficial.
    let dropLabel = 'Drop en vivo';
    try {
      const sd = await db.collection('admin_meta').doc(encodeURIComponent('zayde:admin:homeSettings')).get();
      const t = sd.exists && sd.data().value && sd.data().value.dropText;
      if (typeof t === 'string' && t.trim()) dropLabel = t.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    } catch (e) { console.error('drop: no se pudo leer dropText de la configuración, se usa el texto por defecto:', e); }
    const safeDropLabel = escHtml(dropLabel);

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
        <h2 style="margin:0 0 16px;">ZAYDE</h2>
        <p>${greetingName}, ¡el <b>${safeDropLabel}</b> que estabas esperando ya empezó! 🔥</p>
        <p style="font-size:16px; font-weight:700; margin:16px 0; padding:12px 16px; background:#F1F0EC; border-radius:6px;">
          Entra ahora antes de que se agoten las piezas.
        </p>
        <p><a href="https://zayde-kappa.vercel.app/" style="display:inline-block; background:#4A5FC7; color:#fff; text-decoration:none; padding:12px 22px; border-radius:6px; font-weight:700;">Ver el Drop ahora</a></p>
        <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Recibiste este correo porque te registraste para que te avisáramos del próximo Drop en ZAYDE.</p>
      </div>
    `;

    await getTransporter().sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to,
      subject: `🔥 ${dropLabel} — ¡ya comenzó!`,
      html,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando email de aviso de Drop (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}

// ============================================================
// type: "otp" y "otp-verify"
//
// [FIX #2] ANTES: el código de 6 dígitos se generaba con Math.random() en el
// NAVEGADOR, se mandaba al servidor solo para que lo enviara por correo, y
// se comparaba en el navegador (code !== nkPendingCode). Cualquiera podía
// saltarse la verificación desde la consola, y si el envío fallaba la pantalla
// mostraba el código real.
//
// AHORA todo el control vive en el servidor:
//   - "otp"        Requiere la sesión de Firebase (Authorization: Bearer <idToken>).
//                  El destinatario es SIEMPRE el correo de esa sesión (el navegador
//                  ya no manda "to", así que no sirve para spamear correos ajenos).
//                  El servidor genera el código con crypto.randomInt, guarda solo
//                  su HASH (HMAC) en Firestore colección "emailOtps" (doc = uid),
//                  con vigencia de 10 min, y lo envía por Gmail. Espera mínima de
//                  30 s entre envíos.
//   - "otp-verify" Body { code }. Máximo 5 intentos por código, comparación en tiempo
//                  constante. Si es correcto, borra el código y marca la cuenta con
//                  emailVerified:true desde el servidor (Admin SDK) — eso sí es una
//                  prueba real de que la persona controla ese correo.
//
// Variable de entorno nueva (recomendada): OTP_SECRET = cadena larga aleatoria
// (la llave del HMAC). Si no existe se usa FIREBASE_SERVICE_ACCOUNT_B64 como respaldo.
// IMPORTANTE: la colección "emailOtps" solo debe leerla/escribirla el Admin SDK;
// en firestore.rules NO debe tener ninguna regla que permita acceso desde clientes.
// ============================================================
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function otpSecret() { return process.env.OTP_SECRET || process.env.FIREBASE_SERVICE_ACCOUNT_B64 || ''; }
function otpHash(uid, code) { return createHmac('sha256', otpSecret()).update(`${uid}:${code}`).digest('hex'); }

// Exige un token de Firebase válido (cualquier usuario con sesión, no solo admin).
async function requireUser(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'no-token' }); return null; }
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch (e) { res.status(401).json({ error: 'invalid-token' }); return null; }
  if (!decoded.email) { res.status(400).json({ error: 'no-email' }); return null; }
  return decoded;
}

async function sendOtpEmail(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }
  if (!otpSecret()) {
    res.status(500).json({ error: 'Falta OTP_SECRET en las variables de entorno de Vercel.' });
    return;
  }

  try {
    const caller = await requireUser(req, res);
    if (!caller) return;

    const db = admin.firestore();
    const rl = await checkRateLimit(db, req, 'send-otp-email', { windowMs: 15 * 60 * 1000, max: 8 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
      return;
    }

    const email = String(caller.email).toLowerCase();
    const ref = db.collection('emailOtps').doc(caller.uid);
    const prev = await ref.get();
    if (prev.exists) {
      const wait = OTP_COOLDOWN_MS - (Date.now() - (Number(prev.data().lastSentAt) || 0));
      if (wait > 0) {
        res.setHeader('Retry-After', Math.ceil(wait / 1000));
        res.status(429).json({ error: 'Espera unos segundos antes de pedir otro código.' });
        return;
      }
    }

    const code = String(randomInt(100000, 1000000)); // 6 dígitos, criptográficamente aleatorio
    const now = Date.now();
    await ref.set({ hash: otpHash(caller.uid, code), email, expiresAt: now + OTP_TTL_MS, attempts: 0, lastSentAt: now });

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:420px; margin:0 auto; padding:32px 24px; color:#0E0E10; background:#ffffff;">
        <h2 style="margin:0 0 20px; letter-spacing:.5px;">ZAYDE</h2>
        <p style="font-size:14px; line-height:1.6; margin:0 0 18px;">
          Este es tu código para confirmar tu correo en ZAYDE:
        </p>
        <div style="font-size:32px; font-weight:800; letter-spacing:6px; text-align:center; padding:16px 0; margin:0 0 18px; background:#F1F0EC; border-radius:8px;">
          ${code}
        </div>
        <p style="font-size:13px; line-height:1.6; color:#6B6D76; margin:0 0 6px;">
          Es válido por 10 minutos. No lo compartas con nadie: nuestro equipo nunca te lo va a pedir por teléfono, WhatsApp o redes sociales.
        </p>
        <p style="font-size:13px; line-height:1.6; color:#6B6D76; margin:0;">
          Si tú no pediste este código, puedes ignorar este correo.
        </p>
        <p style="color:#9A9AA2; font-size:12px; margin-top:28px; border-top:1px solid #EEEDE8; padding-top:16px;">ZAYDE · zayde.com.mx</p>
      </div>
    `;

    try {
      await getTransporter().sendMail({
        from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `${code} es tu código de acceso a ZAYDE`,
        html,
      });
    } catch (mailErr) {
      await ref.delete().catch(() => {}); // si no salió el correo, no deja un código vivo
      throw mailErr;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando código de acceso (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}

async function verifyOtpEmail(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const caller = await requireUser(req, res);
    if (!caller) return;

    const db = admin.firestore();
    const rl = await checkRateLimit(db, req, 'verify-otp-email', { windowMs: 15 * 60 * 1000, max: 20 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' });
      return;
    }

    const code = String((req.body && req.body.code) || '').trim();
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'invalid-code' });
      return;
    }

    const ref = db.collection('emailOtps').doc(caller.uid);
    // Transacción: el contador de intentos no se puede esquivar mandando
    // muchas peticiones en paralelo.
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: 'expired' };
      const d = snap.data();
      const attempts = Number(d.attempts) || 0;
      if (Date.now() > Number(d.expiresAt)) { tx.delete(ref); return { status: 'expired' }; }
      if (attempts >= OTP_MAX_ATTEMPTS) { tx.delete(ref); return { status: 'locked' }; }
      const a = Buffer.from(otpHash(caller.uid, code), 'hex');
      const b = Buffer.from(String(d.hash || ''), 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) { tx.delete(ref); return { status: 'ok' }; }
      tx.update(ref, { attempts: attempts + 1 });
      return { status: 'wrong', remaining: OTP_MAX_ATTEMPTS - attempts - 1 };
    });

    if (outcome.status === 'ok') {
      await admin.auth().updateUser(caller.uid, { emailVerified: true });
      res.status(200).json({ success: true });
      return;
    }
    if (outcome.status === 'locked') { res.status(429).json({ error: 'too-many-attempts' }); return; }
    if (outcome.status === 'expired') { res.status(400).json({ error: 'code-expired' }); return; }
    res.status(400).json({ error: 'invalid-code', remaining: outcome.remaining });
  } catch (err) {
    console.error('Error verificando código de acceso:', err);
    res.status(500).json({ error: 'Error del servidor al verificar el código.' });
  }
}

// ============================================================
// type: "giftcard"  [NUEVO — corrige que el correo de tarjeta de regalo
// nunca se mandaba]. Antes el frontend usaba type:"status" para avisarle
// al destinatario de una tarjeta de regalo, pero ese caso EXIGE un
// orderNum y compara el correo contra un pedido en la colección "orders"
// — una tarjeta de regalo comprada sola nunca genera un pedido (no hay
// orderNum), y aunque lo hubiera, el destinatario de un regalo suele ser
// alguien distinto de quien pagó, así que nunca iba a coincidir con
// order.email. El resultado: el backend rechazaba la petición (400 o 403)
// y el cliente nunca recibía el código por correo, en completo silencio.
//
// Aquí en vez de un pedido se verifica contra el código real de la
// tarjeta, que el frontend guarda en Firestore (colección "giftcards",
// doc = code) justo antes de pedir el envío — así seguimos sin mandar
// correos a cualquier destinatario con solo adivinar datos, sin depender
// de que exista un pedido.
// ============================================================
async function sendGiftCardEmail(req, res) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }

  const db = admin.firestore();

  const rl = await checkRateLimit(db, req, 'send-giftcard-email', { windowMs: 60 * 60 * 1000, max: 10 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    const { to, name, code, amount } = req.body || {};

    if (!to || !code || !amount) {
      res.status(400).json({ error: 'Faltan datos para enviar el correo.' });
      return;
    }

    const cardSnap = await db.collection('giftcards').doc(String(code)).get();
    if (!cardSnap.exists || String(cardSnap.data().email || '').toLowerCase() !== String(to).toLowerCase()) {
      res.status(403).json({ error: 'El código y el correo no coinciden.' });
      return;
    }

    const greetingName = name ? escHtml(String(name).split(' ')[0]) : 'Hola';
    const amountNum = Number(amount);
    if (!isFinite(amountNum) || amountNum <= 0 || amountNum > 1000000) {
      res.status(400).json({ error: 'Monto inválido.' });
      return;
    }
    const amountLabel = `$${amountNum.toLocaleString('es-MX')} MXN`;

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
        <h2 style="margin:0 0 16px;">ZAYDE</h2>
        <p>${greetingName}, ¡tienes una tarjeta de regalo ZAYDE!</p>
        <p style="font-size:22px; font-weight:800; margin:16px 0; padding:16px; background:#F1F0EC; border-radius:6px; text-align:center;">
          ${amountLabel}
        </p>
        <p style="margin:0 0 6px;">Tu código para canjearla es:</p>
        <p style="font-size:20px; font-weight:800; letter-spacing:2px; margin:8px 0 20px; text-align:center; background:#0E0E10; color:#fff; padding:12px; border-radius:6px;">${escHtml(code)}</p>
        <p>Cánjeala en zayde.com.mx desde "Tarjeta de regalo" → "Canjear", o úsala directo al pagar cualquier compra.</p>
        <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Gracias por confiar en ZAYDE.</p>
      </div>
    `;

    await getTransporter().sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to,
      subject: `¡Tienes una tarjeta de regalo ZAYDE de ${amountLabel}!`,
      html,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando email de tarjeta de regalo (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}

// ============================================================
// type: "membership"  [NUEVO] Confirmación de membresía ZAYDE Club — sin
// número de pedido, sin envoltorio de "pedido tiene una actualización".
// Misma lógica de verificación que "giftcard" (un código propio, no un
// orderNum), pero contra la colección "digitalConfirmations" en vez de
// "giftcards", porque aquí no hay saldo/monto que canjear, solo una
// membresía que activar.
// ============================================================
async function sendMembershipEmail(req, res) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }

  const db = admin.firestore();

  const rl = await checkRateLimit(db, req, 'send-membership-email', { windowMs: 60 * 60 * 1000, max: 10 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    const { to, name, code, tierName } = req.body || {};

    if (!to || !code || !tierName) {
      res.status(400).json({ error: 'Faltan datos para enviar el correo.' });
      return;
    }

    const confirmSnap = await db.collection('digitalConfirmations').doc(String(code)).get();
    if (!confirmSnap.exists || String(confirmSnap.data().email || '').toLowerCase() !== String(to).toLowerCase()) {
      res.status(403).json({ error: 'El código y el correo no coinciden.' });
      return;
    }

    const greetingName = name ? escHtml(String(name).split(' ')[0]) : 'Hola';

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
        <h2 style="margin:0 0 16px;">ZAYDE</h2>
        <p>${greetingName}, ¡gracias por tu compra en ZAYDE!</p>
        <p style="font-size:18px; font-weight:700; margin:16px 0; padding:12px 16px; background:#F1F0EC; border-radius:6px;">
          ¡Bienvenido a ZAYDE Club! Tu membresía ${escHtml(tierName)} ya está activa.
        </p>
        <p style="margin:0 0 6px;">Tu código de confirmación es:</p>
        <p style="font-size:20px; font-weight:800; letter-spacing:2px; margin:8px 0 20px; text-align:center; background:#0E0E10; color:#fff; padding:12px; border-radius:6px;">${escHtml(code)}</p>
        <p>Puedes ver el detalle de tu membresía en cualquier momento desde tu cuenta en el sitio, en la sección "Membresía".</p>
        <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Gracias por confiar en ZAYDE.</p>
      </div>
    `;

    await getTransporter().sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to,
      subject: `¡Bienvenido a ZAYDE Club, ${tierName}!`,
      html,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando email de membresía (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}

// ============================================================
// [VENDEDORES] Utilidades y tipos "solo admin"
// ============================================================

// Verifica que quien llama sea un administrador: (1) token de Firebase válido
// en el encabezado Authorization y (2) que su UID tenga documento en la
// colección "admins" (lo mismo que revisa isAdmin() en firestore.rules).
// Si no lo es, responde 401/403 y devuelve null.
async function requireAdmin(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'no-token' }); return null; }

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch (e) { res.status(401).json({ error: 'invalid-token' }); return null; }

  const adminDoc = await admin.firestore().collection('admins').doc(decoded.uid).get();
  if (!adminDoc.exists) { res.status(403).json({ error: 'not-admin' }); return null; }
  return decoded;
}

// ------------------------------------------------------------
// type: "find-user"  — SOLO ADMIN
// ------------------------------------------------------------
async function findUserByEmail(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const caller = await requireAdmin(req, res);
    if (!caller) return;

    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'invalid-email' });
      return;
    }

    try {
      const user = await admin.auth().getUserByEmail(email);
      res.status(200).json({ uid: user.uid });
    } catch (e) {
      if (e && e.code === 'auth/user-not-found') { res.status(404).json({ error: 'no-user' }); return; }
      throw e;
    }
  } catch (err) {
    console.error('find-user: error inesperado:', err);
    res.status(500).json({ error: 'server-error' });
  }
}

// ------------------------------------------------------------
// type: "seller-notice"  — SOLO ADMIN
// Aviso por Gmail a vendedores (un correo por vendedor, con su nombre).
// ------------------------------------------------------------
async function sendSellerNotice(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }

  try {
    const caller = await requireAdmin(req, res);
    if (!caller) return;

    const db = admin.firestore();
    const rl = await checkRateLimit(db, req, 'send-seller-notice', { windowMs: 60 * 60 * 1000, max: 20 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ error: 'Demasiados avisos en poco tiempo. Intenta de nuevo en unos minutos.' });
      return;
    }

    const { sellerIds, subject, message } = req.body || {};
    const cleanSubject = String(subject || '').trim();
    const cleanMessage = String(message || '').trim();
    if (cleanSubject.length < 3 || cleanSubject.length > 120) {
      res.status(400).json({ error: 'El asunto debe tener entre 3 y 120 caracteres.' });
      return;
    }
    if (cleanMessage.length < 3 || cleanMessage.length > 3000) {
      res.status(400).json({ error: 'El mensaje debe tener entre 3 y 3000 caracteres.' });
      return;
    }

    // Destinatarios: los correos salen SIEMPRE de la colección "sellers".
    let sellers = [];
    if (sellerIds === 'all') {
      const snap = await db.collection('sellers').where('status', '==', 'activo').get();
      sellers = snap.docs.map((d) => d.data());
    } else if (Array.isArray(sellerIds) && sellerIds.length) {
      const ids = sellerIds.slice(0, 100).map(String);
      const docs = await Promise.all(ids.map((id) => db.collection('sellers').doc(id).get()));
      sellers = docs.filter((d) => d.exists && d.data().status === 'activo').map((d) => d.data());
    } else {
      res.status(400).json({ error: 'Elige a quién enviarle el aviso.' });
      return;
    }
    sellers = sellers.filter((x) => x && x.email).slice(0, 100);
    if (!sellers.length) {
      res.status(404).json({ error: 'No hay vendedores activos con correo a quienes enviarles el aviso.' });
      return;
    }

    const bodyHtml = escHtml(cleanMessage).replace(/\r?\n/g, '<br>');
    let sent = 0, failed = 0;

    for (const seller of sellers) {
      const greetingName = seller.name ? String(seller.name).split(' ')[0] : 'Hola';
      const html = layout({
        preheader: cleanSubject,
        title: cleanSubject,
        intro: `${escHtml(greetingName)}, tienes un aviso del equipo de ZAYDE:`,
        body: note(bodyHtml),
        cta: 'Abrir mi portal de vendedor'
      });
      try {
        await getTransporter().sendMail({
          from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
          to: seller.email,
          subject: cleanSubject,
          html,
        });
        sent++;
      } catch (e) {
        failed++;
        console.error('seller-notice: no se pudo enviar a un vendedor:', e);
      }
    }

    res.status(200).json({ success: failed === 0, sent, failed });
  } catch (err) {
    console.error('seller-notice: error inesperado:', err);
    res.status(500).json({ error: 'Error del servidor al enviar el aviso.' });
  }
}

// ============================================================
// type: "coupon"  (antes send-coupon-email.js)
// ============================================================
async function sendCouponEmail(req, res) {
  const { to, name, code, value } = req.body || {};

  if (!to || !code) {
    res.status(400).json({ error: 'Falta el correo del cliente o el código del cupón' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'RESEND_API_KEY no está configurada en el servidor' });
    return;
  }

  const pct = Math.min(100, Math.max(1, Math.round(Number(value) || 10)));
  const firstName = escHtml(String(name || '').trim().split(' ')[0]) || 'Hola';

  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111;">
      <p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:0 0 18px;">ZAYDE — Cliente frecuente</p>
      <h1 style="font-size:20px;margin:0 0 14px;">¡Gracias por ser cliente frecuente, ${firstName}!</h1>
      <p style="font-size:14px;line-height:1.6;margin:0 0 22px;">
        Por tus compras con nosotros ya calificas como socio ZAYDE. Aquí tienes tu cupón de descuento:
      </p>
      <div style="border:2px dashed #111;border-radius:10px;padding:18px;text-align:center;margin-bottom:22px;">
        <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#888;margin-bottom:6px;">Tu código</div>
        <div style="font-size:26px;font-weight:800;letter-spacing:.04em;">${escHtml(code)}</div>
        <div style="font-size:14px;font-weight:700;color:#B23A3A;margin-top:8px;">${pct}% de descuento</div>
      </div>
      <p style="font-size:13px;line-height:1.6;color:#555;margin:0;">
        Aplícalo en tu próxima compra desde el sitio, en el paso de pago.
      </p>
    </div>
  `;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ZAYDE <onboarding@resend.dev>', // <-- reemplaza por tu remitente verificado en Resend
        to: [to],
        subject: `Tu cupón de socio ZAYDE — ${pct}% de descuento`,
        html,
      }),
    });

    const data = await resendRes.json().catch(() => ({}));

    if (!resendRes.ok) {
      console.error('Resend error:', data);
      res.status(502).json({ error: data.message || 'Resend rechazó el envío' });
      return;
    }

    res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Error llamando a Resend:', err);
    res.status(500).json({ error: 'No se pudo conectar con Resend' });
  }
}
