// /api/send-drop-email.js
//
// Envía el correo de "¡Ya empezó el Drop en vivo!" usando la MISMA cuenta
// de Gmail configurada para send-status-email.js (GMAIL_USER +
// GMAIL_APP_PASSWORD) — no necesitas configurar nada nuevo, ya con las
// mismas dos variables de entorno funciona.

import nodemailer from 'nodemailer';
import admin from 'firebase-admin';
import { checkRateLimit } from './_lib/rateLimit.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'))
    ),
  });
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }

  const db = admin.firestore();

  // [NUEVO] Máximo 10 peticiones por IP cada hora — misma razón que en
  // send-status-email.js: sin esto, cualquiera podía llamar este endpoint
  // sin límite.
  const rl = await checkRateLimit(db, req, 'send-drop-email', { windowMs: 60 * 60 * 1000, max: 10 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    const { to, name, dropText } = req.body || {};

    if (!to) {
      res.status(400).json({ error: 'Falta el correo del destinatario.' });
      return;
    }

    // [NUEVO] Antes este endpoint mandaba un correo a CUALQUIER "to" que
    // mandara el navegador, sin comprobar nada — cualquiera podía usar tu
    // Gmail como remitente falso hacia cualquier tercero. Ahora se exige
    // que el correo sí esté en tu lista real de suscriptores al drop.
    const subSnap = await db.collection('newsletterSubscribers').doc(encodeURIComponent(String(to).toLowerCase())).get();
    if (!subSnap.exists) {
      res.status(403).json({ error: 'Ese correo no está suscrito a los avisos de Drop.' });
      return;
    }

    const greetingName = name ? name.split(' ')[0] : 'Hola';
    const dropLabel = dropText || 'Drop en vivo';

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
        <h2 style="margin:0 0 16px;">ZAYDE</h2>
        <p>${greetingName}, ¡el <b>${dropLabel}</b> que estabas esperando ya empezó! 🔥</p>
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
      html
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando email de aviso de Drop (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}
