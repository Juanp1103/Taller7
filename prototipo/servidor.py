#!/usr/bin/env python3
"""
SimClin — servidor del prototipo (monitor en el televisor + control remoto en el celular)
=========================================================================================

Un solo programa, sin instalar nada (solo Python 3). Corre en el computador del salón,
el mismo que ya manda imagen al televisor por HDMI.

    python servidor.py            (puerto 8080 por defecto)
    python servidor.py 9000       (otro puerto)

Páginas que sirve:
    /monitor       -> se abre en el televisor (pantalla completa con F11)
    /control       -> se abre en el celular del estudiante (mismo wifi)
    /facilitador   -> la usa quien corre la prueba de usuario (elige caso, inicia, etc.)

Datos:
    Si el lector OCR (carpeta lector_monitor, modo --live) está corriendo en este mismo
    computador, la FC y la FR se toman de la pantalla REAL del simulador y la evolución
    del cuadro se calcula a partir de ese dato. Si no, el prototipo funciona en modo
    demostración y lo indica claramente en pantalla.

Registro:
    Cada toque del control, cada inicio/pausa y cada cambio queda guardado con hora en
    registros/sesion_AAAAMMDD_HHMMSS.jsonl — para analizar las pruebas de usuario después.
"""
import json
import os
import socket
import sys
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

AQUI = Path(__file__).resolve().parent
ESTATICOS = AQUI / "static"
REGISTROS = AQUI / "registros"
PUERTO = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("SIMCLIN_PUERTO", "8080"))
LECTOR_URL = os.environ.get("LECTOR_URL", "http://127.0.0.1:5050/vitals")
LECTOR_VIGENCIA_S = 5.0        # si el lector no actualiza en este tiempo, se considera desconectado
CONTROL_INACTIVO_S = 12.0      # si el celular que tiene el control deja de responder, se libera
TICK_S = 0.5

with open(AQUI / "escenarios.json", encoding="utf-8") as f:
    DATOS = json.load(f)


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def severidad_vital(clave, valor):
    """Compara contra los rangos del JSON. Para TA se usa la sistólica."""
    d = DATOS["signos_vitales"][clave]
    v = valor[0] if isinstance(valor, (list, tuple)) else valor
    lo_c, hi_c = d["crit"]
    lo_w, hi_w = d["warn"]
    if v < lo_c or v > hi_c:
        return "crit"
    if v < lo_w or v > hi_w:
        return "warn"
    return "ok"


def formatear_vital(clave, valor):
    d = DATOS["signos_vitales"][clave]
    if clave == "ta":
        return f"{round(valor[0])}/{round(valor[1])}"
    dec = d.get("decimales", 0)
    return f"{valor:.{dec}f}" if dec else f"{round(valor)}"


def etapa(etapas, intensidad):
    actual = etapas[0]
    for e in etapas:
        if intensidad + 1e-9 >= e[0]:
            actual = e
    return actual[1], actual[2]


