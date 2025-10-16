/* mapa.js
  - Soporta dos modos:
    1) modo cámara/overlay: si el backend expone /api/espacios (coordenadas)
    2) modo grid (legacy): si no hay coordenadas, usa el layout generado
  - Intenta usar rutas nuevas (/api/espacios, /api/estado, /video_feed, /snapshot)
    y cae a fallbacks (/estado_espacios) si es necesario.
*/

/* ----------------- CONFIG ----------------- */
const POLL_INTERVAL = 1000; // ms
const FALLBACK_ENDPOINT_ESTADOS = '/estado_espacios'; // endpoint antiguo (si existe)
const API_ESTADOS = '/api/estado'; // devuelve [true,false,...] si está disponible
const API_ESPACIOS = '/api/espacios'; // devuelve [[x,y,w,h], ...] en resoluciones naturales
const VIDEO_FEED = '/video_feed';
const SNAPSHOT = '/snapshot'; // para calibración

/* ----------------- helpers fetch con fallback ----------------- */
async function tryFetchJSON(url) {
  try {
    const r = await fetch(url, {cache: 'no-cache'});
    if (!r.ok) throw new Error('not ok ' + r.status);
    return await r.json();
  } catch (e) {
    return null;
  }
}

/* ----------------- DOM helpers ----------------- */
function $(id) { return document.getElementById(id); }

/* ----------------- MODOS y estado global ----------------- */
let modoCamara = false;
let espaciosCoords = null; // array de [x,y,w,h] (coordenadas 'naturales' del snapshot)
let estados = []; // array booleana indice por espacio
let videoImg = null;
let overlayCanvas = null;
let overlayCtx = null;

/* ----------------- Iniciar UI (insertar contenedor de vídeo si procede) ----------------- */
function ensureVideoContainer() {
  // Si ya existe video container, no crear
  if (document.getElementById('video-wrapper')) return;

  // buscar un lugar para poner el vídeo: preferencia map container o header
  let parent = document.getElementById('parkingLayout') || document.querySelector('.container') || document.body;

  // crear controles + contenedor
  const wrapper = document.createElement('div');
  wrapper.id = 'video-wrapper';
  wrapper.style.marginBottom = '12px';

  const controls = document.createElement('div');
  controls.className = 'video-controls';

  const btnConnect = document.createElement('button');
  btnConnect.id = 'btn-connect-camera';
  btnConnect.textContent = 'Conectar cámara';
  btnConnect.onclick = async () => {
    await fetch('/api/start_camera', {method: 'POST'}).catch(()=>{});
    setTimeout(()=> loadSnapshotAndStart(), 400); // dar tiempo al backend
    setStatus('Conectando cámara...');
  };

  const btnDisconnect = document.createElement('button');
  btnDisconnect.id = 'btn-disconnect-camera';
  btnDisconnect.textContent = 'Desconectar cámara';
  btnDisconnect.onclick = async () => {
    await fetch('/api/stop_camera', {method: 'POST'}).catch(()=>{});
    setStatus('Cámara detenida');
  };

  const btnCal = document.createElement('button');
  btnCal.id = 'btn-calibrate';
  btnCal.textContent = 'Calibrar / Editar Mapa';
  btnCal.onclick = () => openCalibrationModal();

  controls.appendChild(btnConnect);
  controls.appendChild(btnDisconnect);
  controls.appendChild(btnCal);

  const vidContainer = document.createElement('div');
  vidContainer.className = 'video-container';
  vidContainer.style.width = '100%';
  vidContainer.style.maxWidth = '1100px';

  videoImg = document.createElement('img');
  videoImg.id = 'video-stream';
  videoImg.src = VIDEO_FEED;
  videoImg.alt = 'Video en vivo';
  videoImg.onload = () => {
    resizeOverlayToImage();
    drawOverlay(); // dibujar si hay coords
  };

  overlayCanvas = document.createElement('canvas');
  overlayCanvas.id = 'video-overlay';
  overlayCanvas.style.width = '100%';
  overlayCanvas.style.height = 'auto';
  overlayCanvas.style.pointerEvents = 'none';
  overlayCanvas.width = 640;
  overlayCanvas.height = 360;

  vidContainer.appendChild(videoImg);
  vidContainer.appendChild(overlayCanvas);

  wrapper.appendChild(controls);
  wrapper.appendChild(vidContainer);
  // Insertar antes del parking layout para que sea visible arriba
  parent.insertBefore(wrapper, parent.firstChild);

  overlayCtx = overlayCanvas.getContext('2d');
}

