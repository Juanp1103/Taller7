#!/usr/bin/env node
/*
 * SimClin — el MISMO servidor, pero en Node.js
 * ---------------------------------------------------------------
 * Existe para que el prototipo corra en computadores donde no hay Python
 * (Windows trae un "atajo" de python que en realidad no es Python y falla).
 * Hace exactamente lo mismo que servidor.py y sirve las mismas páginas:
 *
 *     node servidor.js            (puerto 8080)
 *     node servidor.js 9000
 *
 * No usa ninguna librería externa: solo lo que trae Node.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const AQUI = __dirname;
const ESTATICOS = path.join(AQUI, "static");
const REGISTROS = path.join(AQUI, "registros");
const PUERTO = parseInt(process.argv[2] || process.env.SIMCLIN_PUERTO || "8080", 10);
// El lector normalmente corre en el mismo computador. Si corre en el del
// simulador, se escribe su dirección en lector_url.txt y no hay que tocar nada
// más (también sirve la variable de entorno LECTOR_URL).
const LECTOR_URL = (() => {
  try {
    const t = fs.readFileSync(path.join(AQUI, "lector_url.txt"), "utf8").trim();
    if (t && !t.startsWith("#")) return t;
  } catch (e) { /* no existe: se usa el de siempre */ }
  return process.env.LECTOR_URL || "http://127.0.0.1:5050/vitals";
})();
const LECTOR_VIGENCIA_S = 5;
const CONTROL_INACTIVO_S = 12;
const TICK_MS = 500;

const DATOS = JSON.parse(fs.readFileSync(path.join(AQUI, "escenarios.json"), "utf-8"));

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const ahora = () => Date.now() / 1000;

function severidadVital(clave, valor) {
  const d = DATOS.signos_vitales[clave];
  const v = Array.isArray(valor) ? valor[0] : valor;
  if (v < d.crit[0] || v > d.crit[1]) return "crit";
  if (v < d.warn[0] || v > d.warn[1]) return "warn";
  return "ok";
}

function formatearVital(clave, valor) {
  const d = DATOS.signos_vitales[clave];
  if (clave === "ta") return `${Math.round(valor[0])}/${Math.round(valor[1])}`;
  const dec = d.decimales || 0;
  return dec ? valor.toFixed(dec) : String(Math.round(valor));
}

function etapa(etapas, intensidad) {
  let actual = etapas[0];
  for (const e of etapas) if (intensidad + 1e-9 >= e[0]) actual = e;
  return { texto: actual[1], severidad: actual[2] };
}

// ---------------- estado ----------------
const E = {
  version: 0,
  escenario: "heroina",
  mostrar_dx: false,
  mostrar_conteos: true,
  // Esconde los signos vitales y el ECG para que la imagen del paciente use
  // todo el ancho del televisor.
  ocultar_vitales: false,
  // Hoy solo la cabeza tiene modelo 3D. Mientras el resto del cuerpo no esté
  // modelado, el celular no debería dejar entrar a sistemas que no existen.
  solo_modelados: true,
  url_control: null,            // cuál de las direcciones se muestra en el QR
  lector_valores: {},
  lector_ts: 0,
  controlador: null,
  visto: {},
  snapshot: {},
  suscriptores: new Set(),
};

// Las maniobras que el estudiante puede hacerle al paciente desde el control.
// "exige" es la maniobra que tiene que estar hecha primero: no se puede sacar
// la lengua con la boca cerrada.
const MANIOBRAS = {
  boca:   { nombre: "Abrir la boca", exige: null, disponible: true },
  // La lengua está lista en el servidor y en el control, pero apagada: el
  // modelo que entregó el diseñador tiene la lengua colgada por debajo del
  // arco dental y con el rig compartido, así que no se puede sacar sin romper
  // la boca (ver el comentario en static/visor3d.js). El día que llegue bien,
  // se pone disponible en true y queda andando.
  lengua: { nombre: "Sacar la lengua", exige: "boca", disponible: false },
};

