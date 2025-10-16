"""
Flask app + VideoProcessor adapted to use a camera stream instead of a local video file.

Cómo usar:
  - Configure la fuente de la cámara mediante la variable de entorno CAMERA_SOURCE
    (por ejemplo: 0 para la webcam local, o una URL RTSP/HTTP: rtsp://user:pass@ip:port/stream)
  - Ejecutar: python app_camera.py

Este archivo reemplaza la parte de vídeo de la aplicación original. Mantiene:
  - Carga de 'espacios.pkl' con la lista de rectángulos (x,y,w,h)
  - Ruta /video_feed para streaming MJPEG
  - Ruta /api/estado para devolver el estado actual de los espacios (ocupado/libre)

Mejoras implementadas:
  - Reconexion automática a la cámara si se pierde la señal
  - Procesamiento en un hilo (no bloqueante) y variables protegidas por Lock
  - Algoritmo robusto: background subtraction (MOG2) por cada ROI + umbral adaptativo
  - Manejo seguro cuando no hay frame (evita crash si read() falla)

Notas:
  - Ajusta los parámetros: AREA_OCCUPIED_RATIO y MOG_HISTORY/MOG_THRESH según tu escena
  - Si tienes una imagen de referencia con el estacionamiento vacío, podrías usarla para
    calibrar los umbrales por espacio.
"""

from flask import Flask, render_template, Response, jsonify
import cv2
import pickle
import numpy as np
import threading
import time
import os

# ----------------------- Configuración -----------------------
CAMERA_SOURCE = os.environ.get('CAMERA_SOURCE', '0')  # '0' por defecto -> webcam local
FRAME_WIDTH = int(os.environ.get('FRAME_WIDTH', 1280))
FRAME_HEIGHT = int(os.environ.get('FRAME_HEIGHT', 720))
MOG_HISTORY = int(os.environ.get('MOG_HISTORY', 300))
MOG_VAR_THRESHOLD = float(os.environ.get('MOG_VAR_THRESHOLD', 25.0))
AREA_OCCUPIED_RATIO = float(os.environ.get('AREA_OCCUPIED_RATIO', 0.02))

# ----------------------- Carga de recursos -----------------------
ESPACIOS_PKL = 'espacios.pkl'
if not os.path.exists(ESPACIOS_PKL):
    raise FileNotFoundError(f"No se encontró {ESPACIOS_PKL}. Ejecuta 'obtener_espacios.py' para generar las ROI primero.")

with open(ESPACIOS_PKL, 'rb') as f:
    espacios = pickle.load(f)  # lista de (x,y,w,h)