/* ----------------- Resizing overlay para ajustarse a imagen del MJPEG ----------------- */
function resizeOverlayToImage() {
  if (!videoImg || !overlayCanvas) return;
  // mantener proporción visible cliente vs natural
  overlayCanvas.width = videoImg.clientWidth;
  overlayCanvas.height = videoImg.clientHeight;
  overlayCanvas.style.left = videoImg.offsetLeft + 'px';
  overlayCanvas.style.top = videoImg.offsetTop + 'px';
}

/* ----------------- Dibujo del overlay (ROI + estado) ----------------- */
function drawOverlay() {
  if (!espaciosCoords || !overlayCtx || !videoImg || espaciosCoords.length === 0) return;
  overlayCtx.clearRect(0,0, overlayCanvas.width, overlayCanvas.height);

  const scaleX = videoImg.clientWidth / videoImg.naturalWidth;
  const scaleY = videoImg.clientHeight / videoImg.naturalHeight;

  for (let i = 0; i < espaciosCoords.length; i++) {
    const r = espaciosCoords[i];
    const x = Math.round(r[0] * scaleX);
    const y = Math.round(r[1] * scaleY);
    const w = Math.round(r[2] * scaleX);
    const h = Math.round(r[3] * scaleY);
    const ocupado = (estados && estados[i]) ? true : false;

    overlayCtx.lineWidth = 2;
    overlayCtx.strokeStyle = ocupado ? 'rgba(220, 40, 40, 0.95)' : 'rgba(20,170,50,0.95)';
    overlayCtx.fillStyle = ocupado ? 'rgba(220,40,40,0.15)' : 'rgba(20,170,50,0.06)';
    overlayCtx.strokeRect(x,y,w,h);
    overlayCtx.fillRect(x,y,w,h);

    overlayCtx.fillStyle = '#fff';
    overlayCtx.font = '14px sans-serif';
    overlayCtx.fillText(`${i+1} ${ocupado ? 'Ocupado' : 'Libre'}`, x + 6, Math.max(16, y + 14));
  }
}

/* ----------------- Carga de coordenadas (API) ----------------- */
async function loadCoordsFromServer() {
  // Intentar endpoint nuevo
  const coords = await tryFetchJSON(API_ESPACIOS);
  if (coords && Array.isArray(coords) && coords.length > 0) {
    espaciosCoords = coords;
    modoCamara = true;
    ensureVideoContainer();
    resizeOverlayToImage();
    drawOverlay();
    return true;
  }
  // fallback: intentar analizar respuesta antigua /estado_espacios para extraer coords (si la tiene)
  const legacy = await tryFetchJSON(FALLBACK_ENDPOINT_ESTADOS);
  if (legacy && Array.isArray(legacy) && legacy.length > 0 && legacy[0].hasOwnProperty('x')) {
    // si la estructura antigua incluye x,y,w,h por objeto
    espaciosCoords = legacy.map(o => [o.x, o.y, o.w, o.h]);
    modoCamara = true;
    ensureVideoContainer();
    resizeOverlayToImage();
    drawOverlay();
    return true;
  }
  // no hay coords: fallback a modo grid (legacy)
  modoCamara = false;
  espaciosCoords = null;
  return false;
}

/* ----------------- Carga de estados (ocupado/libre) ----------------- */
async function loadEstadoFromServer() {
  // intentar endpoint nuevo que devuelve [true,false,...]
  const newEstado = await tryFetchJSON(API_ESTADOS);
  if (Array.isArray(newEstado)) {
    estados = newEstado;
    drawOverlay();
    return;
  }
  // fallback: endpoint legacy que devuelve array de objetos [{id, ocupado, reservado, ...}]
  const legacy = await tryFetchJSON(FALLBACK_ENDPOINT_ESTADOS);
  if (Array.isArray(legacy)) {
    // extraer ocupados si vienen en la estructura
    estados = legacy.map(o => !!o.ocupado || !!o.reservado);
    drawOverlay();
    // además actualizar grid si existe
    if (typeof actualizarEstadoMapa === 'function') {
      try { actualizarEstadoMapa(); } catch(e) {}
    }
    return;
  }
  // si todo falla, no hacer nada
}

/* ----------------- Snapshot (para calibración) ----------------- */
async function loadSnapshotAndStart() {
  // pedir snapshot; el servidor debe exponer /snapshot
  try {
    const ts = Date.now();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // abrir modal de calibración con la imagen cargada
      openCalibrationModalWithImage(img);
    };
    img.onerror = () => {
      setStatus('No se pudo obtener snapshot. ¿La cámara está conectada al backend?');
    };
    img.src = SNAPSHOT + '?_=' + ts;
  } catch (e) {
    console.error(e);
    setStatus('Error al pedir snapshot');
  }
}

