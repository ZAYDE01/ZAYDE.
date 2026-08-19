// /api/send-coupon-email.js
//
// Envía por correo, de forma automática y sin intervención del admin, el
// cupón de socio (10% de descuento) que se genera cuando un cliente llega
// al umbral de "cliente frecuente". Usa la misma API de Resend que ya usan
// /api/send-status-email.js y /api/send-drop-email.js en este proyecto —
// si esos ya están desplegados y funcionando, esta función solo necesita
// la misma variable de entorno RESEND_API_KEY, ya configurada en Vercel.
//
// IMPORTANTE: ajusta la línea "from" de abajo para que coincida EXACTAMENTE
// con el remitente que ya usas en send-status-email.js (debe ser un
// dominio verificado en tu cuenta de Resend; si no tienes uno verificado
// todavía, Resend te deja usar "onboarding@resend.dev" solo en modo de
// pruebas).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { to, name, code, value } = req.body || {};

  if (!to || !code) {
    return res.status(400).json({ error: 'Falta el correo del cliente o el código del cupón' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY no está configurada en el servidor' });
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
        from: 'ZAYDE <onboarding@resend.dev>', // <-- reemplaza por el mismo remitente que usas en send-status-email.js
        to: [to],
        subject: `Tu cupón de socio ZAYDE — ${pct}% de descuento`,
        html,
      }),
    });

    const data = await resendRes.json().catch(() => ({}));

    if (!resendRes.ok) {
      console.error('Resend error:', data);
      return res.status(502).json({ error: data.message || 'Resend rechazó el envío' });
    }

    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Error llamando a Resend:', err);
    return res.status(500).json({ error: 'No se pudo conectar con Resend' });
  }
}