function nuevaSesion() {
  E.corriendo = false;
  E.iniciado = false;
  E.acumulado = 0;
  E.inicio_tramo = null;
  E.intensidad = 0;
  E.objetivo = 0;
  E.velocidad = 0;
  E.rampa_s = 180;
  E.sistema = null;
  E.subvista = null;
  // Parámetros visuales que el profesor fijó a mano (nombre -> valor).
  // Se sueltan al reiniciar: cada grupo empieza con el escenario tal cual.
  E.visual_manual = {};
  // Maniobras de exploración: las hace EL ESTUDIANTE desde el control, no el
  // profesor. Son acciones sobre el paciente (abrirle la boca, sacarle la
  // lengua), no ayudas: no dicen nada, solo dejan ver.
  E.maniobras = Object.fromEntries(Object.keys(MANIOBRAS).map((n) => [n, false]));
  const f = new Date();
  const p = (n) => String(n).padStart(2, "0");
  E.sesion_id = `${f.getFullYear()}${p(f.getMonth() + 1)}${p(f.getDate())}_${p(f.getHours())}${p(f.getMinutes())}${p(f.getSeconds())}`;
  E.archivo_registro = path.join(REGISTROS, `sesion_${E.sesion_id}.jsonl`);
}
nuevaSesion();

function transcurrido() {
  let t = E.acumulado;
  if (E.corriendo && E.inicio_tramo) t += ahora() - E.inicio_tramo;
  return t;
}

function registrar(evento, datos = {}) {
  fs.mkdirSync(REGISTROS, { recursive: true });
  const fila = {
    hora: new Date().toISOString().slice(0, 23),
    t_caso_s: Math.round(transcurrido() * 10) / 10,
    evento, ...datos,
  };
  fs.appendFileSync(E.archivo_registro, JSON.stringify(fila) + "\n", "utf-8");
}

const lectorVigente = () => ahora() - E.lector_ts < LECTOR_VIGENCIA_S && Object.keys(E.lector_valores).length > 0;

function avanzar(dt) {
  const esc = DATOS.escenarios[E.escenario];
  const fuente = esc.intensidad_desde_dato_real;
  if (lectorVigente() && fuente && E.lector_valores[fuente.signo] != null) {
    const v = E.lector_valores[fuente.signo];
    E.intensidad = clamp((v - fuente.estable) / (fuente.maximo - fuente.estable));
    E.objetivo = E.intensidad;
  } else if (E.corriendo && E.velocidad > 0) {
    const paso = E.velocidad * dt;
    if (Math.abs(E.objetivo - E.intensidad) <= paso) E.intensidad = E.objetivo;
    else E.intensidad += E.objetivo > E.intensidad ? paso : -paso;
  }
}

