/* reservas.js - reserva UI adaptada a API nueva o legacy */
const POLL_INTERVAL = 1000;
const API_ESTADOS = '/api/estado';
const LEGACY_ESTADOS = '/estado_espacios';

let selectedSpace = null;
let estadoActual = {};

// Inicializar layout (usa la función legacy si existe)
function inicializarLayoutReservasCustom() {
  if (typeof inicializarLayoutReservas === 'function') {
    try { inicializarLayoutReservas(); } catch(e) { console.warn(e); }
  } else {
    // si no existía, se puede crear un layout simple (no obligatorio)
    const root = document.getElementById('parkingLayoutReservas');
    if (root) root.innerHTML = '<p>Layout de reservas cargado.</p>';
  }
}

/* Obtener estado con fallback */
async function fetchEstadosReservas() {
  try {
    const r = await fetch(API_ESTADOS, {cache:'no-cache'});
    if (r.ok) {
      const arr = await r.json();
      // si es array booleana, mapear a objetos
      if (Array.isArray(arr) && typeof arr[0] === 'boolean') {
        // construir objeto por index
        const o = {};
        arr.forEach((b,i) => o[i+1] = {ocupado: !!b, reservado: false});
        estadoActual = o;
        return estadoActual;
      }
      // si viene estructura legacy /estado_espacios
      if (Array.isArray(arr) && arr.length && arr[0].hasOwnProperty('id')) {
        const o = {};
        arr.forEach(it => {
          o[it.id + 1] = {ocupado: !!it.ocupado, reservado: !!it.reservado};
        });
        estadoActual = o;
        return estadoActual;
      }
    }
  } catch (e) {
    // intento fallback legacy
  }
  try {
    const r2 = await fetch(LEGACY_ESTADOS, {cache:'no-cache'});
    if (r2.ok) {
      const arr2 = await r2.json();
      const o = {};
      arr2.forEach(it => { o[it.id + 1] = {ocupado: !!it.ocupado, reservado: !!it.reservado}; });
      estadoActual = o;
      return estadoActual;
    }
  } catch (e) {
    console.warn('No se pudo obtener estados', e);
  }
  return estadoActual;
}

/* Actualizar UI de reservas (ejemplo simple) */
async function actualizarUIReservas() {
  await fetchEstadosReservas();
  // si existe lista de botones o grid, se actualiza
  // Ejemplo: actualizar texto de espacios con clase .space-reserva-N
  for (const k in estadoActual) {
    const id = k;
    const el = document.querySelector(`[data-space='${id}']`);
    if (el) {
      const st = estadoActual[k];
      el.classList.toggle('ocupado', st.ocupado);
      el.classList.toggle('reservado', st.reservado);
    }
  }
}

// Reserva: POST a /api/reservar (mantener compatibilidad)
async function reservarEspacio(id, minutes) {
  try {
    const res = await fetch('/api/reservar', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({space: id, minutes})
    });
    const data = await res.json();
    if (data.ok) {
      alert('Reserva realizada con éxito');
      await fetchEstadosReservas();
    } else {
      alert('No se pudo reservar: ' + (data.error || JSON.stringify(data)));
    }
  } catch (e) {
    alert('Error de reservas: ' + e.message);
  }
}

/* Inicialización */
document.addEventListener('DOMContentLoaded', () => {
  inicializarLayoutReservasCustom();
  setInterval(actualizarUIReservas, POLL_INTERVAL);
  actualizarUIReservas();
});
