// ============================================================
// Reserva de stock del lado del SERVIDOR (api/_lib/stockReservations.js)
//
// Por qué existe: antes el navegador del comprador modificaba directamente
// el documento inventory/stock en Firestore (y por eso las reglas tenían
// "allow write: if true" ahí: cualquiera podía poner el stock de cualquier
// pieza en 0, o inflarlo, desde la consola del navegador). Ahora SOLO este
// código (Admin SDK) modifica el inventario por una compra, y las reglas de
// Firestore lo dejan de solo lectura para el público.
//
// Modelo:
//   - reserveStock  → descuenta el stock en una transacción y crea un
//                     documento en "stockReservations" con un ID aleatorio.
//   - releaseReservation → devuelve el stock de ESA reserva, una sola vez,
//                     y nunca si el pedido ya está pagado.
//   - sweepStale    → limpia reservas abandonadas (pedido con tarjeta que
//                     nunca se pagó) para que nadie pueda dejar una pieza
//                     "apartada" para siempre.
// ============================================================
import { randomBytes } from 'crypto';

export const STALE_MS = 45 * 60 * 1000; // una reserva sin pagar se libera a los 45 min

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SIZE_RE = /^[\p{L}\p{N} .,\/+()-]{1,20}$/u;
export const ORDER_RE = /^[A-Za-z0-9_-]{4,40}$/;
const RES_RE = /^[a-f0-9]{32}$/;

// Valida y junta las piezas que manda el navegador. Devuelve null si algo no cuadra.
export function normalizeItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 30) return null;
  const merged = new Map();
  for (const it of raw) {
    if (!it || typeof it !== 'object') return null;
    const id = it.id == null ? '' : String(it.id);
    const size = it.size == null ? '' : String(it.size);
    const qty = Number(it.qty);
    if (!ID_RE.test(id) || id.startsWith('__')) return null;
    if (!SIZE_RE.test(size)) return null;
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return null;
    const key = id + '\u0000' + size;
    const prev = merged.get(key);
    merged.set(key, { id, size, qty: (prev ? prev.qty : 0) + qty });
  }
  return [...merged.values()];
}

function cloneMap(items) {
  const map = {};
  for (const [k, v] of Object.entries(items || {})) {
    map[k] = v && typeof v === 'object' ? { ...v } : v;
  }
  return map;
}

// Misma regla que tenía el navegador: si no hay registro de esa talla, no hay
// tope (se asume 999); si hay registro y no alcanza, se rechaza TODO.
export function applyReserve(itemsMap, items) {
  const map = cloneMap(itemsMap);
  for (const it of items) {
    const sizeMap = map[it.id] && typeof map[it.id] === 'object' ? map[it.id] : {};
    const avail = sizeMap[it.size];
    if (avail !== undefined && avail < it.qty) {
      const e = new Error('STOCK_INSUFICIENTE');
      e.code = 'STOCK_INSUFICIENTE';
      e.item = { id: it.id, size: it.size };
      throw e;
    }
  }
  for (const it of items) {
    if (!map[it.id] || typeof map[it.id] !== 'object') map[it.id] = {};
    const current = map[it.id][it.size] !== undefined ? map[it.id][it.size] : 999;
    map[it.id][it.size] = Math.max(0, current - it.qty);
  }
  return map;
}

export function applyRelease(itemsMap, items) {
  const map = cloneMap(itemsMap);
  for (const it of items) {
    if (!map[it.id] || typeof map[it.id] !== 'object') map[it.id] = {};
    const current = map[it.id][it.size] !== undefined ? map[it.id][it.size] : 0;
    map[it.id][it.size] = current + it.qty;
  }
  return map;
}

// Devuelve el ID de la reserva (aleatorio, 32 hex). Lanza STOCK_INSUFICIENTE si no alcanza.
export async function reserveStock(db, { orderNum, items }) {
  const stockRef = db.collection('inventory').doc('stock');
  const resId = randomBytes(16).toString('hex');
  const resRef = db.collection('stockReservations').doc(resId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stockRef);
    const data = snap.exists ? snap.data() : { items: {} };
    const map = applyReserve(data.items, items);
    tx.set(stockRef, { items: map, updatedAt: Date.now() }, { merge: true });
    tx.set(resRef, { orderNum, items, createdAt: Date.now(), status: 'reserved' });
  });
  return resId;
}

// Resultado: 'released' | 'noop' (ya liberada) | 'paid' (pedido pagado: NO se devuelve)
//            | 'mismatch' (el pedido no es el de la reserva) | 'none' (no existe)
export async function releaseReservation(db, { reservationId, orderNum, skipPaidCheck = false }) {
  if (!RES_RE.test(String(reservationId || ''))) return 'none';
  const stockRef = db.collection('inventory').doc('stock');
  const resRef = db.collection('stockReservations').doc(reservationId);
  return db.runTransaction(async (tx) => {
    const resSnap = await tx.get(resRef);
    if (!resSnap.exists) return 'none';
    const r = resSnap.data();
    if (r.orderNum !== orderNum) return 'mismatch';
    if (r.status !== 'reserved') return 'noop';
    if (!skipPaidCheck) {
      // Si el pedido ya se pagó, devolver el stock sería "regalar" la pieza.
      const oSnap = await tx.get(db.collection('orders').doc(r.orderNum));
      if (oSnap.exists && oSnap.data().paymentStatus === 'pagado') return 'paid';
    }
    const stockSnap = await tx.get(stockRef);
    const data = stockSnap.exists ? stockSnap.data() : { items: {} };
    const map = applyRelease(data.items, r.items || []);
    tx.set(stockRef, { items: map, updatedAt: Date.now() }, { merge: true });
    tx.update(resRef, { status: 'released', releasedAt: Date.now() });
    return 'released';
  });
}

// Libera las reservas viejas de pedidos con tarjeta que nunca se pagaron y
// borra los registros ya resueltos. Un pedido NO-tarjeta (coordinado por
// WhatsApp, queda "pendiente" días) o ya pagado conserva su descuento.
export async function sweepStale(db, now = Date.now()) {
  const q = await db.collection('stockReservations')
    .where('createdAt', '<', now - STALE_MS).orderBy('createdAt').limit(20).get();
  let released = 0;
  for (const doc of q.docs) {
    const d = doc.data();
    if (d.status === 'reserved') {
      const o = await db.collection('orders').doc(String(d.orderNum)).get();
      const keep = o.exists && (o.data().paymentMethod !== 'stripe' || o.data().paymentStatus === 'pagado');
      if (!keep) {
        const r = await releaseReservation(db, { reservationId: doc.id, orderNum: d.orderNum, skipPaidCheck: true });
        if (r === 'released') released++;
      }
    }
    await doc.ref.delete();
  }
  return released;
}