function calcular() {
  const esc = DATOS.escenarios[E.escenario];
  const k = E.intensidad;
  const real = lectorVigente();

  const vitales = {};
  for (const [clave, rango] of Object.entries(esc.vitales)) {
    let valor = clave === "ta"
      ? [lerp(rango[0][0], rango[1][0], k), lerp(rango[0][1], rango[1][1], k)]
      : lerp(rango[0], rango[1], k);
    let origen = "demo";
    if (real && E.lector_valores[clave] != null) { valor = E.lector_valores[clave]; origen = "real"; }
    const d = DATOS.signos_vitales[clave];
    vitales[clave] = {
      nombre: d.nombre, unidad: d.unidad, valor,
      texto: formatearVital(clave, valor),
      severidad: severidadVital(clave, valor), origen,
    };
  }

  const visual = {};
  for (const [n, r] of Object.entries(esc.visual)) visual[n] = Math.round(lerp(r[0], r[1], k) * 1000) / 1000;
  // El profesor puede fijar cualquiera de estos signos a mano y mandar sobre
  // el escenario, como lo haría desde el software del simulador.
  for (const [nombre, v] of Object.entries(E.visual_manual || {})) {
    if (nombre in visual) visual[nombre] = Math.round(v * 1000) / 1000;
  }

  const sistemas = [];
  let totalCrit = 0, totalWarn = 0;
  for (const s of DATOS.sistemas) {
    const items = [];
    for (const h of esc.hallazgos[s.id]) {
      if (h.signo) {
        const v = vitales[h.signo];
        items.push({ nombre: h.nombre, texto: `${v.texto} ${v.unidad}`, severidad: v.severidad, origen: v.origen, signo: h.signo });
      } else {
        const r = etapa(h.etapas, k);
        items.push({ nombre: h.nombre, texto: r.texto, severidad: r.severidad });
      }
    }
    const crit = items.filter((i) => i.severidad === "crit").length;
    const warn = items.filter((i) => i.severidad === "warn").length;
    totalCrit += crit; totalWarn += warn;
    // Con la pupila en manual, el hallazgo escrito tiene que decir lo mismo
    // que se ve, o el panel del facilitador miente.
    if ("pupila_mm" in (E.visual_manual || {})) {
      for (const i of items) {
        if (i.nombre.toLowerCase().startsWith("pupila")) {
          i.texto = textoPupila(visual.pupila_mm);
          i.severidad = severidadPupila(visual.pupila_mm);
        }
      }
    }
    const disponible = !E.solo_modelados || !!s.modelo3d;
    sistemas.push({ ...s, hallazgos: items, criticos: crit, alertas: warn, disponible });
  }

  let estadoPaciente;
  if (!E.iniciado) estadoPaciente = "EN ESPERA";
  else if (totalCrit >= 3) estadoPaciente = "CRÍTICO";
  else if (totalCrit || totalWarn >= 3) estadoPaciente = "ALERTA";
  else estadoPaciente = "ESTABLE";

  const controlActivo = !!(E.controlador && ahora() - (E.visto[E.controlador] || 0) < CONTROL_INACTIVO_S);

  E.snapshot = {
    version: E.version,
    escenario: E.escenario,
    codigo: esc.codigo,
    diagnostico: E.mostrar_dx ? esc.diagnostico : null,
    paciente: esc.paciente,
    motivo: esc.motivo,
    mostrar_dx: E.mostrar_dx,
    mostrar_conteos: E.mostrar_conteos,
    ocultar_vitales: E.ocultar_vitales,
    solo_modelados: E.solo_modelados,
    visual_manual: { ...E.visual_manual },
    maniobras: { ...E.maniobras },
    maniobras_disponibles: Object.entries(MANIOBRAS)
      .filter(([, d]) => d.disponible)
      .map(([id, d]) => ({ id, nombre: d.nombre, exige: d.exige })),
    visual_rango: LIMITES_VISUAL,
    iniciado: E.iniciado,
    corriendo: E.corriendo,
    transcurrido_s: Math.round(transcurrido() * 10) / 10,
    intensidad: Math.round(k * 1000) / 1000,
    estado_paciente: estadoPaciente,
    vitales, visual, sistemas,
    sistema_seleccionado: E.sistema,
    subvista: E.subvista,
    datos_reales: real,
    controlador: controlActivo ? E.controlador : null,
    sesion_id: E.sesion_id,
    escenarios_disponibles: Object.entries(DATOS.escenarios).map(([id, e]) => ({ id, codigo: e.codigo, diagnostico: e.diagnostico })),
    urls: { ...URLS, control: urlsControl() },
    url_control: E.url_control || (urlsControl()[0] || null),
  };
  return E.snapshot;
}

function notificar() {
  E.version += 1;
  const datos = JSON.stringify(calcular());
  for (const res of E.suscriptores) {
    try { res.write(`data: ${datos}\n\n`); } catch (err) { /* el cliente se fue */ }
  }
}

// ---------------- red ----------------
function ipsLocales() {
  const nombres = [];
  for (const [, lista] of Object.entries(os.networkInterfaces())) {
    for (const i of lista || []) {
      if (i.family === "IPv4" && !i.internal) nombres.push(i.address);
    }
  }
  // las 192.168.x / 10.x (wifi de casa o salón) primero
  nombres.sort((a, b) => (a.startsWith("192.168.") || a.startsWith("10.") ? -1 : 1));
  return nombres.length ? nombres : ["127.0.0.1"];
}
// Se recalcula en cada consulta: si prenden el hotspot con el servidor ya
// arrancado, la dirección nueva aparece sola en el panel.
const urlsControl = () => ipsLocales().map((ip) => `http://${ip}:${PUERTO}/control`);

