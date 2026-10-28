"""
SIMCLIN — Calibrar el lector del monitor
========================================

Tres cosas, en el orden en que se usan:

  python calibrar.py captura
      Toma una foto de la pantalla completa y la guarda como
      capturas/pantalla_<hora>.png. Hay que tomar 5 o 6, con el paciente en
      estados distintos, para que entre todas aparezcan dígitos variados.
      Esas fotos son las que sirven para definir los recuadros y recortar las
      plantillas de los números.

  python calibrar.py marcar
      Toma una foto y le dibuja encima los recuadros de roi_config.json.
      Sirve para confirmar, en el laboratorio, que cada recuadro quedó donde
      va. Si la ventana del monitor se movió, se nota al instante.

  python calibrar.py plantillas pantalla.png fc=112 fr=6 spo2=88
      Recorta los dígitos de esa foto y los guarda en plantillas/<estilo>/.
      Hay que decirle el valor verdadero de cada campo: así sabe qué dígito es
      cada pedazo. Se corre con varias fotos distintas hasta tener los diez.

Necesita Pillow:  pip install pillow
"""

import json
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

from lector import (ALTO_NORM, ANCHO_NORM, CARACTER_A_NOMBRE, a_mascara, capturar,
                    recortar, trozos)

AQUI = Path(__file__).resolve().parent
CONFIG = AQUI / "roi_config.json"
CAPTURAS = AQUI / "capturas"
PLANTILLAS = AQUI / "plantillas"


def cmd_captura():
    CAPTURAS.mkdir(exist_ok=True)
    destino = CAPTURAS / f"pantalla_{time.strftime('%H%M%S')}.png"
    capturar().save(destino)
    print("Guardada:", destino)
    print("Tomá 5 o 6 con valores bien distintos y pasálas para armar el lector.")


def cmd_marcar():
    if not CONFIG.exists():
        print("Todavía no hay roi_config.json: primero hay que definir los recuadros.")
        return
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    img = capturar().convert("RGB")
    d = ImageDraw.Draw(img)
    for nombre, campo in cfg["campos"].items():
        for caja in (campo.get("cajas") or [campo["caja"]]):
            d.rectangle(caja, outline=(255, 190, 60), width=2)
            d.text((caja[0], max(0, caja[1] - 14)), nombre, fill=(255, 190, 60))
    CAPTURAS.mkdir(exist_ok=True)
    destino = CAPTURAS / "recuadros.png"
    img.save(destino)
    print("Guardada:", destino)
    print("Abrila y confirmá que cada recuadro encierra su número, sin cortar dígitos.")


def cmd_plantillas(ruta, verdades):
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    img = Image.open(ruta).convert("RGB")
    guardados = 0
    for nombre, esperado in verdades.items():
        campo = cfg["campos"].get(nombre)
        if campo is None:
            print(f"  {nombre}: no está en roi_config.json, lo salto")
            continue
        estilo = campo.get("estilo", "normal")
        destino = PLANTILLAS / estilo
        destino.mkdir(parents=True, exist_ok=True)
        cajas = campo.get("cajas") or [campo["caja"]]
        textos = esperado.split("/") if len(cajas) > 1 else [esperado]
        if len(textos) != len(cajas):
            print(f"  {nombre}: esperaba {len(cajas)} números separados por /")
            continue
        for caja, texto in zip(cajas, textos):
            # El punto decimal se descarta solo por ser bajito; la barra de la
            # TA no, así que sí hay que tener su plantilla.
            texto = texto.replace(".", "").replace(",", "")
            bits, w, h = a_mascara(img.crop(caja), campo.get("fondo", "oscuro") == "oscuro")
            if bits is None:
                print(f"  {nombre}: el recuadro salió vacío")
                continue
            pedazos = trozos(bits, w, h)
            normalizados = [recortar(bits, w, h, a, b) for a, b in pedazos]
            normalizados = [(m, alto) for m, alto in normalizados if m is not None]
            if not normalizados:
                continue
            alto_max = max(alto for _, alto in normalizados)
            solo_digitos = [m for m, alto in normalizados if alto >= alto_max * 0.45]
            if len(solo_digitos) != len(texto):
                print(f"  {nombre}: encontré {len(solo_digitos)} dígitos y me dijiste "
                      f"'{texto}' ({len(texto)}). Revisá el recuadro.")
                continue
            for mascara, caracter in zip(solo_digitos, texto):
                archivo = destino / f"{CARACTER_A_NOMBRE.get(caracter, caracter)}.png"
                if archivo.exists():
                    continue                # el primero que aparece se queda
                mascara.resize((ANCHO_NORM, ALTO_NORM), Image.NEAREST).save(archivo)
                guardados += 1
    print(f"Plantillas nuevas: {guardados}")
    for carpeta in sorted(PLANTILLAS.glob("*")):
        if carpeta.is_dir():
            tengo = sorted(f.stem for f in carpeta.glob("*.png"))
            digitos = [t for t in tengo if t.isdigit()]
            faltan = [d for d in "0123456789" if d not in digitos]
            otros = [t for t in tengo if not t.isdigit()]
            print(f"  {carpeta.name}: tengo {''.join(digitos) or '—'}"
                  + (f" + {','.join(otros)}" if otros else "")
                  + (f" · faltan {''.join(faltan)}" if faltan else " · completo"))


def main():
    orden = sys.argv[1] if len(sys.argv) > 1 else "captura"
    if orden == "captura":
        cmd_captura()
    elif orden == "marcar":
        cmd_marcar()
    elif orden == "plantillas":
        if len(sys.argv) < 4:
            print("Uso: python calibrar.py plantillas pantalla.png fc=112 fr=6 ta=112/72")
            return
        verdades = dict(p.split("=", 1) for p in sys.argv[3:] if "=" in p)
        cmd_plantillas(sys.argv[2], verdades)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
