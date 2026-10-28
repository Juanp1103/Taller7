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

def _url_lector():
    """El lector normalmente corre en el mismo computador. Si corre en el del
    simulador, se escribe su dirección en lector_url.txt y no hay que tocar nada
    más (también sirve la variable de entorno LECTOR_URL)."""
    archivo = AQUI / "lector_url.txt"
    if archivo.exists():
        texto = archivo.read_text(encoding="utf-8").strip()
        if texto and not texto.startswith("#"):
            return texto
    return os.environ.get("LECTOR_URL", "http://127.0.0.1:5050/vitals")


LECTOR_URL = _url_lector()
LECTOR_VIGENCIA_S = 5.0        # si el lector no actualiza en este tiempo, se considera desconectado
CONTROL_INACTIVO_S = 12.0      # si el celular que tiene el control deja de responder, se libera
TICK_S = 0.5

with open(AQUI / "contenido.json", encoding="utf-8") as f:
    DATOS = json.load(f)

SIGNOS = DATOS["signos"]            # los signos que la cara sabe mostrar
TOXIDROMES = {t["id"]: t for t in DATOS["toxidromes"]}


def severidad_vital(clave, valor):
    """Compara contra los rangos del JSON. Para TA se usa la sistólica.
    Solo se usa con valores REALES del lector del simulador."""
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


def escala_de(nombre, valor):
    """Cómo se llama lo que se está viendo, según la escala del signo. Es lo
    que lee el profesor en su panel; al estudiante no se le escribe nunca."""
    d = SIGNOS[nombre]
    texto, sev = d["escala"][0][1], d["escala"][0][2]
    for umbral, t, s in d["escala"]:
        if valor + 1e-9 >= umbral:
            texto, sev = t, s
    return texto, sev


def limitar_signo(nombre, valor):
    d = SIGNOS[nombre]
    return max(d["min"], min(d["max"], float(valor)))


# Las maniobras que el estudiante puede hacerle al paciente desde el control.
# "exige" es la maniobra que tiene que estar hecha primero: no se puede sacar
# la lengua con la boca cerrada.
MANIOBRAS = {
    "boca":   {"nombre": "Abrir la boca", "exige": None, "disponible": True},
    "lengua": {"nombre": "Sacar la lengua", "exige": "boca", "disponible": True},
}