// Para que en la ventana negra se vea cuál dirección sirve de verdad.
function etiquetaRed(url) {
  const ip = url.split("//").pop().split(":")[0];
  if (ip.startsWith("192.168.137.")) return "<-- ESTA (punto de acceso de Windows)";
  if (ip.startsWith("192.168.")) return "(wifi o router local: casi siempre sirve)";
  if (ip.startsWith("10.")) return "(red institucional: casi siempre bloquea el celular)";
  if (ip.startsWith("172.")) return "(red institucional o adaptador virtual)";
  return "";
}
const IPS = ipsLocales();
const URLS = {
  control: IPS.map((ip) => `http://${ip}:${PUERTO}/control`),
  monitor: `http://localhost:${PUERTO}/monitor`,
  facilitador: `http://localhost:${PUERTO}/facilitador`,
};

const PAGINAS = { "/monitor": "monitor.html", "/control": "control.html", "/facilitador": "facilitador.html", "/": "inicio.html" };
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".glb": "model/gltf-binary",
};

function responder(res, codigo, cuerpo, tipo = "application/json; charset=utf-8", extra = {}) {
  const datos = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(JSON.stringify(cuerpo), "utf-8");
  res.writeHead(codigo, { "Content-Type": tipo, "Content-Length": datos.length, "Cache-Control": "no-store", ...extra });
  res.end(datos);
}

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve({}); } });
  });
}

// ---------------- acciones ----------------
function tomarControl(c) {
  const cid = c.cid;
  if (!cid) return { codigo: 400, cuerpo: { error: "falta cid" } };
  E.visto[cid] = ahora();
  const libre = !E.controlador || ahora() - (E.visto[E.controlador] || 0) > CONTROL_INACTIVO_S;
  if (E.controlador === cid || libre || c.forzar) {
    if (E.controlador !== cid) registrar("control_tomado", { cid: cid.slice(-6), forzado: !!c.forzar && !libre });
    E.controlador = cid;
    notificar();
    return { codigo: 200, cuerpo: { ok: true, controlador: true } };
  }
  return { codigo: 200, cuerpo: { ok: true, controlador: false } };
}

// Lo único que el profesor puede mover a mano son estos siete parámetros, que
// son exactamente los que el escenario ya calcula y las vistas ya dibujan.
const LIMITES_VISUAL = {
  pupila_mm: [0.8, 9.0],
  cianosis: [0.0, 1.0],
  palidez: [0.0, 1.0],
  sudor: [0.0, 1.0],
  temblor: [0.0, 1.0],
  parpados: [0.0, 1.0],
  marcas: [0.0, 1.0],
};

function textoPupila(mm) {
  const nombre = mm <= 2.0 ? "Puntiformes"
    : mm < 3.5 ? "Mióticas"
    : mm < 5.5 ? "Normales"
    : mm < 7.0 ? "Midriáticas"
    : "Midriasis marcada";
  return `${nombre}, ${mm.toFixed(1)} mm (manual)`;
}

const severidadPupila = (mm) => (mm <= 2.0 || mm >= 7.0) ? "crit" : (mm < 3.0 || mm >= 6.0) ? "warn" : "ok";

// ¿Ese sistema tiene modelo 3D? Hoy solo la cabeza.
const sistemaModelado = (sid) => !!(DATOS.sistemas.find((s) => s.id === sid) || {}).modelo3d;

/* El estudiante le hace algo al paciente: abrirle la boca, sacarle la lengua.
 * Queda en el registro, que después dice si exploró o no. */