class Estado:
    def __init__(self):
        self.lock = threading.Lock()
        self.cambio = threading.Condition(self.lock)
        self.version = 0
        self.escenario = "heroina"
        self.mostrar_dx = False
        self.mostrar_conteos = True
        # Hoy solo la cabeza tiene modelo 3D. Mientras el resto del cuerpo no esté
        # modelado, el celular no debería dejar entrar a sistemas que no existen.
        self.solo_modelados = True
        self.url_control = None      # cuál de las direcciones se muestra en el QR
        self.nueva_sesion_vars()
        # lector
        self.lector_valores = {}
        self.lector_ts = 0.0
        # control remoto (un solo celular)
        self.controlador = None
        self.visto = {}          # cid -> última vez que se vio conectado
        self.snapshot = {}

    def nueva_sesion_vars(self):
        self.corriendo = False
        self.iniciado = False
        self.acumulado = 0.0
        self.inicio_tramo = None
        self.intensidad = 0.0
        self.objetivo = 0.0
        self.velocidad = 0.0      # unidades de intensidad por segundo
        self.rampa_s = 180.0
        self.sistema = None
        self.subvista = None
        # Parámetros visuales que el profesor fijó a mano (nombre -> valor).
        # Se sueltan al reiniciar: cada grupo empieza con el escenario tal cual.
        self.visual_manual = {}
        self.sesion_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.archivo_registro = REGISTROS / f"sesion_{self.sesion_id}.jsonl"

    # ---------------- registro ----------------
    def registrar(self, evento, **datos):
        REGISTROS.mkdir(exist_ok=True)
        fila = {"hora": datetime.now().isoformat(timespec="milliseconds"),
                "t_caso_s": round(self.transcurrido(), 1), "evento": evento, **datos}
        with open(self.archivo_registro, "a", encoding="utf-8") as f:
            f.write(json.dumps(fila, ensure_ascii=False) + "\n")

    def transcurrido(self):
        t = self.acumulado
        if self.corriendo and self.inicio_tramo:
            t += time.time() - self.inicio_tramo
        return t

    def notificar(self):
        self.version += 1
        self.cambio.notify_all()

    # ---------------- lógica clínica ----------------
    def lector_vigente(self):
        return (time.time() - self.lector_ts) < LECTOR_VIGENCIA_S and bool(self.lector_valores)

    def avanzar(self, dt):
        esc = DATOS["escenarios"][self.escenario]
        real = self.lector_vigente()
        fuente = esc.get("intensidad_desde_dato_real")
        if real and fuente and self.lector_valores.get(fuente["signo"]) is not None:
            v = self.lector_valores[fuente["signo"]]
            self.intensidad = clamp((v - fuente["estable"]) / (fuente["maximo"] - fuente["estable"]))
            self.objetivo = self.intensidad
        elif self.corriendo and self.velocidad > 0:
            paso = self.velocidad * dt
            if abs(self.objetivo - self.intensidad) <= paso:
                self.intensidad = self.objetivo
            else:
                self.intensidad += paso if self.objetivo > self.intensidad else -paso

    def calcular(self):
        esc = DATOS["escenarios"][self.escenario]
        k = self.intensidad
        real = self.lector_vigente()

        vitales = {}
        for clave, (a, b) in esc["vitales"].items():
            if clave == "ta":
                valor = [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]
            else:
                valor = lerp(a, b, k)
            origen = "demo"
            if real and self.lector_valores.get(clave) is not None:
                valor = self.lector_valores[clave]
                origen = "real"
            d = DATOS["signos_vitales"][clave]
            vitales[clave] = {"nombre": d["nombre"], "unidad": d["unidad"],
                              "valor": valor, "texto": formatear_vital(clave, valor),
                              "severidad": severidad_vital(clave, valor), "origen": origen}

        visual = {n: round(lerp(a, b, k), 3) for n, (a, b) in esc["visual"].items()}
        # El profesor puede fijar cualquiera de estos signos a mano y mandar
        # sobre el escenario, como lo haría desde el software del simulador.
        for nombre, v in self.visual_manual.items():
            if nombre in visual:
                visual[nombre] = round(v, 3)

        sistemas = []
        total_crit = total_warn = 0
        for s in DATOS["sistemas"]:
            items = []
            for h in esc["hallazgos"][s["id"]]:
                if "signo" in h:
                    v = vitales[h["signo"]]
                    items.append({"nombre": h["nombre"], "texto": f"{v['texto']} {v['unidad']}",
                                  "severidad": v["severidad"], "origen": v["origen"], "signo": h["signo"]})
                else:
                    texto, sev = etapa(h["etapas"], k)
                    items.append({"nombre": h["nombre"], "texto": texto, "severidad": sev})
            crit = sum(1 for i in items if i["severidad"] == "crit")
            warn = sum(1 for i in items if i["severidad"] == "warn")
            total_crit += crit
            total_warn += warn
            # Con la pupila en manual, el hallazgo escrito tiene que decir lo
            # mismo que se ve, o el panel del facilitador miente.
            if "pupila_mm" in self.visual_manual:
                for i in items:
                    if i["nombre"].lower().startswith("pupila"):
                        i["texto"] = texto_pupila(visual["pupila_mm"])
                        i["severidad"] = severidad_pupila(visual["pupila_mm"])
            disponible = (not self.solo_modelados) or bool(s.get("modelo3d"))
            sistemas.append({**s, "hallazgos": items, "criticos": crit, "alertas": warn,
                             "disponible": disponible})

        if not self.iniciado:
            estado_paciente = "EN ESPERA"
        elif total_crit >= 3:
            estado_paciente = "CRÍTICO"
        elif total_crit or total_warn >= 3:
            estado_paciente = "ALERTA"
        else:
            estado_paciente = "ESTABLE"

        ahora = time.time()
        control_activo = bool(self.controlador and ahora - self.visto.get(self.controlador, 0) < CONTROL_INACTIVO_S)

        self.snapshot = {
            "version": self.version,
            "escenario": self.escenario,
            "codigo": esc["codigo"],
            "diagnostico": esc["diagnostico"] if self.mostrar_dx else None,
            "paciente": esc["paciente"],
            "motivo": esc["motivo"],
            "mostrar_dx": self.mostrar_dx,
            "mostrar_conteos": self.mostrar_conteos,
            "solo_modelados": self.solo_modelados,
            "visual_manual": dict(self.visual_manual),
            "visual_rango": LIMITES_VISUAL,
            "iniciado": self.iniciado,
            "corriendo": self.corriendo,
            "transcurrido_s": round(self.transcurrido(), 1),
            "intensidad": round(k, 3),
            "estado_paciente": estado_paciente,
            "vitales": vitales,
            "visual": visual,
            "sistemas": sistemas,
            "sistema_seleccionado": self.sistema,
            "subvista": self.subvista,
            "datos_reales": real,
            "controlador": self.controlador if control_activo else None,
            "sesion_id": self.sesion_id,
            "escenarios_disponibles": [{"id": i, "codigo": e["codigo"], "diagnostico": e["diagnostico"]}
                                       for i, e in DATOS["escenarios"].items()],
            "urls": {**URLS, "control": ips_urls()},
            "url_control": self.url_control or (ips_urls()[0] if ips_urls() else None),
        }
        return self.snapshot


