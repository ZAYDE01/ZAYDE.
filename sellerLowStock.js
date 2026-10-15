// /api/_lib/sellerLowStock.js
//
// Módulo COMPARTIDO (no es un endpoint: la carpeta _lib no cuenta como función
// serverless en Vercel). Lo usan:
//   - /api/send-email.js     -> type "seller-low-stock" (lo llama el navegador tras comprar)
//   - /api/stripe-webhook.js -> directo, cuando el pago se confirma de verdad
//
// Avisa por correo al vendedor cuando, tras una compra, a una de sus tallas le
// queda 1 unidad o se agota.
//
// Seguridad:
//  - Quien llama solo dice QUÉ se compró (id de pieza, talla, cantidad).
//  - Aquí se lee el inventario REAL en Firestore, se busca al vendedor dueño de
//    la pieza en la base de datos y se arma el correo. Nadie elige destinatario
//    ni texto.
//  - Solo avisa cuando la compra CRUZÓ el umbral (de 2+ a 1, o de 1+ a 0) y,
//    aun así, máximo 1 correo cada 6 horas por pieza/talla/nivel. Ese tope vive
//    en Firestore (sellerStockAlerts), así que si el webhook y el navegador
//    avisan del mismo evento, el vendedor recibe UN solo correo.

import { layout, pieceRow, pill, table, note } from './sellerEvents.js';

const COOLDOWN_MS = 6 * 60 * 60 * 1000;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * @param {FirebaseFirestore.Firestore} db  admin.firestore()
 * @param {Array<{id:any,size:any,qty:any}>} rawItems  piezas compradas
 * @param {{ mailer: import('nodemailer').Transporter|null, siteUrl?: string }} opts
 * @returns {Promise<number>} correos enviados
 */
export async function notifySellerLowStock(db, rawItems, { mailer, siteUrl } = {}) {
  const items = Array.isArray(rawItems) ? rawItems.slice(0, 20) : [];
  if (!items.length) return 0;

  const stockSnap = await db.collection('inventory').doc('stock').get();
  const stock = (stockSnap.exists && stockSnap.data().items) || {};

  // Alertas por vendedor: { sellerId: [ {name, size, level} ] }
  const bySeller = {};
  const seen = new Set();
  for (const raw of items) {
    const pid = String(raw && raw.id != null ? raw.id : '').slice(0, 40);
    const size = String(raw && raw.size != null ? raw.size : '').slice(0, 20);
    const bought = Math.max(1, Math.min(50, parseInt(raw && raw.qty, 10) || 1));
    if (!pid || !size) continue;
    const key = pid + '|' + size;
    if (seen.has(key)) continue;
    seen.add(key);

    const now = stock[pid] && stock[pid][size];
    if (typeof now !== 'number' || now > 1) continue; // sin registro, o aún hay 2+ unidades
    const before = now + bought;
    const level = now === 0 ? 0 : 1;
    const crossed = level === 1 ? before > 1 : before > 0;
    if (!crossed) continue;

    // Dueño de la pieza: sale de la base de datos, nunca del navegador
    const [ov, pr] = await Promise.all([
      db.collection('admin_overrides').doc(pid).get(),
      db.collection('admin_products').doc(pid).get(),
    ]);
    const prod = Object.assign({}, pr.exists ? pr.data() : {}, ov.exists ? ov.data() : {});
    if (prod._deleted || !prod.sellerId) continue;
    const v = prod.sellerView || {};
    const name = ((prod.brand || v.brand) ? (prod.brand || v.brand) + ' ' : '') + (prod.name || v.name || 'tu pieza');

    // Tope de frecuencia
    const alertRef = db.collection('sellerStockAlerts').doc(encodeURIComponent(pid + '_' + size + '_' + level));
    const prev = await alertRef.get();
    if (prev.exists && Date.now() - (prev.data().at || 0) < COOLDOWN_MS) continue;
    await alertRef.set({ at: Date.now(), productId: pid, size, level, sellerId: prod.sellerId });

    (bySeller[prod.sellerId] = bySeller[prod.sellerId] || []).push({ name, size, level });
  }

  const sellerIds = Object.keys(bySeller);
  if (!sellerIds.length) return 0;
  if (!mailer) {
    console.error('seller-low-stock: sin GMAIL_USER / GMAIL_APP_PASSWORD, no se avisa a los vendedores.');
    return 0;
  }

  const site = siteUrl || process.env.ZAYDE_SITE_URL || 'https://zayde.com.mx';
  let sent = 0;
  for (const sid of sellerIds) {
    const sd = await db.collection('sellers').doc(sid).get();
    if (!sd.exists) continue;
    const seller = sd.data();
    if (seller.status !== 'activo' || !seller.email) continue;
    const list = bySeller[sid];
    const one = list.filter((a) => a.level === 1);
    const zero = list.filter((a) => a.level === 0);
    const subject = zero.length && !one.length
      ? (zero.length === 1 ? 'Se agotó la talla ' + zero[0].size + ' de ' + zero[0].name : 'Se agotaron tallas de tus piezas')
      : (list.length === 1 ? 'Queda 1 unidad de ' + list[0].name + ' (talla ' + list[0].size + ')' : 'Te quedan pocas unidades en ' + list.length + ' tallas');
    const rows = list.map((a) => pieceRow({
      title: a.name,
      sub: 'Talla ' + esc(a.size),
      right: a.level === 0 ? pill('Agotada', '#FBE6E1', '#9A3A26') : pill('Queda 1 unidad', '#FBF3DD', '#8A6A1F')
    }));
    const html = layout({
      siteUrl: site,
      preheader: subject,
      title: zero.length && !one.length ? 'Se agotó stock de tus piezas' : 'Te quedan pocas unidades',
      intro: 'Hola ' + esc(String(seller.name || '').split(' ')[0] || '') + ', después de una venta esto es lo que quedó en tu stock:',
      body: table(rows) + note('Si quieres reponer, avísale al equipo de ZAYDE.'),
      cta: 'Ver mi inventario'
    });
    try {
      await mailer.sendMail({ from: '"ZAYDE" <' + process.env.GMAIL_USER + '>', to: seller.email, subject, html });
      sent++;
    } catch (e) {
      console.error('seller-low-stock: no se pudo enviar a', sid, e && e.message);
    }
  }
  return sent;
}
