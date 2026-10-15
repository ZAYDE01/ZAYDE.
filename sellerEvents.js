// /api/_lib/sellerEvents.js
//
// Correos automáticos y profesionales al vendedor. Módulo COMPARTIDO (la carpeta
// _lib no cuenta como función serverless). Lo usa /api/send-email.js con
// type "seller-event", SOLO para administradores.
//
// Eventos:
//   - "sale-status" : una venta suya cambió de estado (en verificación, preparando,
//                     enviada, entregada) o se devolvió / canceló.
//   - "commission"  : ZAYDE definió la comisión de una venta (ya sabe lo que le toca).
//   - "payout"      : ZAYDE registró una liquidación (pago) a su favor.
//   - "pieces"      : ZAYDE publicó piezas suyas en el inventario.
//
// PRIVACIDAD: ningún correo lleva nombre, teléfono, dirección, correo ni número
// de pedido del comprador. Solo datos de la pieza y de lo que le toca al vendedor.
//
// El destinatario SIEMPRE sale de la colección "sellers" (nunca del navegador),
// y solo si el vendedor está activo y tiene correo. Cada aviso deja una marca en
// Firestore para no repetirse si se vuelve a disparar.

const TZ = 'America/Mexico_City';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '';
const uniq = (a) => Array.from(new Set(a));
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : '';

