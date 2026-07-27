// /api/send-push.js
//
// Función serverless de Vercel: envía UNA notificación push real a UN
// dispositivo suscrito, usando el paquete "web-push" (protocolo estándar
// que soportan Chrome, Edge, Firefox y Safari/iOS 16.4+).
//
// CÓMO ACTIVARLA:
// 1) Agrega la dependencia "web-push" a tu package.json:
//      npm install web-push
//    (o agrega "web-push": "^3.6.7" a "dependencies" en package.json y deja
//    que Vercel lo instale solo al desplegar).
// 2) En Vercel: Settings > Environment Variables, agrega estas DOS
//    variables (ya vienen generadas, listas para usar — no hace falta
//    crear cuenta en ningún lado, VAPID es un estándar abierto y gratis):
//      VAPID_PUBLIC_KEY  = BAMpGF2q6k-dOvtsH25QQox2Dw5ZT6r1zxi1yQeLVUc_SZ4WMPQtlKg5tDFCkbmmoWZSXa_AElgcO5MNv5xdWrM
//      VAPID_PRIVATE_KEY = JTQu5hlmOONiaCzeBlxkmNaQ2Zcrkl_swm_W-caKThs
//    IMPORTANTE: la llave pública (VAPID_PUBLIC_KEY) también debe
//    pegarse en el frontend, en la constante ZY_VAPID_PUBLIC_KEY dentro
//    de index.html — ya viene puesta ahí, son la misma llave.
// 3) Vuelve a desplegar (Vercel > Deployments > Redeploy).
//
// Se llama UNA VEZ POR SUSCRIPCIÓN (el sitio hace un loop desde el panel
// admin, igual que ya hace con los correos del Drop).

import webpush from 'web-push';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    res.status(500).json({ error: 'Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en las variables de entorno de Vercel.' });
    return;
  }

  try {
    const { subscription, title, body, url } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      res.status(400).json({ error: 'Falta la suscripción push del destinatario.' });
      return;
    }

    webpush.setVapidDetails('mailto:contacto@zayde.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: title || 'ZAYDE',
        body: body || '',
        url: url || '/'
      })
    );

    res.status(200).json({ success: true });
  } catch (err) {
    // 404/410 significa que esa suscripción ya no es válida (el usuario
    // desinstaló, borró datos del navegador, etc.) — no es un error real
    // del servidor, así que se reporta distinto para poder limpiarla.
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      res.status(410).json({ error: 'Suscripción vencida o inválida.' });
      return;
    }
    console.error('Error enviando notificación push:', err);
    res.status(500).json({ error: 'No se pudo enviar la notificación push.' });
  }
}