function maniobra(c) {
  if (c.cid !== E.controlador) return { codigo: 403, cuerpo: { error: "este celular no tiene el control" } };
  E.visto[c.cid] = ahora();
  const nombre = c.nombre;
  if (!MANIOBRAS[nombre]) return { codigo: 400, cuerpo: { error: "maniobra desconocida" } };
  if (!MANIOBRAS[nombre].disponible) return { codigo: 409, cuerpo: { error: "esa maniobra no está disponible todavía" } };
  const valor = !!c.valor;
  E.maniobras[nombre] = valor;
  if (valor) {
    // Encender una arrastra la que necesita: no se saca la lengua con la boca cerrada.
    const exige = MANIOBRAS[nombre].exige;
    if (exige) E.maniobras[exige] = true;
  } else {
    // Apagar una apaga las que dependían de ella.
    for (const [otro, d] of Object.entries(MANIOBRAS)) if (d.exige === nombre) E.maniobras[otro] = false;
  }
  registrar("maniobra", { maniobra: nombre, valor, intensidad: Math.round(E.intensidad * 100) / 100 });
  calcular(); notificar();
  return { codigo: 200, cuerpo: { ok: true, maniobras: { ...E.maniobras } } };
}

function seleccionar(c) {
  if (c.cid !== E.controlador) return { codigo: 403, cuerpo: { error: "este celular no tiene el control" } };
  E.visto[c.cid] = ahora();
  const porId = Object.fromEntries(DATOS.sistemas.map((s) => [s.id, s]));
  const sistema = c.sistema ?? null;
  if (sistema !== null && !porId[sistema]) return { codigo: 400, cuerpo: { error: "sistema desconocido" } };
  if (sistema !== null && E.solo_modelados && !sistemaModelado(sistema))
    return { codigo: 409, cuerpo: { error: "ese sistema no está disponible en este prototipo" } };
  const subs = sistema ? (porId[sistema].subvistas || []).map((v) => v.id) : [];
  let subvista = c.subvista ?? null;
  if (subvista !== null && !subs.includes(subvista)) subvista = null;
  if (sistema !== E.sistema) {
    E.sistema = sistema;
    E.subvista = subvista || (subs.length ? subs[0] : null);
    registrar(sistema ? "sistema_abierto" : "vista_general", { sistema, subvista: E.subvista, intensidad: Math.round(E.intensidad * 100) / 100 });
  } else if (subvista && subvista !== E.subvista) {
    E.subvista = subvista;
    registrar("subvista_abierta", { sistema, subvista, intensidad: Math.round(E.intensidad * 100) / 100 });
  }
  notificar();
  return { codigo: 200, cuerpo: { ok: true } };
}

