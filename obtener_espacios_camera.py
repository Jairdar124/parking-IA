# obtener_espacios_camera.py
import cv2
import pickle
import os

# Fuente de la cámara (ajusta si usas RTSP)
CAMERA_SOURCE = os.environ.get('CAMERA_SOURCE', '0')

def main():
    src = None
    try:
        src = int(CAMERA_SOURCE)
    except:
        src = CAMERA_SOURCE

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        print("No se pudo abrir la cámara. Revisa CAMERA_SOURCE.")
        return

    ret, frame = cap.read()
    cap.release()
    if not ret or frame is None:
        print("No se pudo leer un frame de la cámara.")
        return

    # Mostrar el frame y seleccionar ROI(s)
    # selectROIs devuelve una lista de rectángulos (x,y,w,h)
    rois = cv2.selectROIs("Selecciona los espacios (Enter para terminar)", frame, showCrosshair=True)
    rois = [tuple(map(int, r)) for r in rois]  # convertir a tupla
    cv2.destroyAllWindows()

    if not rois:
        print("No seleccionaste ningún ROI.")
        return

    # Guardar en espacios.pkl
    with open('espacios.pkl', 'wb') as f:
        pickle.dump(rois, f)
    print(f"Guardados {len(rois)} espacios en espacios.pkl")

if __name__ == '__main__':
    main()