class Estado:
    def __init__(self):
        self.lock = threading.Lock()
        self.cambio = threading.Condition(self.lock)
        self.version = 0
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
        self.sistema = None
        self.subvista = None
        # Ya no hay casos ni curva de intensidad: el profesor pone los signos
        # que quiera y arma el toxidrome que va a trabajar. Esto ES el estado
        # clínico, no una excepción sobre un escenario.
        self.signos = {n: d["normal"] for n, d in SIGNOS.items()}
        self.toxidrome = None        # último botón de toxidrome usado, si alguno
        # Maniobras de exploración: las hace EL ESTUDIANTE desde el control, no
        # el profesor. Son acciones sobre el paciente (abrirle la boca, sacarle
        # la lengua), no ayudas: no dicen nada, solo dejan ver.
        self.maniobras = {n: False for n in MANIOBRAS}
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

    def calcular(self):
        real = self.lector_vigente()

        # Vitales: SOLO si el lector del simulador está mandando datos reales.
        # Sin lector no se muestran. Un número simulado al lado de la cara
        # estorba más de lo que ayuda, y además se presta para que el grupo
        # razone con un dato que nadie midió.
        vitales = {}
        if real:
            for clave, valor in self.lector_valores.items():
                d = DATOS["signos_vitales"].get(clave)
                if d is None or valor is None:
                    continue
                vitales[clave] = {"nombre": d["nombre"], "unidad": d["unidad"],
                                  "valor": valor, "texto": formatear_vital(clave, valor),
                                  "severidad": severidad_vital(clave, valor), "origen": "real"}

        visual = {n: round(v, 3) for n, v in self.signos.items()}

        # Los hallazgos salen de los signos que puso el profesor, no de una
        # curva: lo que dice el panel y lo que se ve en el televisor no pueden
        # separarse nunca.
        items = []
        for nombre, d in SIGNOS.items():
            texto, sev = escala_de(nombre, self.signos[nombre])
            items.append({"nombre": d["nombre"], "texto": texto, "severidad": sev,
                          "signo": nombre, "donde": d.get("donde", "")})
        crit = sum(1 for i in items if i["severidad"] == "crit")
        warn = sum(1 for i in items if i["severidad"] == "warn")
        sistemas = [{**s, "hallazgos": items if s.get("modelo3d") else [],
                     "criticos": crit, "alertas": warn, "disponible": bool(s.get("modelo3d"))}
                    for s in DATOS["sistemas"]]

        if not self.iniciado:
            estado_paciente = "EN ESPERA"
        elif crit >= 2:
            estado_paciente = "CRÍTICO"
        elif crit or warn >= 2:
            estado_paciente = "ALERTA"
        else:
            estado_paciente = "SIN HALLAZGOS"

        ahora = time.time()
        control_activo = bool(self.controlador and ahora - self.visto.get(self.controlador, 0) < CONTROL_INACTIVO_S)

        self.snapshot = {
            "version": self.version,
            "signos_def": SIGNOS,
            "toxidromes": [{"id": t["id"], "nombre": t["nombre"], "nota": t.get("nota", ""),
                            "no_visible": t.get("no_visible", "")}
                           for t in DATOS["toxidromes"]],
            "toxidrome": self.toxidrome,
            "maniobras": dict(self.maniobras),
            "maniobras_disponibles": [{"id": n, "nombre": d["nombre"], "exige": d["exige"]}
                                      for n, d in MANIOBRAS.items() if d["disponible"]],
            "iniciado": self.iniciado,
            "corriendo": self.corriendo,
            "transcurrido_s": round(self.transcurrido(), 1),
            "estado_paciente": estado_paciente,
            "vitales": vitales,
            "visual": visual,
            "sistemas": sistemas,
            "sistema_seleccionado": self.sistema,
            "subvista": self.subvista,
            "datos_reales": real,
            "controlador": self.controlador if control_activo else None,
            "sesion_id": self.sesion_id,
            "urls": {**URLS, "control": ips_urls()},
            "url_control": self.url_control or (ips_urls()[0] if ips_urls() else None),
        }
        return self.snapshot


ESTADO = Estado()


# ---------------- hilos de fondo ----------------
def hilo_simulacion():
    """Ya no hay curva que avanzar: esto solo mantiene el reloj de la sesión al
    día en las pantallas conectadas."""
    while True:
        time.sleep(TICK_S)
        with ESTADO.lock:
            ESTADO.calcular()
            ESTADO.notificar()