ESTADO = Estado()


# ---------------- hilos de fondo ----------------
def hilo_simulacion():
    ultimo = time.time()
    while True:
        time.sleep(TICK_S)
        ahora = time.time()
        with ESTADO.lock:
            ESTADO.avanzar(ahora - ultimo)
            ESTADO.calcular()
            ESTADO.notificar()
        ultimo = ahora


def hilo_lector():
    """Pregunta al lector OCR (si existe) cada segundo. Si no responde, no pasa nada."""
    while True:
        try:
            with urllib.request.urlopen(LECTOR_URL, timeout=0.8) as r:
                datos = json.loads(r.read().decode("utf-8"))
            valores = {}
            for k, v in (datos.get("values") or {}).items():
                try:
                    valores[k] = float(v) if v is not None else None
                except (TypeError, ValueError):
                    valores[k] = None
            actualizado = datos.get("updated_at") or 0
            with ESTADO.lock:
                if valores and any(v is not None for v in valores.values()) and time.time() - actualizado < LECTOR_VIGENCIA_S:
                    if not ESTADO.lector_vigente():
                        ESTADO.registrar("lector_conectado")
                    ESTADO.lector_valores = {k: v for k, v in valores.items() if v is not None}
                    ESTADO.lector_ts = time.time()
        except Exception:
            pass
        time.sleep(1.0)


# ---------------- red ----------------
def ips_locales():
    """La IP principal (la de la red que sale a internet/wifi) va primero: es la del QR."""
    principal = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        principal = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    otras = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            otras.add(info[4][0])
    except Exception:
        pass
    lista = ([principal] if principal else []) + sorted(otras - {principal})
    lista = [ip for ip in lista if not ip.startswith("127.")]
    return lista or ["127.0.0.1"]


def ips_urls():
    """Se recalcula en cada consulta: si prenden el hotspot con el servidor ya
    arrancado, la dirección nueva aparece sola en el panel."""
    return [f"http://{ip}:{PUERTO}/control" for ip in ips_locales()]


# Lo único que el profesor puede mover a mano son estos siete parámetros, que
# son exactamente los que el escenario ya calcula y las vistas ya dibujan.
LIMITES_VISUAL = {
    "pupila_mm": [0.8, 9.0],
    "cianosis": [0.0, 1.0],
    "palidez": [0.0, 1.0],
    "sudor": [0.0, 1.0],
    "temblor": [0.0, 1.0],
    "parpados": [0.0, 1.0],
    "marcas": [0.0, 1.0],
}