function facilitador(c) {
  const { accion, valor } = c;
  if (accion === "escenario" && DATOS.escenarios[valor]) {
    E.escenario = valor; nuevaSesion(); E.escenario = valor;
    registrar("escenario", { escenario: valor });
  } else if (accion === "iniciar") {
    if (!E.iniciado) {
      E.iniciado = true;
      // El caso arranca mostrando el primer sistema que tenga modelo: con solo
      // la cabeza hecha, una "vista general" del cuerpo no aporta nada y
      // obligaba a un toque de más.
      if (E.sistema === null) {
        const primero = DATOS.sistemas.find((s) => !E.solo_modelados || sistemaModelado(s.id));
        if (primero) {
          E.sistema = primero.id;
          const subs = (primero.subvistas || []).map((v) => v.id);
          E.subvista = subs.length ? subs[0] : null;
        }
      }
      registrar("caso_iniciado", { escenario: E.escenario, rampa_s: E.rampa_s, sistema: E.sistema, subvista: E.subvista });
    }
    if (!E.corriendo) {
      E.corriendo = true; E.inicio_tramo = ahora();
      E.objetivo = 1; E.velocidad = 1 / Math.max(E.rampa_s, 10);
      registrar("reanudado");
    }
  } else if (accion === "pausar" && E.corriendo) {
    E.acumulado += ahora() - E.inicio_tramo; E.corriendo = false; registrar("pausado");
  } else if (accion === "reiniciar") {
    registrar("reiniciado");
    const esc = E.escenario; nuevaSesion(); E.escenario = esc;
    registrar("sesion_nueva", { escenario: E.escenario });
  } else if (accion === "intensidad") {
    const v = clamp(parseFloat(valor) || 0);
    E.intensidad = v; E.objetivo = v; E.velocidad = 0;
    registrar("intensidad_manual", { valor: Math.round(v * 100) / 100 });
  } else if (accion === "empeorar") {
    E.objetivo = 1; E.velocidad = 1 / Math.max(E.rampa_s, 10); registrar("progresion_automatica");
  } else if (accion === "mejorar") {
    E.objetivo = 0.1; E.velocidad = 1 / 45; registrar("simular_mejoria");
  } else if (accion === "rampa") {
    E.rampa_s = Math.max(10, parseFloat(valor) || 180);
    if (E.objetivo >= 1 && E.velocidad > 0) E.velocidad = 1 / E.rampa_s;
  } else if (accion === "mostrar_dx") {
    E.mostrar_dx = !!valor;
  } else if (accion === "url_control") {
    E.url_control = valor ? String(valor) : null;
    registrar("url_control", { valor: E.url_control });
  } else if (accion === "mostrar_conteos") {
    E.mostrar_conteos = !!valor; registrar("mostrar_conteos", { valor: !!valor });
  } else if (accion === "visual_manual") {
    // valor = {nombre: "cianosis", valor: 0.8}  |  valor null = auto
    const d = (valor && typeof valor === "object") ? valor : {};
    const nombre = d.nombre;
    if (!(nombre in LIMITES_VISUAL)) return { codigo: 400, cuerpo: { error: "parámetro visual desconocido" } };
    const v = d.valor;
    if (v === null || v === undefined || v === "") {
      delete E.visual_manual[nombre];
      registrar("visual_auto", { parametro: nombre });
    } else {
      const [lo, hi] = LIMITES_VISUAL[nombre];
      E.visual_manual[nombre] = Math.max(lo, Math.min(hi, parseFloat(v)));
      registrar("visual_manual", { parametro: nombre, valor: Math.round(E.visual_manual[nombre] * 1000) / 1000 });
    }
  } else if (accion === "ocultar_vitales") {
    E.ocultar_vitales = !!valor;
    registrar("ocultar_vitales", { valor: !!valor });
  } else if (accion === "visual_todo_auto") {
    E.visual_manual = {};
    registrar("visual_todo_auto");
  } else if (accion === "solo_modelados") {
    E.solo_modelados = !!valor;
    // si se apaga el sistema que estaba abierto, se vuelve a la vista general
    if (E.solo_modelados && E.sistema && !sistemaModelado(E.sistema)) { E.sistema = null; E.subvista = null; }
    registrar("solo_modelados", { valor: !!valor });
  } else if (accion === "soltar_control") {
    registrar("control_liberado"); E.controlador = null;
  } else if (accion === "nota") {
    registrar("nota", { texto: String(valor).slice(0, 500) });
  } else {
    return { codigo: 400, cuerpo: { error: "acción desconocida" } };
  }
  notificar();
  return { codigo: 200, cuerpo: { ok: true } };
}

