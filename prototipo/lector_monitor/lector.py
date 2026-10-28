"""
SIMCLIN — Lector del monitor del simulador
==========================================

Mira la pantalla del "patient monitor" que corre en este mismo computador,
reconoce los números y los publica en http://0.0.0.0:5050/vitals.

El servidor del prototipo pregunta por esa dirección cada segundo. Si contesta,
el televisor cambia solo a "DATOS REALES DEL SIMULADOR" y los signos que vengan
de acá se marcan REAL en vez de SIM. Si no contesta, no pasa nada: el prototipo
sigue en modo demo.

NO usa OCR de propósito general. El monitor dibuja los números siempre con la
misma fuente y el mismo tamaño, así que se comparan contra plantillas recortadas
de la pantalla real. Es más exacto que un OCR y no hay que instalar Tesseract.

Uso:
    python lector.py                 arranca y publica
    python lector.py --probar        captura una vez, imprime lo que lee y sale
    python lector.py --puerto 5050   cambia el puerto

Necesita Pillow:  pip install pillow
"""

import json
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Falta Pillow. Instalalo con:   pip install pillow")
    raise SystemExit(1)

AQUI = Path(__file__).resolve().parent
CONFIG = AQUI / "roi_config.json"
PLANTILLAS = AQUI / "plantillas"

ANCHO_NORM, ALTO_NORM = 16, 28   # tamaño al que se lleva cada dígito para comparar
# Los archivos de plantilla se llaman por el carácter que representan, pero "/"
# no se puede usar como nombre de archivo.
NOMBRE_A_CARACTER = {"barra": "/", "punto": "."}
CARACTER_A_NOMBRE = {v: k for k, v in NOMBRE_A_CARACTER.items()}
PERIODO_S = 0.5                  # cada cuánto se mira la pantalla
HISTORIA = 3                     # cuántas lecturas se guardan para filtrar parpadeos


# ---------------------------------------------------------------- captura ----
def capturar(caja=None):
    """Foto de la pantalla (o de un rectángulo). Devuelve una imagen de Pillow."""
    try:
        import mss
        with mss.mss() as sct:
            if caja is None:
                mon = sct.monitors[0]
                caja = (mon["left"], mon["top"], mon["left"] + mon["width"], mon["top"] + mon["height"])
            x0, y0, x1, y1 = caja
            bruto = sct.grab({"left": x0, "top": y0, "width": x1 - x0, "height": y1 - y0})
            return Image.frombytes("RGB", bruto.size, bruto.bgra, "raw", "BGRX")
    except ImportError:
        pass
    from PIL import ImageGrab          # en Windows y macOS viene con Pillow
    return ImageGrab.grab(bbox=caja, all_screens=True) if caja else ImageGrab.grab(all_screens=True)


# ------------------------------------------------------------ reconocer ------
def pixeles(img):
    """Lista plana de píxeles. Pillow 12 renombró getdata(), así que se prueban
    los dos nombres y funciona con cualquier versión."""
    nuevo = getattr(img, "get_flattened_data", None)
    return list(nuevo()) if nuevo else list(img.getdata())


def a_mascara(img, fondo_oscuro=True):
    """Deja la imagen en blanco y negro: True donde hay número."""
    g = img.convert("L")
    px = pixeles(g)
    lo, hi = min(px), max(px)
    if hi - lo < 25:
        return None, 0, 0                  # recuadro apagado o tapado
    corte = lo + (hi - lo) * 0.5
    if fondo_oscuro:
        bits = [v > corte for v in px]
    else:
        bits = [v < corte for v in px]
    return bits, g.width, g.height


def columnas_con_tinta(bits, w, h):
    return [any(bits[y * w + x] for y in range(h)) for x in range(w)]


def trozos(bits, w, h):
    """Parte la mascara en pedazos verticales: un pedazo por dígito (o por punto)."""
    cols = columnas_con_tinta(bits, w, h)
    salida, inicio = [], None
    for x in range(w + 1):
        tinta = cols[x] if x < w else False
        if tinta and inicio is None:
            inicio = x
        elif not tinta and inicio is not None:
            if x - inicio >= 2:
                salida.append((inicio, x))
            inicio = None
    return salida


def recortar(bits, w, h, x0, x1):
    """Recorta un pedazo y lo lleva al tamaño normalizado."""
    filas = [y for y in range(h) if any(bits[y * w + x] for x in range(x0, x1))]
    if not filas:
        return None, 0
    y0, y1 = filas[0], filas[-1] + 1
    chico = Image.new("1", (x1 - x0, y1 - y0))
    chico.putdata([1 if bits[y * w + x] else 0
                   for y in range(y0, y1) for x in range(x0, x1)])
    return chico.resize((ANCHO_NORM, ALTO_NORM), Image.NEAREST), y1 - y0