def hilo_lector():
    """Pregunta al lector OCR (si existe) cada segundo. Si no responde, no pasa nada."""
    while True:
        try:
            with urllib.request.urlopen(LECTOR_URL, timeout=0.8) as r:
                datos = json.loads(r.read().decode("utf-8"))
            valores = {}
            for k, v in (datos.get("values") or {}).items():
                try:
                    if isinstance(v, (list, tuple)):
                        # La TA viaja como par sistólica/diastólica.
                        valores[k] = [float(v[0]), float(v[1])] if len(v) == 2 else None
                    else:
                        valores[k] = float(v) if v is not None else None
                except (TypeError, ValueError, IndexError):
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
            # Con ?json=1 lo devuelve interpretado, para pintarlo en el panel.
            if parse_qs(url.query).get("json"):
                filas = []
                for linea in cuerpo.decode("utf-8", "replace").splitlines():
                    try:
                        filas.append(json.loads(linea))
                    except ValueError:
                        pass
                return self.responder(200, {"filas": filas})
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
            if ruta == "/api/control/maniobra":
                return self.maniobra(cuerpo)
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

    def maniobra(self, c):
        """El estudiante le hace algo al paciente: abrirle la boca, sacarle la
        lengua. Queda en el registro, que después dice si exploró o no."""
        cid = c.get("cid")
        if cid != ESTADO.controlador:
            return self.responder(403, {"error": "este celular no tiene el control"})
        ESTADO.visto[cid] = time.time()
        nombre = c.get("nombre")
        if nombre not in MANIOBRAS:
            return self.responder(400, {"error": "maniobra desconocida"})
        if not MANIOBRAS[nombre]["disponible"]:
            return self.responder(409, {"error": "esa maniobra no está disponible todavía"})
        valor = bool(c.get("valor"))
        ESTADO.maniobras[nombre] = valor
        if valor:
            # Encender una arrastra la que necesita: no se saca la lengua con
            # la boca cerrada.
            exige = MANIOBRAS[nombre]["exige"]
            if exige:
                ESTADO.maniobras[exige] = True
        else:
            # Apagar una apaga las que dependían de ella.
            for otro, d in MANIOBRAS.items():
                if d["exige"] == nombre:
                    ESTADO.maniobras[otro] = False
        ESTADO.registrar("maniobra", maniobra=nombre, valor=valor)
        ESTADO.calcular()
        ESTADO.notificar()
        return self.responder(200, {"ok": True, "maniobras": dict(ESTADO.maniobras)})

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
        if sistema is not None and not sistema_modelado(sistema):
            return self.responder(409, {"error": "ese sistema no está disponible en este prototipo"})
        subs = [v["id"] for v in por_id.get(sistema, {}).get("subvistas", [])] if sistema else []
        if subvista is not None and subvista not in subs:
            subvista = None
        if sistema != ESTADO.sistema:
            ESTADO.sistema = sistema
            ESTADO.subvista = subvista or (subs[0] if subs else None)
            ESTADO.registrar("sistema_abierto" if sistema else "vista_general", sistema=sistema,
                             subvista=ESTADO.subvista)
        elif subvista and subvista != ESTADO.subvista:
            ESTADO.subvista = subvista
            ESTADO.registrar("subvista_abierta", sistema=sistema, subvista=subvista)
        ESTADO.calcular()
        ESTADO.notificar()
        return self.responder(200, {"ok": True})

    def facilitador(self, c):
        accion = c.get("accion")
        valor = c.get("valor")
        E = ESTADO
        if accion == "iniciar":
            if not E.iniciado:
                E.iniciado = True
                # Arranca mostrando el primer sistema modelado: con solo la
                # cabeza hecha, una "vista general" del cuerpo no aporta nada.
                if E.sistema is None:
                    primero = next((s for s in DATOS["sistemas"] if s.get("modelo3d")), None)
                    if primero:
                        E.sistema = primero["id"]
                        subs = [v["id"] for v in primero.get("subvistas", [])]
                        E.subvista = subs[0] if subs else None
                E.registrar("sesion_iniciada", sistema=E.sistema, subvista=E.subvista,
                            signos={n: round(v, 3) for n, v in E.signos.items()})
            if not E.corriendo:
                E.corriendo = True
                E.inicio_tramo = time.time()
                E.registrar("reanudado")
        elif accion == "pausar" and E.corriendo:
            E.acumulado += time.time() - E.inicio_tramo
            E.corriendo = False
            E.registrar("pausado")
        elif accion == "reiniciar":
            E.registrar("reiniciado")
            E.nueva_sesion_vars()
            E.registrar("sesion_nueva")
        elif accion == "signo":
            # valor = {"nombre": "cianosis", "valor": 0.8}
            d = valor if isinstance(valor, dict) else {}
            nombre = d.get("nombre")
            if nombre not in SIGNOS:
                return self.responder(400, {"error": "signo desconocido"})
            try:
                E.signos[nombre] = limitar_signo(nombre, d.get("valor"))
            except (TypeError, ValueError):
                return self.responder(400, {"error": "valor inválido"})
            E.toxidrome = None       # ya no es el preajuste tal cual
            E.registrar("signo", signo=nombre, valor=round(E.signos[nombre], 3))
        elif accion == "toxidrome":
            t = TOXIDROMES.get(valor)
            if t is None:
                return self.responder(400, {"error": "toxidrome desconocido"})
            for nombre, v in t["signos"].items():
                if nombre in SIGNOS:
                    E.signos[nombre] = limitar_signo(nombre, v)
            E.toxidrome = t["id"]
            E.registrar("toxidrome", toxidrome=t["id"],
                        signos={n: round(v, 3) for n, v in E.signos.items()})
        elif accion == "normales":
            for nombre, d in SIGNOS.items():
                E.signos[nombre] = d["normal"]
            E.toxidrome = None
            E.registrar("signos_normales")
        elif accion == "url_control":
            E.url_control = str(valor) if valor else None
            E.registrar("url_control", valor=E.url_control)
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
