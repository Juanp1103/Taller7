# SimClin — prototipo para pruebas de usuario

Prototipo funcional del visor de simulación clínica en toxicología (Taller 7, UPB).
Corre en dos dispositivos y no necesita internet ni instalar nada más que Python
o Node.js.

- **Monitor** (televisor del salón): paciente, signos vitales, ECG y el sistema que
  el grupo esté examinando. En "Cabeza y Cuello" se muestra el modelo 3D.
- **Control remoto** (celular de un estudiante): elige qué se amplía en el televisor.
- **Facilitador** (computador de quien corre la prueba): elige el caso, controla la
  evolución en modo demo y anota observaciones.

## Cómo correrlo

En Windows, doble clic en `INICIAR.bat`. El lanzador busca Python y, si no lo
encuentra, arranca con Node.js: `servidor.py` y `servidor.js` son el mismo servidor
escrito en los dos lenguajes y sirven exactamente las mismas páginas y datos.

A mano, desde esta carpeta:

```
python servidor.py      # o  py -3 servidor.py
node servidor.js
```

Después:

- Televisor: `http://localhost:8080/monitor` (pantalla completa con F11)
- Facilitador: `http://localhost:8080/facilitador`
- Celular: escanear el QR del televisor

`INSTRUCCIONES.txt` tiene el detalle completo, incluida la sección del wifi
universitario (las redes institucionales aíslan los dispositivos entre sí; para
eso está `PUNTO_DE_ACCESO.bat`).

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `servidor.py` / `servidor.js` | El servidor, sin dependencias externas. Estado compartido, SSE para empujar cambios y registro de la sesión en JSONL. |
| `escenarios.json` | Todo el contenido clínico: rangos de signos vitales, hallazgos por sistema y cómo evolucionan. Se edita sin tocar código. **Son valores de prueba, pendientes de validación por el profesor de toxicología.** |
| `static/monitor.html` | La vista del televisor. |
| `static/control.html` | El control remoto del celular. |
| `static/facilitador.html` | El panel de quien corre la prueba. |
| `static/visor3d.js` | El visor 3D: material de piel, cianosis por shader, gotas de sudor y vuelos de cámara. |
| `static/modelo.glb` | El modelo del maniquí. Viene de `models/ModeloPrototipo.glb` de la rama `main` de este mismo repo. |
| `static/vendor/three/` | Three.js local, para que el salón pueda estar sin internet. |
| `red/`, `PUNTO_DE_ACCESO.bat` | Ayudante para armar la red cuando el wifi de la universidad no deja conectar el celular. |
| `capturas/` | Capturas de cada vista, para documentación y sustentación. |

## Estado actual y limitaciones conocidas

- **Solo la cabeza está modelada.** El celular solo deja entrar a "Cabeza y Cuello"
  y sus tres acercamientos (cara, labios, ojos). Los demás sistemas existen en el
  contenido clínico pero no se listan; se vuelven a mostrar con la casilla "Solo los
  sistemas que ya tienen modelo 3D" en el panel del facilitador.
- **El modelo es una sola malla con los párpados cerrados.** Por eso la cianosis se
  aproxima con un shader que mide distancia a la boca, y la miosis se muestra como
  un esquema 2D con su aviso en pantalla. Falta que el diseñador entregue ojos,
  pupilas, párpados y lengua como mallas separadas y con nombre.
- **Datos reales vs. demo.** Si el lector OCR del monitor Laerdal está corriendo en
  el mismo computador, FC y FR se marcan como REAL y el resto como SIM. Sin lector,
  todo es SIM y la evolución la maneja el facilitador.
- Los valores clínicos de `escenarios.json` no están validados todavía.