def cargar_plantillas(estilo):
    carpeta = PLANTILLAS / estilo
    salida = {}
    if not carpeta.is_dir():
        return salida
    for f in sorted(carpeta.glob("*.png")):
        img = Image.open(f).convert("1").resize((ANCHO_NORM, ALTO_NORM), Image.NEAREST)
        salida[f.stem] = pixeles(img)
    return salida


def parecido(a, b):
    iguales = sum(1 for x, y in zip(a, b) if bool(x) == bool(y))
    return iguales / len(a)


def leer_caja(img, caja, campo, plantillas, avisos=None):
    """Devuelve el número que hay en un recuadro, o None si no se pudo leer.
    En `avisos` deja el motivo, que es lo que imprime el modo --probar."""
    def fallo(motivo):
        if avisos is not None:
            avisos.append(motivo)
        return None

    recorte = img.crop(caja)
    bits, w, h = a_mascara(recorte, campo.get("fondo", "oscuro") == "oscuro")
    if bits is None:
        return fallo("el recuadro está apagado o tapado")
    pedazos = trozos(bits, w, h)
    if not pedazos:
        return fallo("no hay nada dibujado dentro del recuadro")
    # Si la tinta llega al borde, el recuadro está cortando un dígito y lo que
    # se lea va a estar mal. Mejor decirlo que inventar un número.
    if pedazos[0][0] <= 0 or pedazos[-1][1] >= w:
        return fallo("el número toca el borde: agrandá el recuadro")
    normalizados = [recortar(bits, w, h, a, b) for a, b in pedazos]
    normalizados = [(m, alto) for m, alto in normalizados if m is not None]
    if not normalizados:
        return None
    # Los pedazos bajitos son puntos decimales o dos puntos, no dígitos.
    alto_max = max(alto for _, alto in normalizados)
    leidos = []
    umbral = campo.get("umbral", 0.80)
    for mascara, alto in normalizados:
        if alto < alto_max * 0.45:
            continue                       # punto decimal o dos puntos, no un dígito
        datos = pixeles(mascara)
        mejor, puntaje = None, 0.0
        for nombre, plantilla in plantillas.items():
            p = parecido(datos, plantilla)
            if p > puntaje:
                mejor, puntaje = nombre, p
        if mejor is None or puntaje < umbral:
            # Mejor no leer que leer mal.
            return fallo(f"un dígito no se parece a ninguna plantilla ({puntaje:.0%})")
        leidos.append(NOMBRE_A_CARACTER.get(mejor, mejor))
    texto = "".join(leidos)
    if not texto:
        return fallo("no quedó ningún dígito")

    lo, hi = campo.get("rango", [0, 10000])
    dec = campo.get("decimales", 0)

    def numero(t):
        if not t or not t.isdigit():
            return None
        v = float(t) / (10 ** dec) if dec else float(t)
        if not (lo <= v <= hi):
            return None                    # fuera de rango: casi seguro leyó mal
        return v

    if campo.get("tipo") == "par":
        partes = texto.split("/")
        if len(partes) != 2:
            return fallo(f"esperaba dos números separados por barra y leí '{texto}'")
        a, b = numero(partes[0]), numero(partes[1])
        if a is None or b is None:
            return fallo(f"'{texto}' queda fuera del rango {lo}-{hi}")
        return [a, b]
    v = numero(texto)
    return v if v is not None else fallo(f"'{texto}' queda fuera del rango {lo}-{hi}")


def leer_pantalla(cfg, plantillas_por_estilo, img=None, avisos=None):
    campos = cfg["campos"]
    cajas = []
    for c in campos.values():
        cajas.extend(c.get("cajas") or [c["caja"]])
    x0 = min(b[0] for b in cajas); y0 = min(b[1] for b in cajas)
    x1 = max(b[2] for b in cajas); y1 = max(b[3] for b in cajas)
    if img is None:
        img = capturar((x0, y0, x1, y1))
        desfase = (x0, y0)
    else:
        desfase = (0, 0)                   # imagen completa (modo prueba sobre un PNG)

    valores = {}
    for nombre, campo in campos.items():
        plantillas = plantillas_por_estilo.setdefault(
            campo.get("estilo", "normal"), cargar_plantillas(campo.get("estilo", "normal")))
        if not plantillas:
            valores[nombre] = None
            if avisos is not None:
                avisos[nombre] = f"no hay plantillas para el estilo '{campo.get('estilo', 'normal')}'"
            continue
        lista = campo.get("cajas") or [campo["caja"]]
        leidos, motivos = [], []
        for caja in lista:
            c = (caja[0] - desfase[0], caja[1] - desfase[1],
                 caja[2] - desfase[0], caja[3] - desfase[1])
            leidos.append(leer_caja(img, c, campo, plantillas, motivos))
        if avisos is not None and motivos:
            avisos[nombre] = motivos[0]
        if any(v is None for v in leidos):
            valores[nombre] = None
        else:
            valores[nombre] = leidos[0] if len(leidos) == 1 else leidos
    return valores


