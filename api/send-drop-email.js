// /api/send-drop-email.js
//
// Función serverless de Vercel: envía el correo de "¡Ya empezó el Drop en
// vivo!" a un suscriptor que dejó su correo en el formulario "Avísame
// cuando empiece el próximo Drop en vivo" del inicio.
//
// Usa la MISMA cuenta de Resend y la misma variable RESEND_API_KEY que ya
// configuraste para /api/send-status-email.js — no necesitas crear nada
// nuevo en Resend, solo subir este archivo junto a los demás dentro de /api.
//
// Se llama UNA VEZ POR SUSCRIPTOR (el sitio hace un loop desde el panel
// admin y llama este endpoint una vez por cada persona registrada), igual
// que ya se hace con los correos de estatus de pedido.

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
    const { to, name, dropText } = req.body || {};

    if (!to) {
      res.status(400).json({ error: 'Falta el correo del destinatario.' });
      return;
    }

    const greetingName = name ? name.split(' ')[0] : 'Hola';
    const fromEmail = process.env.ZY_FROM_EMAIL || DEFAULT_FROM;
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

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: `🔥 ${dropLabel} — ¡ya comenzó!`,
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
    console.error('Error enviando email de aviso de Drop:', err);
    res.status(500).json({ error: 'Error del servidor al enviar el correo.' });
  }
}
