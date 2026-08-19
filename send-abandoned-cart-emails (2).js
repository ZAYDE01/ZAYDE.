// api/send-abandoned-cart-emails.js
// (sin cambios de lógica — solo se retocó para refrescar el estado del check en GitHub)
//
// Manda un correo de recordatorio a los carritos que quedaron a medias:
// el cliente escribió su email en el checkout (ver zySaveAbandonedCart en
// index.html) pero nunca confirmó la orden.
//
// NO se llama desde el navegador — es un endpoint protegido que se llama
// por cron (Vercel Cron Jobs, ver vercel.json), una vez por hora.
//
// ---- Setup ----
// 1) Ya tienes "nodemailer" y "firebase-admin" en package.json, no hay que
//    instalar nada nuevo.
// 2) Variables de entorno en Vercel (ya las tienes casi todas):
//      GMAIL_USER                    — ya la usas en send-status-email.js
//      GMAIL_APP_PASSWORD            — ya la usas en send-status-email.js
//      FIREBASE_SERVICE_ACCOUNT_B64  — ya la usas en el webhook de Stripe
//      CRON_SECRET                   — FALTA, agrégala en Vercel (Settings →
//                                       Environment Variables). Puede ser
//                                       cualquier string largo y random,
//                                       por ejemplo generado con:
//                                       openssl rand -hex 32
// 3) En vercel.json (ver el archivo actualizado que te dejo aparte) ya
//    quedó agregado el cron que llama este endpoint cada hora.

import nodemailer from 'nodemailer';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(
        Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf-8')
      )
    ),
  });
}
const db = admin.firestore();

let cachedTransporter = null;
function getTransporter(){
  if(cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  return cachedTransporter;
}

// No mandar antes de que pase este tiempo desde la última vez que se tocó
// el carrito (para no molestar a alguien que sigue comprando en ese momento),
// ni después de este otro (un carrito de hace 5 días ya no vale la pena
// recordarlo, y evita reactivar algo muy viejo).
const MIN_AGE_MS = 2 * 60 * 60 * 1000;   // 2 horas
const MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // 5 días

const SITE_URL = 'https://zayde-kappa.vercel.app'; // [AJUSTA si tu dominio final es otro, ej. zayde.com.mx]

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

export default async function handler(req, res) {
  const secret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
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
        await getTransporter().sendMail({
          from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
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
}
