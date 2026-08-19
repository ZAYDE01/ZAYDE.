// /api/delete-payment-method.js
// (sin cambios de lógica — solo se retocó para refrescar el estado del check en GitHub)
//
// Desvincula (elimina) una tarjeta guardada de un Stripe Customer. Solo
// necesita el ID del método de pago (pm_xxx) que ya devolvió
// /api/list-payment-methods.js — nunca el número de tarjeta.

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
  const { paymentMethodId } = req.body || {};

  if (!paymentMethodId) {
    return res.status(400).json({ error: 'Falta el ID del método de pago' });
  }

  try {
    await stripe.paymentMethods.detach(paymentMethodId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error eliminando tarjeta:', err);
    return res.status(500).json({ error: err.message || 'No se pudo eliminar la tarjeta' });
  }
}
