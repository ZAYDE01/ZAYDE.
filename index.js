// Avisos a vendedores: correo (extensión "Trigger Email") + push (FCM).
// Despliegue: firebase deploy --only functions   (requiere plan Blaze)
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const PORTAL = 'https://TU-DOMINIO.com/vendedor.html';   // <-- cambia por tu URL real
const LOW_MAX = 2;
const money = n => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 });
const norm = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// type: venta | apartada | liq | stock | ticket
async function notify(sellerId, type, title, body){
  if(!sellerId) return;
  const [pS, sS] = await Promise.all([db.doc('sellerPrefs/' + sellerId).get(), db.doc('sellers/' + sellerId).get()]);
  const pf = pS.data() || {}, sel = sS.data() || {};
  if(type !== 'ticket' && pf[type] === false) return;
  const to = pf.emailAddr || sel.email;
  if(pf.email !== false && to){
    await db.collection('mail').add({ to, message: { subject: 'ZAYDE · ' + title,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px"><h2>${title}</h2><p>${body}</p><p><a href="${PORTAL}">Abrir mi portal</a></p></div>` } });
  }
  if(pf.push && pf.fcmToken){
    await admin.messaging().send({ token: pf.fcmToken, notification: { title: 'ZAYDE · ' + title, body }, webpush: { fcmOptions: { link: PORTAL } } })
      .catch(e => { if(/registration-token/.test(e.code || '')) return db.doc('sellerPrefs/' + sellerId).set({ fcmToken: admin.firestore.FieldValue.delete() }, { merge: true }); });
  }
}

exports.ventaNueva = onDocumentCreated('sellerSales/{id}', ev => {
  const s = ev.data.data(); if(s.status === 'devuelto') return;
  return notify(s.sellerId, 'venta', 'Venta nueva', `${s.productName || s.name || 'Tu pieza'} se vendió${s.gross ? ' por ' + money(s.gross) : ''}.`);
});

exports.piezaApartada = onDocumentUpdated('sellerSubmissions/{id}', ev => {
  const b = ev.data.before.data(), a = ev.data.after.data();
  if(norm(b.status) === 'apartada' || norm(a.status) !== 'apartada') return;
  return notify(a.sellerId, 'apartada', 'Pieza apartada', `${a.name || 'Tu pieza'} fue apartada por un cliente.`);
});

exports.liquidacionHecha = onDocumentCreated('sellerPayouts/{id}', ev => {
  const p = ev.data.data(), amt = p.net ?? p.amount ?? p.total;
  return notify(p.sellerId, 'liq', 'Liquidación hecha', amt != null ? `Se registró una liquidación por ${money(amt)}.` : 'Se registró una nueva liquidación a tu favor.');
});

exports.respuestaSoporte = onDocumentUpdated('sellerTickets/{id}', ev => {
  const b = ev.data.before.data(), a = ev.data.after.data();
  if(a.reply === b.reply && a.status === b.status) return;
  return notify(a.sellerId, 'ticket', 'Respuesta a ' + a.folio, a.reply ? String(a.reply).slice(0, 200) : 'Tu reporte cambió de estado.');
});

// Stock bajo: compara inventory/stock antes y después; avisa al cruzar a <= LOW_MAX.
exports.stockBajo = onDocumentWritten('inventory/stock', async ev => {
  const b = (ev.data.before.data() || {}).items || {}, a = (ev.data.after.data() || {}).items || {};
  for(const pid of Object.keys(a)){
    for(const size of Object.keys(a[pid] || {})){
      const now = Number(a[pid][size]), was = Number((b[pid] || {})[size]);
      if(!(now >= 1 && now <= LOW_MAX && (isNaN(was) || was > LOW_MAX))) continue;
      let pr = (await db.doc('admin_products/' + pid).get()).data();
      if(!pr){ const q = await db.collection('admin_products').where('id', '==', isNaN(+pid) ? pid : +pid).limit(1).get(); pr = q.empty ? null : q.docs[0].data(); }
      if(pr && pr.sellerId) await notify(pr.sellerId, 'stock', 'Stock bajo', `${pr.name || 'Tu pieza'} · talla ${size}: quedan ${now}.`);
    }
  }
});
