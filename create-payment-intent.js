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
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY no está configurada en Vercel todavía.' });
    return;
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