// ---------------------------------------------------------------
// Plantilla base (misma identidad que el resto de correos de ZAYDE)
// ---------------------------------------------------------------
export function layout({ preheader, title, intro, body, cta, siteUrl }) {
  return '<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#F4F3EF;">' +
    '<span style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(preheader || title) + '</span>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F3EF;padding:24px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#0E0E10;">' +
    '<tr><td style="background:#0E0E10;padding:18px 24px;color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.45em;">ZAYDE</td></tr>' +
    '<tr><td style="padding:26px 24px 8px;">' +
    '<h1 style="margin:0 0 8px;font-size:21px;line-height:1.3;">' + esc(title) + '</h1>' +
    (intro ? '<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4A4C55;">' + intro + '</p>' : '') +
    '</td></tr>' +
    '<tr><td style="padding:0 24px 8px;">' + body + '</td></tr>' +
    '<tr><td style="padding:12px 24px 26px;">' +
    '<a href="' + esc(siteUrl) + '/vendedor" style="display:inline-block;background:#0E0E10;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:700;font-size:14px;">' + esc(cta || 'Abrir mi portal de vendedor') + '</a>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 24px 22px;border-top:1px solid #EEEDE8;color:#8A8C95;font-size:12px;line-height:1.6;">' +
    'Recibes este correo porque eres vendedor de ZAYDE. Por privacidad, nunca incluimos datos de los compradores. ' +
    'Si algo no cuadra, responde a este correo o escríbele al equipo de ZAYDE.' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

export const pill = (text, bg, fg) =>
  '<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;background:' + bg + ';color:' + fg + ';">' + esc(text) + '</span>';

// Fila de pieza: imagen opcional + título + subtítulo + columna derecha
export function pieceRow({ img, title, sub, right }) {
  const safeImg = httpsOnly(img);
  return '<tr>' +
    (safeImg
      ? '<td width="64" style="padding:12px 12px 12px 0;border-bottom:1px solid #EEEDE8;vertical-align:top;"><img src="' + esc(safeImg) + '" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:6px;background:#EEEDE8;"></td>'
      : '') +
    '<td style="padding:12px 0;border-bottom:1px solid #EEEDE8;vertical-align:top;font-size:14px;line-height:1.45;">' +
    '<b>' + esc(title) + '</b>' + (sub ? '<br><span style="color:#6B6D76;font-size:13px;">' + sub + '</span>' : '') + '</td>' +
    (right ? '<td align="right" style="padding:12px 0 12px 12px;border-bottom:1px solid #EEEDE8;vertical-align:top;font-size:14px;white-space:nowrap;">' + right + '</td>' : '') +
    '</tr>';
}
export const table = (rows) => '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' + rows.join('') + '</table>';
export const note = (html) => '<p style="margin:14px 0 0;padding:12px 14px;background:#F1F0EC;border-radius:6px;font-size:13px;line-height:1.55;color:#33353D;">' + html + '</p>';

// ---------------------------------------------------------------
// Utilidades de datos
// ---------------------------------------------------------------
async function loadSeller(db, cache, sid) {
  const key = String(sid);
  if (!(key in cache)) {
    const d = await db.collection('sellers').doc(key).get();
    const s = d.exists ? d.data() : null;
    cache[key] = (s && s.status === 'activo' && s.email) ? s : null;
  }
  return cache[key];
}
const saleTitle = (s) => (s.brand ? s.brand + ' ' : '') + (s.productName || 'Pieza');
const saleSub = (s) => (s.size ? 'Talla ' + esc(s.size) + ' · ' : '') + 'Cantidad ' + esc(s.qty || 1);

function groupBySeller(list, getSid) {
  const out = {};
  list.forEach((x) => { const k = String(getSid(x)); (out[k] = out[k] || []).push(x); });
  return out;
}

// ---------------------------------------------------------------
// Evento: cambio de estado de una venta (incluye devoluciones/cancelaciones)
// ---------------------------------------------------------------
const STATUS_INFO = {
  'verificando':     { label: 'En verificación', bg: '#FBF3DD', fg: '#8A6A1F' },
  'en verificacion': { label: 'En verificación', bg: '#FBF3DD', fg: '#8A6A1F' },
  'preparando':      { label: 'Preparando',      bg: '#FBF3DD', fg: '#8A6A1F' },
  'enviado':         { label: 'Enviada',         bg: '#E4E9FB', fg: '#2E3F94' },
  'en camino':       { label: 'En camino',       bg: '#E4E9FB', fg: '#2E3F94' },
  'entregado':       { label: 'Entregada',       bg: '#E0F2E8', fg: '#1F6B45' },
  'devuelto':        { label: 'Devuelta / cancelada', bg: '#FBE6E1', fg: '#9A3A26' }
};

function statusNote(s, st) {
  if (st === 'verificando' || st === 'en verificacion') return 'Estamos verificando la autenticidad y el estado de la pieza.';
  if (st === 'preparando') return 'La pieza ya está lista para empacarse y enviarse.';
  if (st === 'enviado' || st === 'en camino') return 'La pieza ya va en camino al comprador.';
  if (st === 'entregado') return s.releaseAt ? 'Se entregó. Tu pago se libera el ' + esc(fmtDate(s.releaseAt)) + '.' : 'Se entregó. Pronto quedará lista para liquidar.';
  if (st === 'devuelto') {
    if (s.settled && Number(s.clawback) > 0) return 'Como ya se te había liquidado, ' + esc(money(s.clawback)) + ' se descontarán de tu próxima liquidación.';
    return 'Esta venta ya no suma a tu saldo.';
  }
  return '';
}

async function saleStatusEvent(db, send, cache, saleIds) {
  const ids = uniq((Array.isArray(saleIds) ? saleIds : []).map(String)).slice(0, 50);
  if (!ids.length) return 0;
  const snaps = await Promise.all(ids.map((id) => db.collection('sellerSales').doc(id).get()));
  const items = [];
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const s = snap.data(); const st = norm(s.status);
    if (!STATUS_INFO[st] || !s.sellerId) return;
    if (s.notifiedStatus === st) return; // ya se avisó de este mismo estado
    items.push({ id: snap.id, s, st });
  });
  let sent = 0;
  const groups = groupBySeller(items, (x) => x.s.sellerId);
  for (const sid of Object.keys(groups)) {
    const seller = await loadSeller(db, cache, sid);
    if (!seller) continue;
    const list = groups[sid];
    const rows = list.map(({ s, st }) => pieceRow({
      title: saleTitle(s), sub: saleSub(s) + '<br>' + statusNote(s, st),
      right: pill(STATUS_INFO[st].label, STATUS_INFO[st].bg, STATUS_INFO[st].fg)
    }));
    const only = list.length === 1 ? list[0] : null;
    const allReturned = list.every((x) => x.st === 'devuelto');
    const subject = only
      ? (only.st === 'devuelto' ? 'Se devolvió una venta: ' + saleTitle(only.s) : 'Tu venta de ' + saleTitle(only.s) + ': ' + STATUS_INFO[only.st].label.toLowerCase())
      : (allReturned ? 'Se devolvieron ' + list.length + ' ventas tuyas' : 'Actualización de ' + list.length + ' ventas tuyas');
    const html = layout({
      siteUrl: send.siteUrl,
      preheader: subject,
      title: only ? (only.st === 'devuelto' ? 'Se devolvió una de tus ventas' : 'Tu venta avanzó') : 'Actualización de tus ventas',
      intro: 'Hola ' + esc(String(seller.name || '').split(' ')[0] || '') + ', esto es lo más reciente de tus piezas:',
      body: table(rows)
    });
    if (await send(seller.email, subject, html)) {
      sent++;
      const batch = db.batch();
      list.forEach(({ id, st }) => batch.update(db.collection('sellerSales').doc(id), { notifiedStatus: st, notifiedStatusAt: Date.now() }));
      await batch.commit();
    }
  }
  return sent;
}

