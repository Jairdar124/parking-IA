/* script.js - scripts genéricos de la landing */
const API_ESTADOS = '/api/estado';
const LEGACY_ESTADOS = '/estado_espacios';

async function fetchEstadoForStats() {
  try {
    const r = await fetch(API_ESTADOS, {cache:'no-cache'});
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) {}
  // fallback legacy
  try {
    const r2 = await fetch(LEGACY_ESTADOS, {cache:'no-cache'});
    if (r2.ok) {
      const arr2 = await r2.json();
      // construir array booleana desde legacy
      if (Array.isArray(arr2)) {
        return arr2.map(it => !!it.ocupado);
      }
    }
  } catch (e) {}
  return null;
}

async function actualizarEstadisticasLanding() {
  const estados = await fetchEstadoForStats();
  if (!Array.isArray(estados)) return;
  const total = estados.length;
  const ocupados = estados.filter(Boolean).length;
  const libres = total - ocupados;
  const porcentaje = Math.round((ocupados / (total || 1)) * 100);
  if (document.getElementById('libres')) document.getElementById('libres').textContent = libres;
  if (document.getElementById('ocupados')) document.getElementById('ocupados').textContent = ocupados;
  if (document.getElementById('porcentaje')) document.getElementById('porcentaje').textContent = porcentaje + '%';
  if (document.getElementById('lastUpdate')) document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
}

document.addEventListener('DOMContentLoaded', () => {
  actualizarEstadisticasLanding();
  setInterval(actualizarEstadisticasLanding, 5000);
});
