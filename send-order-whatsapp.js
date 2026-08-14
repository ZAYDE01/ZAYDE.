// /api/send-order-whatsapp.js
//
// Manda el aviso de "nuevo pedido" a tu WhatsApp vía CallMeBot, desde el
// SERVIDOR en vez de desde el navegador del cliente.
//
// Por qué se cambió de lado:
//   1) CallMeBot no permite llamadas directas desde el navegador (CORS) —
//      el navegador las bloquea silenciosamente, por eso nunca te llegaba
//      el mensaje.
//   2) Tu apikey de CallMeBot ya no queda expuesta en el código público
//      del sitio — ahora vive solo en Vercel, como variable de entorno.
//
// Variables de entorno requeridas en Vercel (agrégalas en Settings >
// Environment Variables):
//   CALLMEBOT_APIKEY  — la apikey de 7 dígitos que te dio CallMeBot
//   CALLMEBOT_PHONE   — tu número con código de país, sin "+" (ej. 523332539967)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Método no permitido' });
    return;
  }

  if (!process.env.CALLMEBOT_APIKEY || !process.env.CALLMEBOT_PHONE) {
    res.status(500).json({ success: false, error: 'Faltan CALLMEBOT_APIKEY / CALLMEBOT_PHONE en las variables de entorno de Vercel.' });
    return;
  }

  try {
    const { text } = req.body || {};
    const cleanText = String(text || '').trim().slice(0, 1500);

    if (!cleanText) {
      res.status(400).json({ success: false, error: 'Falta el texto del mensaje.' });
      return;
    }

    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(process.env.CALLMEBOT_PHONE)}&text=${encodeURIComponent(cleanText)}&apikey=${encodeURIComponent(process.env.CALLMEBOT_APIKEY)}`;
    await fetch(url);

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error enviando WhatsApp vía CallMeBot:', err);
    res.status(500).json({ success: false, error: 'No se pudo enviar el aviso de WhatsApp.' });
  }
}