// ---------------------------------------------------------------
// Evento: comisión definida
// ---------------------------------------------------------------
async function commissionEvent(db, send, cache, saleIds) {
  const ids = uniq((Array.isArray(saleIds) ? saleIds : []).map(String)).slice(0, 50);
  if (!ids.length) return 0;
  const snaps = await Promise.all(ids.map((id) => db.collection('sellerSales').doc(id).get()));
  const items = [];
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const s = snap.data();
    if (!s.sellerId || s.net == null || s.commission == null) return;
    if (s.commissionNotifiedNet === s.net) return;
    items.push({ id: snap.id, s });
  });
  let sent = 0;
  const groups = groupBySeller(items, (x) => x.s.sellerId);
  for (const sid of Object.keys(groups)) {
    const seller = await loadSeller(db, cache, sid);
    if (!seller) continue;
    const list = groups[sid];
    const rows = list.map(({ s }) => pieceRow({
      title: saleTitle(s),
      sub: saleSub(s) + '<br>Venta ' + esc(money(s.gross)) + ' · Comisión ' + esc(money(s.commission)) + (s.commissionPct != null ? ' (' + esc(s.commissionPct) + '%)' : ''),
      right: '<b>' + esc(money(s.net)) + '</b><br><span style="color:#6B6D76;font-size:12px;">te toca</span>'
    }));
    const total = list.reduce((t, x) => t + (Number(x.s.net) || 0), 0);
    const subject = list.length === 1 ? 'Ya definimos tu comisión: ' + saleTitle(list[0].s) : 'Ya definimos la comisión de ' + list.length + ' ventas tuyas';
    const html = layout({
      siteUrl: send.siteUrl,
      preheader: subject,
      title: 'Ya sabes lo que te toca',
      intro: 'Hola ' + esc(String(seller.name || '').split(' ')[0] || '') + ', definimos la comisión de ' + (list.length === 1 ? 'una venta tuya' : list.length + ' ventas tuyas') + ':',
      body: table(rows) + note('Total que te toca: <b>' + esc(money(total)) + '</b>. Se libera unos días después de que se entregue la pieza.')
    });
    if (await send(seller.email, subject, html)) {
      sent++;
      const batch = db.batch();
      list.forEach(({ id, s }) => batch.update(db.collection('sellerSales').doc(id), { commissionNotifiedNet: s.net }));
      await batch.commit();
    }
  }
  return sent;
}