# ----------------------- VideoProcessor -----------------------
class VideoProcessor:
    def __init__(self, src):
        # Camera source puede ser '0' (string), '1' etc. o una URL
        try:
            src_int = int(src)
            self.src = src_int
        except Exception:
            self.src = src

        self.capture = None
        self.lock = threading.Lock()
        self.frame = None
        self.annotated_frame = None
        self.estado_espacios = [False] * len(espacios)
        self._stop = False
        self._thread = threading.Thread(target=self._reader_worker, daemon=True)

        # Background subtractor (una por toda la imagen, suficiente y simple)
        self.backsub = cv2.createBackgroundSubtractorMOG2(history=MOG_HISTORY, varThreshold=MOG_VAR_THRESHOLD, detectShadows=False)

        # Start
        self._open_capture()
        self._thread.start()

    def _open_capture(self):
        if self.capture is not None:
            try:
                self.capture.release()
            except Exception:
                pass
            self.capture = None

        self.capture = cv2.VideoCapture(self.src)
        # Configurar resolución si es posible
        try:
            self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
            self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
        except Exception:
            pass

    def _reader_worker(self):
        reconnect_delay = 1.0
        while not self._stop:
            if self.capture is None or not self.capture.isOpened():
                # intentar abrir
                self._open_capture()
                time.sleep(reconnect_delay)
                reconnect_delay = min(5.0, reconnect_delay * 1.5)
                continue

            ok, frame = self.capture.read()
            if not ok or frame is None:
                # intentar reconectar
                self.capture.release()
                self.capture = None
                time.sleep(1.0)
                continue

            # Reset reconnect delay on success
            reconnect_delay = 1.0

            # Procesamiento básico: redimensionar para velocidad y estabilidad
            frame_resized = cv2.resize(frame, (FRAME_WIDTH, FRAME_HEIGHT))
            gray = cv2.cvtColor(frame_resized, cv2.COLOR_BGR2GRAY)
            blurred = cv2.GaussianBlur(gray, (5,5), 0)

            # Aplicar sustracción de fondo a la imagen completa
            fgmask = self.backsub.apply(blurred)

            # Para cada ROI, determinar si ocupado
            new_estado = []
            for (idx, (x, y, w, h)) in enumerate(espacios):
                # Asegurar coordenadas dentro del frame
                x2 = max(0, x)
                y2 = max(0, y)
                xw = min(FRAME_WIDTH, x + w)
                yh = min(FRAME_HEIGHT, y + h)
                if x2 >= xw or y2 >= yh:
                    new_estado.append(False)
                    continue

                roi_mask = fgmask[y2:yh, x2:xw]
                # Contar píxeles en movimiento
                non_zero = int(cv2.countNonZero(roi_mask))
                area = (xw - x2) * (yh - y2)

                occupied = (non_zero / float(area + 1e-6)) > AREA_OCCUPIED_RATIO
                new_estado.append(bool(occupied))

            # Dibujar rectángulos sobre la copia para streaming
            annotated = frame_resized.copy()
            for i, (x,y,w,h) in enumerate(espacios):
                color = (0,255,0) if not new_estado[i] else (0,0,255)  # verde libre, rojo ocupado
                cv2.rectangle(annotated, (x,y), (x+w, y+h), color, 2)
                label = f"{i+1} {'Libre' if not new_estado[i] else 'Ocupado'}"
                cv2.putText(annotated, label, (x, max(0,y-6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)

            with self.lock:
                self.frame = frame_resized
                self.annotated_frame = annotated
                self.estado_espacios = new_estado

            # Small sleep to yield CPU (control FPS)
            time.sleep(0.03)

    def get_frame_bytes(self):
        """Obtener frame anotado en bytes JPEG (para streaming MJPEG)"""
        with self.lock:
            if self.annotated_frame is None:
                return None
            ret, jpeg = cv2.imencode('.jpg', self.annotated_frame)
            if not ret:
                return None
            return jpeg.tobytes()

    def get_estado_espacios(self):
        with self.lock:
            # devolver copia para evitar race
            return list(self.estado_espacios)

    def stop(self):
        self._stop = True
        try:
            if self.capture is not None:
                self.capture.release()
        except Exception:
            pass


# ----------------------- Flask app -----------------------
app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET', 'replace-in-prod')

# Rutas simples (puedes integrarlas con tu estructura actual)
@app.route('/')
def index():
    return render_template('mapa.html')  # usa la plantilla del proyecto

# Stream MJPEG
def mjpeg_generator():
    while True:
        frame = video_processor.get_frame_bytes()
        if frame is None:
            # enviar frame vacío o log
            time.sleep(0.05)
            continue
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

@app.route('/video_feed')
def video_feed():
    return Response(mjpeg_generator(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/api/estado')
def api_estado():
    return jsonify(video_processor.get_estado_espacios())

# ----------------------- Inicialización -----------------------
if __name__ == '__main__':
    print('Iniciando app con cámara source =', CAMERA_SOURCE)
    video_processor = VideoProcessor(CAMERA_SOURCE)
    try:
        app.run(host='0.0.0.0', port=5000, debug=True)
    finally:
        video_processor.stop()