def texto_pupila(mm):
    if mm <= 2.0:
        nombre = "Puntiformes"
    elif mm < 3.5:
        nombre = "Mióticas"
    elif mm < 5.5:
        nombre = "Normales"
    elif mm < 7.0:
        nombre = "Midriáticas"
    else:
        nombre = "Midriasis marcada"
    return f"{nombre}, {mm:.1f} mm (manual)"


def severidad_pupila(mm):
    if mm <= 2.0 or mm >= 7.0:
        return "crit"
    if mm < 3.0 or mm >= 6.0:
        return "warn"
    return "ok"


def sistema_modelado(sid):
    """¿Ese sistema tiene modelo 3D? Hoy solo la cabeza."""
    for s in DATOS["sistemas"]:
        if s["id"] == sid:
            return bool(s.get("modelo3d"))
    return False


def etiqueta_red(url):
    """Para que en la ventana negra se vea cuál dirección sirve de verdad."""
    ip = url.split("//")[-1].split(":")[0]
    if ip.startswith("192.168.137."):
        return "<-- ESTA (punto de acceso de Windows)"
    if ip.startswith("192.168."):
        return "(wifi o router local: casi siempre sirve)"
    if ip.startswith("10."):
        return "(red institucional: casi siempre bloquea el celular)"
    if ip.startswith("172."):
        return "(red institucional o adaptador virtual)"
    return ""


IPS = ips_locales()
URLS = {
    "control": [f"http://{ip}:{PUERTO}/control" for ip in IPS],
    "monitor": f"http://localhost:{PUERTO}/monitor",
    "facilitador": f"http://localhost:{PUERTO}/facilitador",
}

PAGINAS = {"/monitor": "monitor.html", "/control": "control.html",
           "/facilitador": "facilitador.html", "/": "inicio.html"}
TIPOS = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
         ".png": "image/png", ".svg": "image/svg+xml", ".glb": "model/gltf-binary"}


