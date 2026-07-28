// /api/send-status-email.js
//
// Envía el correo real de confirmación / cambio de estatus del pedido,
// usando tu propia cuenta de Gmail como remitente (vía SMTP con
// "contraseña de aplicación"). A diferencia de Resend sin dominio
// verificado, esto SÍ manda a cualquier cliente real, gratis, sin
// necesitar un dominio propio.
//
// CÓMO ACTIVARLA:
// 1) En la cuenta de Gmail del negocio: activa la verificación en 2 pasos
//    (myaccount.google.com/security).
// 2) Genera una "Contraseña de aplicación" en
//    myaccount.google.com/apppasswords (copia el código de 16 letras).
// 3) En Vercel: Settings > Environment Variables, agrega:
//      GMAIL_USER         = tu_correo_del_negocio@gmail.com
//      GMAIL_APP_PASSWORD = el código de 16 letras (sin espacios)
// 4) Agrega "nodemailer" a tu package.json (ver el archivo que te dieron
//    junto a este) y vuelve a desplegar en Vercel.
//
// Límite de Gmail: ~500 correos salientes por día en una cuenta normal
// (de sobra para un negocio que está arrancando).

import nodemailer from 'nodemailer';

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

  try {
    const { to, name, orderNum, statusLabel } = req.body || {};

    if (!to || !orderNum || !statusLabel) {
      res.status(400).json({ error: 'Faltan datos para enviar el correo.' });
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
      html
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando email de estatus (Gmail):', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}
