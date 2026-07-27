// /api/send-status-email.js
//
// Función serverless de Vercel: envía el correo real de confirmación /
// cambio de estatus del pedido, usando Resend (https://resend.com).
//
// CÓMO ACTIVARLA:
// 1) Crea una cuenta gratis en https://resend.com (tiene capa gratuita,
//    100 correos/día es más que suficiente para empezar).
// 2) En Resend > API Keys, genera una llave (empieza con "re_") y cópiala.
// 3) En tu proyecto de Vercel: Settings > Environment Variables, agrega:
//      RESEND_API_KEY = re_xxxxxxxxxxxx
//      ZY_FROM_EMAIL  = (opcional) el remitente, ej. "ZAYDE <pedidos@tudominio.com>"
//                       Mientras no verifiques tu propio dominio en Resend
//                       (Domains > Add Domain), deja esta variable sin
//                       poner: se usa automáticamente el remitente de
//                       pruebas "onboarding@resend.dev", que funciona de
//                       inmediato sin configurar nada más.
// 4) Vuelve a desplegar (Vercel > Deployments > Redeploy) después de
//    guardar las variables de entorno.
//
// NOTA: antes este archivo tenía dos versiones distintas pegadas una
// después de otra (una con require/module.exports, otra con
// export default) — eso rompe el build en Vercel porque no se pueden
// mezclar los dos estilos en un mismo archivo. Esta versión usa un solo
// estilo (ESM, el mismo que create-payment-intent.js) de principio a fin.

const DEFAULT_FROM = 'ZAYDE <onboarding@resend.dev>';

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
    const fromEmail = process.env.ZY_FROM_EMAIL || DEFAULT_FROM;

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

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
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
