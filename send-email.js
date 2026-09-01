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
//
// El resto de los campos del body son los mismos que ya mandaba tu
// frontend a cada endpoint original — no cambia nada más que la URL
// (ahora /api/send-email) y que hay que agregar "type".
//
// Variables de entorno necesarias (las mismas de antes, sin nada nuevo):
//   GMAIL_USER, GMAIL_APP_PASSWORD   -> para type "status", "drop" y "otp"
//   FIREBASE_SERVICE_ACCOUNT_B64     -> para type "status" y "drop"
//   RESEND_API_KEY                   -> para type "coupon"

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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const { type } = req.body || {};

  if (type === 'status') return sendStatusEmail(req, res);
  if (type === 'drop') return sendDropEmail(req, res);
  if (type === 'coupon') return sendCouponEmail(req, res);
  if (type === 'otp') return sendOtpEmail(req, res);

  res.status(400).json({ error: 'Falta "type" o no es válido. Usa "status", "drop", "coupon" u "otp".' });
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
    const { to, name, orderNum, statusLabel } = req.body || {};

    if (!to || !orderNum || !statusLabel) {
      res.status(400).json({ error: 'Faltan datos para enviar el correo.' });
      return;
    }

    const orderSnap = await db.collection('orders').doc(String(orderNum)).get();
    if (!orderSnap.exists || String(orderSnap.data().email || '').toLowerCase() !== String(to).toLowerCase()) {
      res.status(403).json({ error: 'El pedido y el correo no coinciden.' });
      return;
    }

    const greetingName = name ? name.split(' ')[0] : 'Hola';

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
        <h2 style="margin:0 0 16px;">ZAYDE</h2>
        <p>${greetingName}, tu pedido <b>${orderNum}</b> tiene una actualización:</p>
        <p style="font-size:18px; font-weight:700; margin:16px 0; padding:12px 16px; background:#F1F0EC; border-radius:6px;">
          ${statusLabel}
        </p>
        <p>Puedes revisar el detalle completo de tu pedido en cualquier momento desde la sección "Rastrear pedido" en el sitio, usando tu número de pedido o teléfono.</p>
        <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Gracias por tu compra en ZAYDE.</p>
      </div>
    `;

    await getTransporter().sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to,
      subject: `Tu pedido ${orderNum} — ${statusLabel}`,
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
    const { to, name, dropText } = req.body || {};

    if (!to) {
      res.status(400).json({ error: 'Falta el correo del destinatario.' });
      return;
    }

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
      html,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando email de aviso de Drop (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}

// ============================================================
// type: "otp"  (antes se mandaba con EmailJS, plantilla default sin
// editar — ver comentario al inicio del archivo)
// ============================================================
async function sendOtpEmail(req, res) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    res.status(500).json({ error: 'Faltan GMAIL_USER / GMAIL_APP_PASSWORD en las variables de entorno de Vercel.' });
    return;
  }

  const db = admin.firestore();

  // Límite más estricto que "status"/"drop": este endpoint no requiere que
  // el correo ya exista en ningún lado (se usa tanto para login como para
  // registro), así que sin rate limit alguien podría usarlo para mandar
  // spam de "códigos" a un correo ajeno una y otra vez.
  const rl = await checkRateLimit(db, req, 'send-otp-email', { windowMs: 15 * 60 * 1000, max: 5 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    const { to, code } = req.body || {};

    if (!to || !code) {
      res.status(400).json({ error: 'Falta el correo o el código.' });
      return;
    }
    if (!/^\d{4,8}$/.test(String(code))) {
      res.status(400).json({ error: 'Código inválido.' });
      return;
    }

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:420px; margin:0 auto; padding:32px 24px; color:#0E0E10; background:#ffffff;">
        <h2 style="margin:0 0 20px; letter-spacing:.5px;">ZAYDE</h2>
        <p style="font-size:14px; line-height:1.6; margin:0 0 18px;">
          Este es tu código de acceso para iniciar sesión en ZAYDE:
        </p>
        <div style="font-size:32px; font-weight:800; letter-spacing:6px; text-align:center; padding:16px 0; margin:0 0 18px; background:#F1F0EC; border-radius:8px;">
          ${code}
        </div>
        <p style="font-size:13px; line-height:1.6; color:#6B6D76; margin:0 0 6px;">
          Es válido por unos minutos. No lo compartas con nadie: nuestro equipo nunca te lo va a pedir por teléfono, WhatsApp o redes sociales.
        </p>
        <p style="font-size:13px; line-height:1.6; color:#6B6D76; margin:0;">
          Si tú no pediste este código, puedes ignorar este correo.
        </p>
        <p style="color:#9A9AA2; font-size:12px; margin-top:28px; border-top:1px solid #EEEDE8; padding-top:16px;">ZAYDE · zayde.com.mx</p>
      </div>
    `;

    await getTransporter().sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to,
      subject: `${code} es tu código de acceso a ZAYDE`,
      html,
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando código de acceso (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
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

  const pct = value || 10;
  const firstName = (name || '').trim().split(' ')[0] || 'Hola';

  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111;">
      <p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:0 0 18px;">ZAYDE — Cliente frecuente</p>
      <h1 style="font-size:20px;margin:0 0 14px;">¡Gracias por ser cliente frecuente, ${firstName}!</h1>
      <p style="font-size:14px;line-height:1.6;margin:0 0 22px;">
        Por tus compras con nosotros ya calificas como socio ZAYDE. Aquí tienes tu cupón de descuento:
      </p>
      <div style="border:2px dashed #111;border-radius:10px;padding:18px;text-align:center;margin-bottom:22px;">
        <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#888;margin-bottom:6px;">Tu código</div>
        <div style="font-size:26px;font-weight:800;letter-spacing:.04em;">${code}</div>
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
