// /api/send-status-email.js
//
// Función serverless de Vercel: envía el correo real de confirmación /
// cambio de estatus del pedido, usando Resend (https://resend.com).
//
// CÓMO ACTIVARLA:
// 1) Crea una cuenta gratis en https://resend.com (tiene plan gratuito).
// 2) En Resend, ve a "API Keys" y crea una llave (empieza con "re_").
// 3) En Vercel: Settings > Environment Variables, agrega:
//      RESEND_API_KEY   = la llave que copiaste de Resend
//      ZY_FROM_EMAIL    = el correo remitente, por ejemplo
//                          "ZAYDE <pedidos@tudominio.com>"
//                          (para usar tu propio dominio, verifícalo en
//                          Resend > Domains; mientras no lo verifiques,
//                          puedes usar "onboarding@resend.dev" como
//                          remitente de pruebas)
// 4) Vuelve a desplegar el sitio en Vercel después de guardar las
//    variables de entorno.
// 5) Este archivo necesita el paquete "resend" instalado: ya está listado
//    en el package.json incluido, Vercel lo instala solo al desplegar.

const { Resend } = require('resend');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Falta configurar RESEND_API_KEY en las variables de entorno de Vercel.'
    });
    return;
  }

  try {
    const { to, name, orderNum, statusLabel } = req.body || {};
    if (!to || !orderNum || !statusLabel) {
      res.status(400).json({ error: 'Faltan datos para enviar el correo.' });
      return;
    }

    const resend = new Resend(apiKey);
    const fromEmail = process.env.ZY_FROM_EMAIL || 'ZAYDE <onboarding@resend.dev>';

    await resend.emails.send({
      from: fromEmail,
      to,
      subject: `Tu pedido ${orderNum} — ${statusLabel}`,
      html: `
        <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; color:#0E0E10;">
          <h2 style="margin-bottom:4px;">ZAYDE</h2>
          <p style="color:#6B6D76; margin-top:0;">Actualización de tu pedido</p>
          <p>Hola ${name || ''},</p>
          <p>Tu pedido <b>${orderNum}</b> ahora está en estatus:</p>
          <p style="font-size:18px; font-weight:700; margin:16px 0;">${statusLabel}</p>
          <p>Puedes rastrear tu pedido en cualquier momento desde el ícono de "Pedidos y rastreo" en el sitio.</p>
          <p style="color:#6B6D76; font-size:13px; margin-top:24px;">— Equipo ZAYDE</p>
        </div>
      `
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error enviando el correo con Resend:', err);
    res.status(500).json({ error: 'No se pudo enviar el correo de confirmación.' });
  }
};
// ============================================================
// [EMAIL] Envía un correo automático al cliente cuando cambias la etapa
// de su pedido desde el panel privado (pestaña Pedidos).
//
// Cómo activarlo en Vercel:
// 1) Sube este archivo a tu repo dentro de la carpeta /api (misma carpeta
//    donde vive create-payment-intent.js), es decir: /api/send-status-email.js.
// 2) Crea una cuenta gratis en https://resend.com (tiene capa gratuita,
//    100 emails/día es más que suficiente para empezar).
// 3) En Resend > API Keys, genera una llave y cópiala.
// 4) En tu proyecto de Vercel: Settings > Environment Variables, agrega:
//      RESEND_API_KEY = re_xxxxxxxxxxxx
// 5) Vuelve a desplegar (Vercel > Deployments > Redeploy).
//
// Nota sobre el remitente: mientras no verifiques tu propio dominio en
// Resend, usa el remitente de pruebas "onboarding@resend.dev" (ya viene
// puesto abajo) — funciona de inmediato, sin configurar nada más. Cuando
// quieras que los correos salgan como "pedidos@zayde.com" o similar,
// verifica tu dominio en Resend (Domains > Add Domain) y cambia el
// remitente por el tuyo.
// ============================================================

const FROM_ADDRESS = 'ZAYDE <onboarding@resend.dev>';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'RESEND_API_KEY no está configurada en Vercel todavía.' });
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
        <p>Puedes revisar el detalle completo de tu pedido en cualquier momento desde la sección "Rastrear pedido" en zayde.vercel.app, usando tu número de pedido o teléfono.</p>
        <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Gracias por tu compra en ZAYDE.</p>
      </div>
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        subject: `Tu pedido ${orderNum} — ${statusLabel}`,
        html
      })
    });

    const data = await resendRes.json();

    if (!resendRes.ok) {
      res.status(400).json({ error: (data && data.message) || 'No se pudo enviar el correo.' });
      return;
    }

    res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error('Error enviando email de estatus:', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}