// ---------------- servidor ----------------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const ruta = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "POST") {
    const cuerpo = await leerCuerpo(req);
    let r = { codigo: 404, cuerpo: { error: "no existe" } };
    if (ruta === "/api/control/tomar") r = tomarControl(cuerpo);
    else if (ruta === "/api/control/seleccionar") r = seleccionar(cuerpo);
    else if (ruta === "/api/control/maniobra") r = maniobra(cuerpo);
    else if (ruta === "/api/facilitador") r = facilitador(cuerpo);
    return responder(res, r.codigo, r.cuerpo);
  }

  if (PAGINAS[ruta]) return archivo(res, path.join(ESTATICOS, PAGINAS[ruta]));
  if (ruta.startsWith("/static/")) {
    const destino = path.resolve(path.join(ESTATICOS, ruta.slice("/static/".length)));
    if (destino.startsWith(ESTATICOS) && fs.existsSync(destino) && fs.statSync(destino).isFile()) return archivo(res, destino);
    return responder(res, 404, { error: "no existe" });
  }
  if (ruta === "/api/estado") return responder(res, 200, calcular());
  if (ruta === "/api/registro") {
    const cuerpo = fs.existsSync(E.archivo_registro) ? fs.readFileSync(E.archivo_registro) : Buffer.from("");
    return responder(res, 200, cuerpo, "application/x-ndjson; charset=utf-8",
      { "Content-Disposition": `attachment; filename="${path.basename(E.archivo_registro)}"` });
  }
  if (ruta === "/favicon.ico") return responder(res, 204, Buffer.from(""), "image/x-icon");
  if (ruta === "/eventos") {
    const cid = url.searchParams.get("cid");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(calcular())}\n\n`);
    res.__cid = cid;
    E.suscriptores.add(res);
    req.on("close", () => E.suscriptores.delete(res));
    return;
  }
  return responder(res, 404, { error: "no existe" });
});

function archivo(res, ruta) {
  if (!fs.existsSync(ruta)) return responder(res, 404, { error: "no existe" });
  responder(res, 200, fs.readFileSync(ruta), TIPOS[path.extname(ruta)] || "application/octet-stream");
}

// ---------------- bucles ----------------
let ultimoTick = ahora();
setInterval(() => {
  const t = ahora();
  avanzar(t - ultimoTick);
  ultimoTick = t;
  for (const res of E.suscriptores) if (res.__cid) E.visto[res.__cid] = t;
  notificar();
}, TICK_MS);

function consultarLector() {
  const req = http.get(LECTOR_URL, { timeout: 900 }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      try {
        const datos = JSON.parse(b);
        const valores = {};
        for (const [k, v] of Object.entries(datos.values || {})) {
          if (Array.isArray(v)) {
            // La TA viaja como par sistólica/diastólica.
            const s = parseFloat(v[0]), d = parseFloat(v[1]);
            if (v.length === 2 && !Number.isNaN(s) && !Number.isNaN(d)) valores[k] = [s, d];
            continue;
          }
          const n = parseFloat(v);
          if (!Number.isNaN(n)) valores[k] = n;
        }
        if (Object.keys(valores).length && ahora() - (datos.updated_at || 0) < LECTOR_VIGENCIA_S) {
          if (!lectorVigente()) registrar("lector_conectado");
          E.lector_valores = valores;
          E.lector_ts = ahora();
        }
      } catch (e) { /* el lector no está corriendo: modo demo */ }
    });
  });
  req.on("timeout", () => req.destroy());
  req.on("error", () => {});
}
setInterval(consultarLector, 1000);

fs.mkdirSync(REGISTROS, { recursive: true });
calcular();
servidor.listen(PUERTO, "0.0.0.0", () => {
  const linea = "=".repeat(64);
  console.log(linea);
  console.log(" SimClin — prototipo corriendo (Node.js)");
  console.log(linea);
  console.log(` Televisor (este computador):   ${URLS.monitor}`);
  console.log(` Facilitador (este computador): ${URLS.facilitador}`);
  console.log(" Celular del estudiante (tiene que estar en la MISMA red):");
  const direcciones = urlsControl().length ? urlsControl() : URLS.control;
  const soloIps = direcciones.map((u) => u.split("//").pop().split(":")[0]);
  const hayHotspot = soloIps.some((ip) => ip.startsWith("192.168.137."));
  const hayCasera = soloIps.some((ip) => ip.startsWith("192.168."));
  for (const u of direcciones) console.log(`     ${u}   ${etiquetaRed(u)}`);
  if (!hayHotspot && !hayCasera) {
    console.log("");
    console.log(" OJO: solo aparece la red institucional. Si el celular escanea el QR");
    console.log("      y no carga nada, es que esa red no deja que los dispositivos se");
    console.log("      vean entre sí. Abran PUNTO_DE_ACCESO.bat (sin cerrar esta ventana)");
    console.log("      y después escojan la dirección 192.168.137.x en el panel.");
  }
  console.log(` Lector de datos reales: ${LECTOR_URL} (si no está corriendo, se usa modo demo)`);
  console.log(" Para detener: Ctrl + C");
  console.log(linea);
});
