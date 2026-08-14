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

import admin from 'firebase-admin';
import { checkRateLimit } from './_lib/rateLimit.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'))
    ),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Método no permitido' });
    return;
  }

  if (!process.env.CALLMEBOT_APIKEY || !process.env.CALLMEBOT_PHONE) {
    res.status(500).json({ success: false, error: 'Faltan CALLMEBOT_APIKEY / CALLMEBOT_PHONE en las variables de entorno de Vercel.' });
    return;
  }

  const db = admin.firestore();

  // [NUEVO] Máximo 10 peticiones por IP cada hora — este endpoint no
  // requiere sesión, así que sin límite cualquiera podría llamarlo sin
  // parar y saturarte el WhatsApp con avisos falsos.
  const rl = await checkRateLimit(db, req, 'send-order-whatsapp', { windowMs: 60 * 60 * 1000, max: 10 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    res.status(429).json({ success: false, error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
    return;
  }

  try {
    const { text } = req.body || {};
    const cleanText = String(text || '').trim().slice(0, 1500);

    if (!cleanText) {
      res.status(400).json({ success: false, error: 'Falta el texto del mensaje.' });
      return;
    }

    const rawPhone = (process.env.CALLMEBOT_PHONE || '').trim();
    const rawKey = (process.env.CALLMEBOT_APIKEY || '').trim();

    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(rawPhone)}&text=${encodeURIComponent(cleanText)}&apikey=${encodeURIComponent(rawKey)}`;
    const cmbResp = await fetch(url);
    const cmbText = await cmbResp.text();

    // CallMeBot siempre responde 200 aunque el mensaje NO se haya podido
    // enviar (ej. apikey vencida) — el error real viene en el texto, no en
    // el código HTTP. Por eso lo revisamos aquí y lo regresamos también en
    // la respuesta, para poder verlo en los Logs de Vercel.
    const looksOk = /message queued|message sent/i.test(cmbText);
    if (!looksOk) {
      console.error('CallMeBot no confirmó el envío:', cmbText);
    }

    res.status(200).json({ success: looksOk, callmebotResponse: cmbText });
  } catch (err) {
    console.error('Error enviando WhatsApp vía CallMeBot:', err);
    res.status(500).json({ success: false, error: 'No se pudo enviar el aviso de WhatsApp.' });
  }
}
