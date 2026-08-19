// /api/list-payment-methods.js
//
// Devuelve las tarjetas guardadas (marca, últimos 4 dígitos, vencimiento)
// de un Stripe Customer — nunca el número completo, eso vive solo en
// Stripe. Se usa para pintar la lista en "Mi cuenta → Métodos de pago".

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
  const { customerId } = req.body || {};

  if (!customerId) {
    return res.status(200).json({ cards: [] });
  }

  try {
    const methods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    });

    const cards = methods.data.map((pm) => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    }));

    return res.status(200).json({ cards });
  } catch (err) {
    console.error('Error listando tarjetas:', err);
    return res.status(500).json({ error: err.message || 'No se pudieron cargar las tarjetas guardadas' });
  }
}
