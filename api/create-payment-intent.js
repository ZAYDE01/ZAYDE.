// ============================================================
// [STRIPE] Backend real de cobro — crea el PaymentIntent en Stripe.
//
// Cómo activarlo en Vercel:
// 1) Sube este archivo a tu repo dentro de la carpeta /api (misma carpeta
//    donde vive tu index.html, es decir: /api/create-payment-intent.js).
//    Vercel detecta automáticamente cualquier archivo dentro de /api como
//    una función serverless — no necesitas configuración extra.
// 2) En tu proyecto de Vercel: Settings > Environment Variables, agrega:
//      STRIPE_SECRET_KEY = sk_test_xxxxx  (o sk_live_xxxxx cuando ya cobres real)
// 3) Vuelve a desplegar el proyecto (Vercel > Deployments > Redeploy) para
//    que la variable de entorno quede activa.
// 4) En tu index.html, reemplaza STRIPE_PUBLISHABLE_KEY por tu llave
//    pública (pk_test_xxxxx o pk_live_xxxxx) del mismo Dashboard de Stripe.
//
// Esta función NUNCA expone tu llave secreta al navegador: vive solo aquí,
// en el servidor, protegida por la variable de entorno.
//
// NOVEDAD: ahora manda el orderNum como "metadata" al crear el pago en
// Stripe. Eso es lo que le permite a /api/stripe-webhook.js identificar a
// qué pedido de Firestore pertenece un pago cuando Stripe le avisa "este
// pago se completó" — sin depender de que el navegador del cliente siga
// vivo para hacer esa conexión.
//
// [NUEVO] Rate limiting: máximo 10 intentos de cobro por IP cada 10
// minutos. Sin esto, cualquiera podía llamar a esta función sin límite —
// no roba dinero directamente (Stripe siempre cobra con datos de tarjeta
// reales), pero sí puede saturar tu cuenta de Stripe con intentos
// fallidos o usarla para probar números de tarjeta robados ("card
// testing"), un abuso común contra endpoints de pago sin límite.
//
// [NUEVO] Ahora esta misma función también responde a GET
// (/api/create-payment-intent?paymentIntentId=pi_xxx) para devolver la
// MARCA y ÚLTIMOS 4 DÍGITOS de la tarjeta con la que se pagó (ej. "visa",
// "4242"). Se juntó aquí en vez de crear un archivo nuevo para no volver
// a pasar el límite de 12 funciones de Vercel Hobby. Nunca se devuelve el
// número completo de la tarjeta — eso Stripe no lo expone ni con la
// llave secreta una vez procesado el pago.
// ============================================================

const admin = require('firebase-admin');
const { checkRateLimit } = require('./_lib/rateLimit');

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    credential = admin.credential.cert(json);
  } else {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
  }
  admin.initializeApp({ credential });
  return admin;
}

export default async function handler(req, res) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY no está configurada en Vercel todavía.' });
    return;
  }

  // ------------------------------------------------------------
  // GET: devuelve marca + últimos 4 dígitos de la tarjeta usada en un
  // PaymentIntent ya confirmado. El frontend la llama justo después de
  // que el pago se completa exitosamente.
  // ------------------------------------------------------------
  if (req.method === 'GET') {
    const paymentIntentId = req.query && req.query.paymentIntentId;
    if (!paymentIntentId) {
      res.status(400).json({ error: 'Falta paymentIntentId' });
      return;
    }
    try {
      const stripeRes = await fetch(
        `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=payment_method`,
        { headers: { 'Authorization': 'Bearer ' + secretKey } }
      );
      const data = await stripeRes.json();
      if (!stripeRes.ok) {
        res.status(400).json({ error: (data.error && data.error.message) || 'No se pudo consultar el pago.' });
        return;
      }
      const card = data.payment_method && data.payment_method.card;
      res.status(200).json({
        brand: (card && card.brand) || null,
        last4: (card && card.last4) || null,
      });
    } catch (err) {
      console.error('Error consultando detalles de tarjeta:', err);
      res.status(500).json({ error: 'Error del servidor al consultar la tarjeta.' });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const fb = getFirebaseAdmin();
    const db = fb.firestore();
    const rl = await checkRateLimit(db, req, 'create-payment-intent', { windowMs: 10 * 60 * 1000, max: 10 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ error: 'Demasiados intentos de pago desde esta conexión. Espera unos minutos e intenta de nuevo.' });
      return;
    }
  } catch (e) {
    console.error('Rate limit create-payment-intent: error inesperado, se deja pasar —', e);
  }

  try {
    const { amount, currency = 'mxn', description = '', orderNum = '' } = req.body || {};
    const amountCents = Math.round(Number(amount));
    if (!amountCents || amountCents < 1) {
      res.status(400).json({ error: 'Monto inválido.' });
      return;
    }
    const params = new URLSearchParams();
    params.append('amount', String(amountCents)); // Stripe espera centavos
    params.append('currency', currency);
    if (description) params.append('description', description);
    if (orderNum) params.append('metadata[orderNum]', orderNum);
    params.append('automatic_payment_methods[enabled]', 'true');
    const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      res.status(400).json({ error: (data.error && data.error.message) || 'No se pudo crear el pago.' });
      return;
    }
    res.status(200).json({ clientSecret: data.client_secret });
  } catch (err) {
    console.error('Error creando PaymentIntent:', err);
    res.status(500).json({ error: 'Error del servidor al procesar el pago.' });
  }
}