class Manejador(BaseHTTPRequestHandler):
    server_version = "SimClin/1"

    def log_message(self, fmt, *args):
        pass  # silencioso; los eventos importantes van al registro

    # ---- utilidades ----
    def responder(self, codigo, cuerpo, tipo="application/json; charset=utf-8", extra=None):
        datos = cuerpo if isinstance(cuerpo, bytes) else json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(datos)

    def leer_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # ---- GET ----
    def do_GET(self):
        url = urlparse(self.path)
        ruta = url.path.rstrip("/") or "/"
        if ruta in PAGINAS:
            return self.archivo(ESTATICOS / PAGINAS[ruta])
        if ruta.startswith("/static/"):
            destino = (ESTATICOS / ruta[len("/static/"):]).resolve()
            if ESTATICOS in destino.parents and destino.is_file():
                return self.archivo(destino)
            return self.responder(404, {"error": "no existe"})
        if ruta == "/api/estado":
            with ESTADO.lock:
                return self.responder(200, ESTADO.calcular())
        if ruta == "/api/registro":
            f = ESTADO.archivo_registro
            cuerpo = f.read_bytes() if f.exists() else b""
            return self.responder(200, cuerpo, "application/x-ndjson; charset=utf-8",
                                  {"Content-Disposition": f'attachment; filename="{f.name}"'})
        if ruta == "/favicon.ico":
            return self.responder(204, b"", "image/x-icon")
        if ruta == "/eventos":
            return self.eventos(parse_qs(url.query))
        return self.responder(404, {"error": "no existe"})

    def archivo(self, ruta):
        if not ruta.is_file():
            return self.responder(404, {"error": "no existe"})
        self.responder(200, ruta.read_bytes(), TIPOS.get(ruta.suffix, "application/octet-stream"))

    def eventos(self, q):
        """Server-Sent Events: empuja el estado completo cada vez que cambia."""
        cid = (q.get("cid") or [None])[0]
        rol = (q.get("rol") or ["?"])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        visto_version = -1
        try:
            while True:
                with ESTADO.lock:
                    if ESTADO.version == visto_version:
                        ESTADO.cambio.wait(timeout=2.0)
                    if cid:
                        ESTADO.visto[cid] = time.time()
                    visto_version = ESTADO.version
                    datos = json.dumps(ESTADO.snapshot or ESTADO.calcular(), ensure_ascii=False)
                self.wfile.write(f"data: {datos}\n\n".encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return

    # ---- POST ----
    def do_POST(self):
        ruta = urlparse(self.path).path.rstrip("/")
        cuerpo = self.leer_json()
        with ESTADO.lock:
            if ruta == "/api/control/tomar":
                return self.tomar_control(cuerpo)
            if ruta == "/api/control/seleccionar":
                return self.seleccionar(cuerpo)
            if ruta == "/api/facilitador":
                return self.facilitador(cuerpo)
        return self.responder(404, {"error": "no existe"})

    def tomar_control(self, c):
        cid = c.get("cid")
        if not cid:
            return self.responder(400, {"error": "falta cid"})
        ahora = time.time()
        ESTADO.visto[cid] = ahora
        libre = (ESTADO.controlador is None or
                 ahora - ESTADO.visto.get(ESTADO.controlador, 0) > CONTROL_INACTIVO_S)
        if ESTADO.controlador == cid or libre or c.get("forzar"):
            if ESTADO.controlador != cid:
                ESTADO.registrar("control_tomado", cid=cid[-6:], forzado=bool(c.get("forzar")) and not libre)
            ESTADO.controlador = cid
            ESTADO.calcular()
            ESTADO.notificar()
            return self.responder(200, {"ok": True, "controlador": True})
        return self.responder(200, {"ok": True, "controlador": False})

    def seleccionar(self, c):
        cid = c.get("cid")
        if cid != ESTADO.controlador:
            return self.responder(403, {"error": "este celular no tiene el control"})
        ESTADO.visto[cid] = time.time()
        sistema = c.get("sistema")
        subvista = c.get("subvista")
        por_id = {s["id"]: s for s in DATOS["sistemas"]}
        if sistema is not None and sistema not in por_id:
            return self.responder(400, {"error": "sistema desconocido"})
        if sistema is not None and ESTADO.solo_modelados and not sistema_modelado(sistema):
            return self.responder(409, {"error": "ese sistema no está disponible en este prototipo"})
        subs = [v["id"] for v in por_id.get(sistema, {}).get("subvistas", [])] if sistema else []
        if subvista is not None and subvista not in subs:
            subvista = None
        if sistema != ESTADO.sistema:
            ESTADO.sistema = sistema
            ESTADO.subvista = subvista or (subs[0] if subs else None)
            ESTADO.registrar("sistema_abierto" if sistema else "vista_general", sistema=sistema,
                             subvista=ESTADO.subvista, intensidad=round(ESTADO.intensidad, 2))
        elif subvista and subvista != ESTADO.subvista:
            ESTADO.subvista = subvista
            ESTADO.registrar("subvista_abierta", sistema=sistema, subvista=subvista,
                             intensidad=round(ESTADO.intensidad, 2))
        ESTADO.calcular()
        ESTADO.notificar()
        return self.responder(200, {"ok": True})

    def facilitador(self, c):
        accion = c.get("accion")
        valor = c.get("valor")
        E = ESTADO
        if accion == "escenario" and valor in DATOS["escenarios"]:
            E.escenario = valor
            E.nueva_sesion_vars()
            E.registrar("escenario", escenario=valor)
        elif accion == "iniciar":
            if not E.iniciado:
                E.iniciado = True
                E.registrar("caso_iniciado", escenario=E.escenario, rampa_s=E.rampa_s)
            if not E.corriendo:
                E.corriendo = True
                E.inicio_tramo = time.time()
                E.objetivo = 1.0
                E.velocidad = 1.0 / max(E.rampa_s, 10)
                E.registrar("reanudado")
        elif accion == "pausar" and E.corriendo:
            E.acumulado += time.time() - E.inicio_tramo
            E.corriendo = False
            E.registrar("pausado")
        elif accion == "reiniciar":
            E.registrar("reiniciado")
            E.nueva_sesion_vars()
            E.registrar("sesion_nueva", escenario=E.escenario)
        elif accion == "intensidad":
            v = clamp(float(valor or 0))
            E.intensidad = E.objetivo = v
            E.velocidad = 0.0
            E.registrar("intensidad_manual", valor=round(v, 2))
        elif accion == "empeorar":
            E.objetivo = 1.0
            E.velocidad = 1.0 / max(E.rampa_s, 10)
            E.registrar("progresion_automatica")
        elif accion == "mejorar":
            E.objetivo = 0.1
            E.velocidad = 1.0 / 45.0
            E.registrar("simular_mejoria")
        elif accion == "rampa":
            E.rampa_s = max(10.0, float(valor or 180))
            if E.objetivo >= 1.0 and E.velocidad > 0:
                E.velocidad = 1.0 / E.rampa_s
        elif accion == "mostrar_dx":
            E.mostrar_dx = bool(valor)
        elif accion == "url_control":
            E.url_control = str(valor) if valor else None
            E.registrar("url_control", valor=E.url_control)
        elif accion == "mostrar_conteos":
            E.mostrar_conteos = bool(valor)
            E.registrar("mostrar_conteos", valor=bool(valor))
        elif accion == "visual_manual":
            # valor = {"nombre": "cianosis", "valor": 0.8}  |  valor null = auto
            d = valor if isinstance(valor, dict) else {}
            nombre = d.get("nombre")
            if nombre not in LIMITES_VISUAL:
                return self.responder(400, {"error": "parámetro visual desconocido"})
            v = d.get("valor")
            if v is None or v == "":
                E.visual_manual.pop(nombre, None)
                E.registrar("visual_auto", parametro=nombre)
            else:
                lo, hi = LIMITES_VISUAL[nombre]
                E.visual_manual[nombre] = max(lo, min(hi, float(v)))
                E.registrar("visual_manual", parametro=nombre,
                            valor=round(E.visual_manual[nombre], 3))
        elif accion == "visual_todo_auto":
            E.visual_manual.clear()
            E.registrar("visual_todo_auto")
        elif accion == "solo_modelados":
            E.solo_modelados = bool(valor)
            # si se apaga el sistema que estaba abierto, se vuelve a la vista general
            if E.solo_modelados and E.sistema and not sistema_modelado(E.sistema):
                E.sistema = None
                E.subvista = None
            E.registrar("solo_modelados", valor=bool(valor))
        elif accion == "soltar_control":
            E.registrar("control_liberado")
            E.controlador = None
        elif accion == "nota":
            E.registrar("nota", texto=str(valor)[:500])
        else:
            return self.responder(400, {"error": "acción desconocida"})
        E.calcular()
        E.notificar()
        return self.responder(200, {"ok": True})


def main():
    REGISTROS.mkdir(exist_ok=True)
    with ESTADO.lock:
        ESTADO.calcular()
    threading.Thread(target=hilo_simulacion, daemon=True).start()
    threading.Thread(target=hilo_lector, daemon=True).start()
    servidor = ThreadingHTTPServer(("0.0.0.0", PUERTO), Manejador)
    servidor.daemon_threads = True
    print("=" * 64)
    print(" SimClin — prototipo corriendo")
    print("=" * 64)
    print(f" Televisor (este computador):  {URLS['monitor']}")
    print(f" Facilitador (este computador): {URLS['facilitador']}")
    print(" Celular del estudiante (tiene que estar en la MISMA red):")
    direcciones = ips_urls() or URLS["control"]
    solo_ips = [u.split("//")[-1].split(":")[0] for u in direcciones]
    hay_hotspot = any(ip.startswith("192.168.137.") for ip in solo_ips)
    hay_casera = any(ip.startswith("192.168.") for ip in solo_ips)
    for u in direcciones:
        print(f"     {u}   {etiqueta_red(u)}")
    if not hay_hotspot and not hay_casera:
        print("")
        print(" OJO: solo aparece la red institucional. Si el celular escanea el QR")
        print("      y no carga nada, es que esa red no deja que los dispositivos se")
        print("      vean entre sí. Abran PUNTO_DE_ACCESO.bat (sin cerrar esta ventana)")
        print("      y después escojan la dirección 192.168.137.x en el panel.")
    print(f" Lector de datos reales: {LECTOR_URL} (si no está corriendo, se usa modo demo)")
    print(" Para detener: Ctrl + C")
    print("=" * 64)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nDetenido.")


if __name__ == "__main__":
    main()