/* ----------------- Modal & calibrador (simple) ----------------- */
let calibratorModal = null;
function openCalibrationModal() {
  // pedir snapshot y abrir modal
  loadSnapshotAndStart(); // cuando la snapshot carga, openCalibrationModalWithImage será llamada
}

function openCalibrationModalWithImage(imgElement) {
  // construir modal si no existe
  if (!calibratorModal) {
    calibratorModal = document.createElement('div');
    calibratorModal.className = 'modal-cal';
    calibratorModal.innerHTML = `
      <div class="box">
        <h4>Calibración - dibuja rectángulos sobre la imagen</h4>
        <div style="display:flex; gap:12px;">
          <div style="flex:1; position:relative;">
            <img id="snap-img" style="max-width:100%; display:block;">
            <canvas id="snap-canvas"></canvas>
          </div>
          <div style="width:320px;">
            <div style="margin-bottom:8px;">
              <button id="snap-refresh">Actualizar snapshot</button>
              <button id="snap-clear">Borrar todas</button>
              <button id="snap-save">Guardar en servidor</button>
              <button id="snap-close">Cerrar</button>
            </div>
            <div class="roi-list" id="roi-list"></div>
            <p style="font-size:12px; color:#666">Haz click en un ROI listado para eliminarlo.</p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(calibratorModal);
  }
  calibratorModal.style.display = 'flex';

  // set img
  const snapImg = calibratorModal.querySelector('#snap-img');
  const snapCanvas = calibratorModal.querySelector('#snap-canvas');
  const roiList = calibratorModal.querySelector('#roi-list');
  snapImg.src = imgElement.src;
  // ajustar canvas para el tamaño mostrado
  snapImg.onload = () => {
    snapCanvas.width = snapImg.clientWidth;
    snapCanvas.height = snapImg.clientHeight;
    snapCanvas.style.position = 'absolute';
    snapCanvas.style.left = snapImg.offsetLeft + 'px';
    snapCanvas.style.top = snapImg.offsetTop + 'px';
    snapCanvas.style.zIndex = 30;
    snapCanvas.style.pointerEvents = 'auto';
    // dibujar actuales si existen
    currentROIs = (espaciosCoords && Array.isArray(espaciosCoords)) ? espaciosCoords.slice() : [];
    drawSnap();
    renderRoiList();
  };

  // interactions: draw rectangles (simple)
  let drawing = false;
  let sx=0, sy=0;
  let currentROIs = (espaciosCoords && Array.isArray(espaciosCoords)) ? espaciosCoords.slice() : [];
  const sctx = snapCanvas.getContext('2d');

  function drawSnap() {
    // limpiar
    sctx.clearRect(0,0,snapCanvas.width, snapCanvas.height);
    // dibujar rois
    const scaleX = snapImg.clientWidth / snapImg.naturalWidth;
    const scaleY = snapImg.clientHeight / snapImg.naturalHeight;
    for (let i=0;i<currentROIs.length;i++){
      const r = currentROIs[i];
      const dx = Math.round(r[0] * scaleX);
      const dy = Math.round(r[1] * scaleY);
      const dw = Math.round(r[2] * scaleX);
      const dh = Math.round(r[3] * scaleY);
      sctx.fillStyle = 'rgba(0,200,50,0.16)';
      sctx.strokeStyle = 'lime';
      sctx.lineWidth = 2;
      sctx.fillRect(dx,dy,dw,dh);
      sctx.strokeRect(dx,dy,dw,dh);
      sctx.fillStyle = 'white';
      sctx.font = '12px sans-serif';
      sctx.fillText('' + (i+1), dx+6, Math.max(12, dy+12));
    }
  }

  function renderRoiList() {
    roiList.innerHTML = '';
    currentROIs.forEach((r,i) => {
      const div = document.createElement('div');
      div.style.cursor = 'pointer';
      div.style.padding = '6px';
      div.style.borderBottom = '1px solid #eee';
      div.textContent = `${i+1}: x=${r[0]}, y=${r[1]}, w=${r[2]}, h=${r[3]}`;
      div.onclick = () => {
        if (!confirm('Eliminar ROI #' + (i+1) + '?')) return;
        currentROIs.splice(i,1);
        drawSnap();
        renderRoiList();
      };
      roiList.appendChild(div);
    });
  }

  // handlers para pintar rectángulos con mouse en canvas (coordenadas de display => naturales)
  function displayToNatural(dx, dy) {
    const scaleX = snapImg.naturalWidth / snapImg.clientWidth;
    const scaleY = snapImg.naturalHeight / snapImg.clientHeight;
    return { x: Math.round(dx * scaleX), y: Math.round(dy * scaleY) };
  }
  snapCanvas.onmousedown = (ev) => {
    drawing = true;
    const rect = snapCanvas.getBoundingClientRect();
    sx = ev.clientX - rect.left;
    sy = ev.clientY - rect.top;
  };
  snapCanvas.onmousemove = (ev) => {
    if (!drawing) return;
    const rect = snapCanvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    // preview
    drawSnap();
    sctx.strokeStyle = 'yellow';
    sctx.lineWidth = 2;
    sctx.strokeRect(sx, sy, mx - sx, my - sy);
  };
  snapCanvas.onmouseup = (ev) => {
    if (!drawing) return;
    drawing = false;
    const rect = snapCanvas.getBoundingClientRect();
    const ex = ev.clientX - rect.left;
    const ey = ev.clientY - rect.top;
    const p1 = displayToNatural(sx, sy);
    const p2 = displayToNatural(ex, ey);
    const nx = Math.min(p1.x, p2.x);
    const ny = Math.min(p1.y, p2.y);
    const nw = Math.abs(p1.x - p2.x);
    const nh = Math.abs(p1.y - p2.y);
    if (nw > 4 && nh > 4) {
      currentROIs.push([nx, ny, nw, nh]);
      drawSnap();
      renderRoiList();
    }
  };

  // Buttons in modal
  calibratorModal.querySelector('#snap-refresh').onclick = () => {
    // recargar snapshot en el modal
    const ts = Date.now();
    snapImg.src = SNAPSHOT + '?_=' + ts;
  };
  calibratorModal.querySelector('#snap-clear').onclick = () => {
    if (!confirm('Borrar todas las ROI?')) return;
    currentROIs = [];
    drawSnap();
    renderRoiList();
  };
  calibratorModal.querySelector('#snap-close').onclick = () => {
    calibratorModal.style.display = 'none';
  };
  calibratorModal.querySelector('#snap-save').onclick = async () => {
    // Guardar en servidor -> POST /api/save_espacios con body [ [x,y,w,h], ... ]
    try {
      const r = await fetch('/api/save_espacios', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(currentROIs)
      });
      const j = await r.json();
      if (j.ok) {
        // recargar coords y cerrar modal
        await loadCoordsFromServer();
        calibratorModal.style.display = 'none';
        setStatus('Mapa guardado correctamente');
      } else {
        alert('Error al guardar: ' + JSON.stringify(j));
      }
    } catch (e) {
      alert('Error guardando: ' + e.message);
    }
  };
}

/* ----------------- Util status small ----------------- */
function setStatus(txt) {
  let el = document.getElementById('map-status');
  if (!el) {
    el = document.createElement('span');
    el.id = 'map-status';
    el.className = 'small-status';
    // insert after page title if available, else body
    const title = document.querySelector('h1') || document.body;
    title.parentNode.insertBefore(el, title.nextSibling);
  }
  el.textContent = txt;
  setTimeout(()=> {
    if (el.textContent === txt) el.textContent = '';
  }, 4000);
}

/* ----------------- Modo legacy grid (si no hay coords) -------------- */
/* Para mantener compatibilidad, si no hay coords, dejamos el comportamiento del mapa.grid
   (la función original `inicializarLayout` / `actualizarEstadoMapa` del repo seguirá existiendo).
   Aquí solo intentamos tirar de esas funciones si están definidas.
*/

async function initMapSystem() {
  // preparar video container siempre (no causa fallo si el backend no expone /video_feed)
  ensureVideoContainer();
  // intentar cargar coordenadas (si retorna true => modo cámara)
  const ok = await loadCoordsFromServer();
  if (!ok) {
    // no coords: usa layout legacy (las funciones originales del repo deberían existir)
    setStatus('Modo mapa: layout estático');
    if (typeof inicializarLayout === 'function') inicializarLayout();
    if (typeof actualizarEstadoMapa === 'function') {
      setInterval(() => {
        try { actualizarEstadoMapa(); } catch(e) {}
      }, POLL_INTERVAL);
      actualizarEstadoMapa();
    }
  } else {
    // modo cámara: poll estado y redibujar overlay
    setInterval(loadEstadoFromServer, POLL_INTERVAL);
    await loadEstadoFromServer();
  }
  // redimensionar overlay cuando cambie la ventana
  window.addEventListener('resize', () => {
    resizeOverlayToImage();
    drawOverlay();
  });
}

/* ----------------- iniciar ----------------- */
document.addEventListener('DOMContentLoaded', () => {
  initMapSystem().catch(err => console.error(err));
});
