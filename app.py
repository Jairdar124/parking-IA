# app.py
import os
import time
import io
import pickle
from flask import Flask, render_template, Response, jsonify, request, send_file
import cv2
import app_camera  # IMPORTAR el módulo completo (no nombres individuales)

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET', 'replace-in-prod')

# video_processor global (instancia de app_camera.VideoProcessor)
video_processor = None

def start_video_processor_if_needed():
    global video_processor
    if video_processor is None:
        CAMERA_SOURCE = os.environ.get('CAMERA_SOURCE', '0')
        video_processor = app_camera.VideoProcessor(CAMERA_SOURCE)
    return video_processor

def stop_video_processor():
    global video_processor
    if video_processor is not None:
        try:
            video_processor.stop()
        except Exception:
            pass
        video_processor = None

# ----------------- Rutas web -----------------
@app.route('/')
def index():
    return render_template('mapa.html')

# MJPEG streaming
def mjpeg_generator():
    # asegurarse de haber arrancado
    start_video_processor_if_needed()
    while True:
        # tomamos el frame anotado para streaming
        frame = video_processor.get_frame_bytes()
        if frame is None:
            time.sleep(0.05)
            continue
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

@app.route('/video_feed')
def video_feed():
    start_video_processor_if_needed()
    return Response(mjpeg_generator(), mimetype='multipart/x-mixed-replace; boundary=frame')

# Endpoint devuelve estado de ocupación (array de booleanos)
@app.route('/api/estado')
def api_estado():
    start_video_processor_if_needed()
    return jsonify(video_processor.get_estado_espacios())

# Endpoint devuelve coordenadas de espacios (x,y,w,h)
@app.route('/api/espacios')
def api_espacios():
    # devolvemos la variable actual de app_camera (aseguramos que se lea la variable del módulo)
    return jsonify(app_camera.espacios)

# Endpoint para iniciar cámara explícitamente (útil para botón "Conectar")
@app.route('/api/start_camera', methods=['POST'])
def api_start_camera():
    start_video_processor_if_needed()
    return jsonify({'ok': True})

# Endpoint para detener la cámara (útil para botón "Desconectar")
@app.route('/api/stop_camera', methods=['POST'])
def api_stop_camera():
    stop_video_processor()
    return jsonify({'ok': True})

# Snapshot (imagen JPEG única, útil para calibración)
@app.route('/snapshot')
def snapshot():
    start_video_processor_if_needed()
    # tomamos copia segura del frame raw (no anotado)
    with video_processor.lock:
        frame = video_processor.frame.copy() if video_processor.frame is not None else None
    if frame is None:
        # no frame aún
        return ("No frame", 503)
    # codificar a JPEG
    ret, jpeg = cv2.imencode('.jpg', frame)
    if not ret:
        return ("Encode error", 500)
    return Response(jpeg.tobytes(), mimetype='image/jpeg')

# Guardar nuevas coordenadas de espacios (POST JSON: array de [x,y,w,h])
@app.route('/api/save_espacios', methods=['POST'])
def api_save_espacios():
    data = request.get_json()
    if not isinstance(data, list):
        return jsonify({'error': 'payload must be a list of [x,y,w,h]'}), 400

    # validar
    try:
        new_rois = []
        for item in data:
            if isinstance(item, dict):
                # aceptar {x,y,w,h} también
                x = int(item.get('x'))
                y = int(item.get('y'))
                w = int(item.get('w'))
                h = int(item.get('h'))
            else:
                x, y, w, h = map(int, item)
            new_rois.append((x, y, w, h))
    except Exception as e:
        return jsonify({'error': 'invalid ROI format', 'detail': str(e)}), 400

    # Guardar en espacios.pkl
    try:
        with open('espacios.pkl', 'wb') as f:
            pickle.dump(new_rois, f)
    except Exception as e:
        return jsonify({'error': 'failed to save pkl', 'detail': str(e)}), 500

    # Actualizar la variable en el módulo app_camera (para que VideoProcessor la use en el siguiente loop)
    app_camera.espacios = new_rois

    # Si el video_processor está corriendo, ajustar su estado_espacios a la nueva longitud
    if video_processor is not None:
        with video_processor.lock:
            video_processor.estado_espacios = [False] * len(new_rois)

    return jsonify({'ok': True, 'count': len(new_rois)})

# Endpoint para recargar espacios.pkl desde disco (por si editas fuera)
@app.route('/api/reload_espacios', methods=['POST'])
def api_reload_espacios():
    if not os.path.exists('espacios.pkl'):
        return jsonify({'error': 'espacios.pkl not found'}), 404
    try:
        with open('espacios.pkl', 'rb') as f:
            new_rois = pickle.load(f)
    except Exception as e:
        return jsonify({'error': 'failed to load pkl', 'detail': str(e)}), 500

    app_camera.espacios = new_rois
    if video_processor is not None:
        with video_processor.lock:
            video_processor.estado_espacios = [False] * len(new_rois)

    return jsonify({'ok': True, 'count': len(new_rois)})

# ----------------- Arranque -----------------
if __name__ == '__main__':
    # arrancar el servidor (no arrancamos el video_processor automáticamente aquí si no queremos)
    # pero dejo comportamiento para arrancar el video_processor cuando la primera petición lo requiera.
    try:
        app.run(host='0.0.0.0', port=5000, debug=True)
    finally:
        # parar la cámara si quedó viva
        stop_video_processor()
