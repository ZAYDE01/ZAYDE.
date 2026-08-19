// /api/create-setup-intent.js
//
// Primer paso para "Métodos de pago guardados": crea (o reusa) un Stripe
// Customer para esta cuenta y devuelve un SetupIntent — captura los datos
// de la tarjeta y la vincula al Customer SIN cobrar nada. El frontend
// confirma este SetupIntent con stripe.confirmCardSetup(). Usa la misma
// STRIPE_SECRET_KEY que ya debe estar configurada en Vercel para
// /api/create-payment-intent.js.

import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY no está configurada en el servidor' });
  }

  const stripe = new Stripe(secretKey);
  const { customerId, email, name } = req.body || {};

  try {
    let customer;
    if (customerId) {
      customer = await stripe.customers.retrieve(customerId);
    } else {
      customer = await stripe.customers.create({
        email: email || undefined,
        name: name || undefined,
      });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      usage: 'off_session',
    });

    return res.status(200).json({ clientSecret: setupIntent.client_secret, customerId: customer.id });
  } catch (err) {
    console.error('Error creando SetupIntent:', err);
    return res.status(500).json({ error: err.message || 'No se pudo iniciar el guardado de la tarjeta' });
  }
}