// ---------------------------------------------------------------
// Evento: liquidación registrada
// ---------------------------------------------------------------
async function payoutEvent(db, send, cache, payoutId) {
  if (!payoutId) return 0;
  const ref = db.collection('sellerPayouts').doc(String(payoutId));
  const snap = await ref.get();
  if (!snap.exists) return 0;
  const p = snap.data();
  if (p.notifiedAt || !p.sellerId) return 0;
  const seller = await loadSeller(db, cache, p.sellerId);
  if (!seller) return 0;

  const saleIds = (Array.isArray(p.saleIds) ? p.saleIds : []).slice(0, 40).map(String);
  const saleSnaps = await Promise.all(saleIds.map((id) => db.collection('sellerSales').doc(id).get()));
  const sales = saleSnaps.filter((x) => x.exists).map((x) => x.data());
  const shown = sales.slice(0, 15);
  const rows = shown.map((s) => pieceRow({ title: saleTitle(s), sub: saleSub(s), right: s.net != null ? esc(money(s.net)) : '' }));
  const more = (Number(p.saleCount) || sales.length) - shown.length;

  const subject = 'Registramos tu liquidación de ' + money(p.amount);
  const html = layout({
    siteUrl: send.siteUrl,
    preheader: subject,
    title: 'Te registramos un pago',
    intro: 'Hola ' + esc(String(seller.name || '').split(' ')[0] || '') + ', ZAYDE registró una liquidación a tu favor:',
    body:
      '<p style="margin:0 0 4px;font-size:13px;color:#6B6D76;">Monto</p>' +
      '<p style="margin:0 0 6px;font-size:34px;font-weight:800;letter-spacing:-.02em;">' + esc(money(p.amount)) + '</p>' +
      '<p style="margin:0 0 14px;font-size:13px;color:#6B6D76;">' + esc(fmtDate(p.createdAt)) + ' · ' + esc(p.saleCount || sales.length) + ((p.saleCount || sales.length) === 1 ? ' pieza' : ' piezas') + '</p>' +
      (p.note ? note('Referencia: <b>' + esc(p.note) + '</b>') : '') +
      (Number(p.clawbackTotal) > 0 ? note('Incluye un descuento de <b>' + esc(money(p.clawbackTotal)) + '</b> por devoluciones de piezas que ya se te habían pagado.') : '') +
      (rows.length ? '<p style="margin:18px 0 4px;font-size:13px;font-weight:700;">Piezas incluidas</p>' + table(rows) + (more > 0 ? '<p style="margin:8px 0 0;font-size:13px;color:#6B6D76;">y ' + more + ' más. Verás el detalle completo en tu portal.</p>' : '') : ''),
    cta: 'Ver mis liquidaciones'
  });
  if (await send(seller.email, subject, html)) {
    await ref.update({ notifiedAt: Date.now() });
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------
// Evento: piezas publicadas en el inventario del vendedor
// ---------------------------------------------------------------
function sizesText(stockMap) {
  if (!stockMap || typeof stockMap !== 'object') return '';
  const keys = Object.keys(stockMap).slice(0, 14);
  if (!keys.length) return '';
  return keys.map((k) => {
    const q = Number(stockMap[k]) || 0;
    return esc(k) + ' · ' + (q >= 900 ? 'disponible' : q);
  }).join(' &nbsp;|&nbsp; ');
}

async function piecesEvent(db, send, cache, body) {
  const sid = body && body.sellerId ? String(body.sellerId) : '';
  if (!sid) return 0;
  const seller = await loadSeller(db, cache, sid);
  if (!seller) return 0;

  // La lista puede traer datos de respaldo (los manda el administrador, ya autenticado),
  // por si el espejo de la pieza en Firestore aún no terminó de guardarse.
  const hints = {};
  (Array.isArray(body.pieces) ? body.pieces : []).slice(0, 80).forEach((p) => { if (p && p.id != null) hints[String(p.id)] = p; });
  const pids = uniq((Array.isArray(body.productIds) ? body.productIds : Object.keys(hints)).map(String)).slice(0, 80);
  if (!pids.length) return 0;

  const stockSnap = await db.collection('inventory').doc('stock').get();
  const live = (stockSnap.exists && stockSnap.data().items) || {};

  const fresh = [];
  for (const pid of pids) {
    const noticeRef = db.collection('sellerPieceNotices').doc(encodeURIComponent(sid + '__' + pid));
    const prevNotice = await noticeRef.get();
    if (prevNotice.exists) continue; // ya se le avisó de esta pieza
    const [ov, pr] = await Promise.all([
      db.collection('admin_overrides').doc(pid).get(),
      db.collection('admin_products').doc(pid).get()
    ]);
    const prod = Object.assign({}, pr.exists ? pr.data() : {}, ov.exists ? ov.data() : {});
    if (prod._deleted) continue;
    const h = hints[pid] || {};
    const v = prod.sellerView || {};
    const img = httpsOnly(Array.isArray(prod.images) ? (prod.images.map((i) => (typeof i === 'string' ? i : (i && (i.url || i.src)) || '')).find(httpsOnly) || '') : '') || httpsOnly(v.image) || httpsOnly(h.image);
    fresh.push({
      pid, noticeRef,
      name: ((prod.brand || v.brand || h.brand) ? (prod.brand || v.brand || h.brand) + ' ' : '') + (prod.name || v.name || h.name || 'Pieza'),
      price: prod.price || v.price || h.price || 0,
      img,
      stock: (live[pid] && typeof live[pid] === 'object') ? live[pid] : (prod.stock || v.stock || h.stock || {})
    });
  }
  if (!fresh.length) return 0;

  const shown = fresh.slice(0, 25);
  const rows = shown.map((p) => pieceRow({
    img: p.img, title: p.name,
    sub: sizesText(p.stock) || 'Sin tallas registradas',
    right: p.price ? esc(money(p.price)) : ''
  }));
  const subject = fresh.length === 1 ? 'Publicamos tu pieza en ZAYDE: ' + fresh[0].name : 'Publicamos ' + fresh.length + ' piezas tuyas en ZAYDE';
  const html = layout({
    siteUrl: send.siteUrl,
    preheader: subject,
    title: fresh.length === 1 ? 'Tu pieza ya está en ZAYDE' : 'Tu inventario ya está en ZAYDE',
    intro: 'Hola ' + esc(String(seller.name || '').split(' ')[0] || '') + ', ya publicamos ' + (fresh.length === 1 ? 'esta pieza tuya' : 'estas ' + fresh.length + ' piezas tuyas') + '. Aparecen en tu portal con su foto y su stock en tiempo real:',
    body: table(rows) + (fresh.length > shown.length ? '<p style="margin:8px 0 0;font-size:13px;color:#6B6D76;">y ' + (fresh.length - shown.length) + ' más en tu portal.</p>' : '') +
      note('Te avisaremos por correo cuando se venda una pieza, cuando una talla esté por agotarse y cada vez que avance una venta.'),
    cta: 'Ver mi inventario'
  });
  if (await send(seller.email, subject, html)) {
    const batch = db.batch();
    fresh.forEach((p) => batch.set(p.noticeRef, { sellerId: sid, productId: p.pid, at: Date.now() }));
    await batch.commit();
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------
/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {import('nodemailer').Transporter} mailer
 * @param {object} body  { event, ... }
 * @param {{ siteUrl?: string }} opts
 * @returns {Promise<{ sent:number }>}
 */
export async function sendSellerEvent(db, mailer, body, opts = {}) {
  const siteUrl = opts.siteUrl || process.env.ZAYDE_SITE_URL || 'https://zayde.com.mx';
  const send = async (to, subject, html) => {
    try {
      await mailer.sendMail({ from: '"ZAYDE" <' + process.env.GMAIL_USER + '>', to, subject, html });
      return true;
    } catch (e) {
      console.error('seller-event: no se pudo enviar el correo:', e && e.message);
      return false;
    }
  };
  send.siteUrl = siteUrl;
  const cache = {};
  const ev = body && body.event;
  let sent = 0;
  if (ev === 'sale-status') sent = await saleStatusEvent(db, send, cache, body.saleIds);
  else if (ev === 'commission') sent = await commissionEvent(db, send, cache, body.saleIds);
  else if (ev === 'payout') sent = await payoutEvent(db, send, cache, body.payoutId);
  else if (ev === 'pieces') sent = await piecesEvent(db, send, cache, body);
  else { const err = new Error('invalid-event'); err.code = 'invalid-event'; throw err; }
  return { sent };
}
