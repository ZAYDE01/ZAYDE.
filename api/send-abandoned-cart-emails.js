// api/send-abandoned-cart-emails.js
//
// Manda un correo de recordatorio a los carritos que quedaron a medias:
// el cliente escribió su email en el checkout (ver zySaveAbandonedCart en
// index.html) pero nunca confirmó la orden.
//
// NO se llama desde el navegador — es un endpoint protegido que debe
// llamarse por cron (Vercel Cron Jobs, ver vercel.json más abajo), una vez
// por hora es un buen punto de partida.
//
// ---- Setup ----
// 1) Instala las dependencias si no las tienes ya:
//      npm install firebase-admin resend
// 2) Variables de entorno en Vercel (Project Settings → Environment Variables):
//      RESEND_API_KEY        — ya la usas en send-status-email.js / send-drop-email.js
//      CRON_SECRET            — genera un valor random (ej. openssl rand -hex 32);
//                                protege este endpoint para que solo el cron lo pueda llamar
//      FIREBASE_SERVICE_ACCOUNT_JSON — el JSON de la cuenta de servicio de Firebase,
//                                como un solo string (mismo que uses en tus otras
//                                funciones que leen/escriben Firestore desde el servidor)
// 3) Agrega a vercel.json (créalo en la raíz si no existe):
//      {
//        "crons": [
//          { "path": "/api/send-abandoned-cart-emails?secret=TU_CRON_SECRET", "schedule": "0 * * * *" }
//        ]
//      }
//    (Vercel Cron llama por GET; el secret también se puede mandar como
//    header Authorization: Bearer TU_CRON_SECRET si prefieres no ponerlo
//    en la URL del cron — este archivo acepta ambas formas.)

const { Resend } = require('resend');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    ),
  });
}
const db = admin.firestore();
const resend = new Resend(process.env.RESEND_API_KEY);

// No mandar antes de que pase este tiempo desde la última vez que se tocó
// el carrito (para no molestar a alguien que sigue comprando en ese momento),
// ni después de este otro (un carrito de hace 5 días ya no vale la pena
// recordarlo, y evita reactivar algo muy viejo).
const MIN_AGE_MS = 2 * 60 * 60 * 1000;   // 2 horas
const MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // 5 días

const SITE_URL = 'https://zayde-kappa.vercel.app'; // [AJUSTA a tu dominio final]

function fmtMXN(n) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
}

function buildEmailHTML(cartDoc) {
  const rows = cartDoc.items.map(it => `
    <tr>
      <td style="padding:8px 0;font-size:14px;color:#0E0E10;">
        ${it.brand ? `${it.brand} — ` : ''}${it.name}${it.size ? ` · Talla ${it.size}` : ''}${it.qty > 1 ? ` × ${it.qty}` : ''}
      </td>
      <td style="padding:8px 0;font-size:14px;color:#0E0E10;text-align:right;white-space:nowrap;">
        ${fmtMXN(it.price * it.qty)}
      </td>
    </tr>`).join('');

  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="font-size:18px;letter-spacing:-.01em;">Dejaste algo en tu carrito</h2>
    <p style="font-size:14px;color:#555;line-height:1.5;">
      Tus piezas siguen apartadas, pero el stock es limitado — algunas tallas
      pueden agotarse. Retómalo cuando quieras:
    </p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      ${rows}
      <tr><td style="padding-top:10px;font-size:14px;font-weight:700;">Total</td>
          <td style="padding-top:10px;font-size:14px;font-weight:700;text-align:right;">${fmtMXN(cartDoc.total)}</td></tr>
    </table>
    <a href="${SITE_URL}" style="display:inline-block;background:#0E0E10;color:#fff;text-decoration:none;
       padding:12px 22px;border-radius:4px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;">
      Volver a mi carrito
    </a>
    <p style="font-size:11px;color:#999;margin-top:24px;">
      Recibiste este correo porque dejaste tu email al iniciar una compra en ZAYDE.
    </p>
  </div>`;
}

module.exports = async (req, res) => {
  const secret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const now = Date.now();
    const snap = await db.collection('abandonedCarts')
      .where('status', '==', 'pending')
      .where('emailSent', '==', false)
      .get();

    let sent = 0, skipped = 0;
    for (const doc of snap.docs) {
      const cartDoc = doc.data();
      const age = now - (cartDoc.updatedAt || 0);
      if (age < MIN_AGE_MS || age > MAX_AGE_MS || !cartDoc.items || !cartDoc.items.length) {
        skipped++;
        continue;
      }
      try {
        await resend.emails.send({
          from: 'ZAYDE <pedidos@TU_DOMINIO.com>', // [AJUSTA al remitente que ya verificaste en Resend]
          to: cartDoc.email,
          subject: 'Dejaste algo en tu carrito — ZAYDE',
          html: buildEmailHTML(cartDoc),
        });
        await doc.ref.set({ emailSent: true, emailSentAt: now }, { merge: true });
        sent++;
      } catch (sendErr) {
        console.error('No se pudo enviar recordatorio a', cartDoc.email, sendErr);
      }
    }

    return res.status(200).json({ ok: true, sent, skipped, checked: snap.size });
  } catch (e) {
    console.error('Error en send-abandoned-cart-emails:', e);
    return res.status(500).json({ error: 'Error interno' });
  }
};