# -------------------------------------------------------------- publicar ----
class Publicador:
    """Guarda las últimas lecturas y solo publica lo que se repitió."""

    def __init__(self):
        self.lock = threading.Lock()
        self.historia = {}
        self.valores = {}
        self.ts = 0.0

    def agregar(self, leidos):
        with self.lock:
            for nombre, v in leidos.items():
                cola = self.historia.setdefault(nombre, deque(maxlen=HISTORIA))
                cola.append(json.dumps(v))
                # un valor se publica cuando aparece dos veces seguidas: así un
                # parpadeo del monitor o un cursor encima no mueven el número.
                if len(cola) >= 2 and cola[-1] == cola[-2] and v is not None:
                    self.valores[nombre] = v
            if any(v is not None for v in self.valores.values()):
                self.ts = time.time()

    def instantanea(self):
        with self.lock:
            return {"values": dict(self.valores), "updated_at": self.ts}


PUB = Publicador()


class Manejador(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/vitals"):
            cuerpo = json.dumps(PUB.instantanea()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(cuerpo)))
            self.end_headers()
            self.wfile.write(cuerpo)
            return
        # Página mínima para mirar en el laboratorio si está leyendo bien.
        datos = PUB.instantanea()
        filas = "".join(
            f"<tr><td>{k}</td><td>{'—' if v is None else v}</td></tr>"
            for k, v in sorted(datos["values"].items()))
        edad = time.time() - datos["updated_at"] if datos["updated_at"] else 999
        html = (f"<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=1>"
                f"<title>Lector SimClin</title>"
                f"<style>body{{background:#0b1220;color:#e8eefc;font:16px system-ui;padding:24px}}"
                f"td{{padding:4px 18px 4px 0;font-family:ui-monospace,monospace}}</style>"
                f"<h1>Lector del monitor</h1><table>{filas}</table>"
                f"<p>Última lectura hace {edad:.1f} s</p>").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)


def bucle(cfg):
    cache = {}
    while True:
        inicio = time.time()
        try:
            PUB.agregar(leer_pantalla(cfg, cache))
        except Exception as e:
            print("No se pudo leer la pantalla:", e)
        time.sleep(max(0.05, PERIODO_S - (time.time() - inicio)))


def main():
    if not CONFIG.exists():
        print(f"Falta {CONFIG.name}. Corré primero:  python calibrar.py")
        raise SystemExit(1)
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))

    cajas = []
    for c in cfg["campos"].values():
        cajas.extend(c.get("cajas") or [c["caja"]])
    if any(b[2] - b[0] < 4 or b[3] - b[1] < 4 for b in cajas):
        print("roi_config.json todavía no está calibrado: hay recuadros en cero.")
        print("Ver LEEME.txt — primero 'python calibrar.py captura' y después medir")
        print("los recuadros sobre esa foto.")
        raise SystemExit(1)

    if "--probar" in sys.argv:
        # Con un archivo detrás, prueba sobre esa foto en vez de sobre la pantalla.
        i = sys.argv.index("--probar")
        archivo = sys.argv[i + 1] if len(sys.argv) > i + 1 and not sys.argv[i + 1].startswith("-") else None
        img = Image.open(archivo).convert("RGB") if archivo else None
        avisos = {}
        leidos = leer_pantalla(cfg, {}, img, avisos)
        for k, v in sorted(leidos.items()):
            if v is None:
                print(f"  {k:6} NO SE PUDO LEER — {avisos.get(k, 'motivo desconocido')}")
            else:
                print(f"  {k:6} {v}")
        return

    puerto = 5050
    if "--puerto" in sys.argv:
        puerto = int(sys.argv[sys.argv.index("--puerto") + 1])

    threading.Thread(target=bucle, args=(cfg,), daemon=True).start()
    print(f"Lector del monitor en http://127.0.0.1:{puerto}/vitals")
    print("Abrí esa dirección sin /vitals en el navegador para ver qué está leyendo.")
    print("Dejá esta ventana abierta durante la sesión. Ctrl+C para parar.")
    ThreadingHTTPServer(("0.0.0.0", puerto), Manejador).serve_forever()


if __name__ == "__main__":
    main()
