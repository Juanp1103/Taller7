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

const DATOS = JSON.parse(fs.readFileSync(path.join(AQUI, "contenido.json"), "utf-8"));
const SIGNOS = DATOS.signos;            // los signos que la cara sabe mostrar
const TOXIDROMES = Object.fromEntries(DATOS.toxidromes.map((t) => [t.id, t]));

const ahora = () => Date.now() / 1000;

function severidadVital(clave, valor) {
  const d = DATOS.signos_vitales[clave];
  const v = Array.isArray(valor) ? valor[0] : valor;
  const [loC, hiC] = d.crit, [loW, hiW] = d.warn;
  if (v < loC || v > hiC) return "crit";
  if (v < loW || v > hiW) return "warn";
  return "ok";
}

function formatearVital(clave, valor) {
  const d = DATOS.signos_vitales[clave];
  if (clave === "ta") return `${Math.round(valor[0])}/${Math.round(valor[1])}`;
  const dec = d.decimales || 0;
  return dec ? valor.toFixed(dec) : String(Math.round(valor));
}

/* Cómo se llama lo que se está viendo, según la escala del signo. Es lo que lee
 * el profesor en su panel; al estudiante no se le escribe nunca. */
function escalaDe(nombre, valor) {
  const d = SIGNOS[nombre];
  let texto = d.escala[0][1], sev = d.escala[0][2];
  for (const [umbral, t, sv] of d.escala) {
    if (valor + 1e-9 >= umbral) { texto = t; sev = sv; }
  }
  return [texto, sev];
}

function limitarSigno(nombre, valor) {
  const d = SIGNOS[nombre];
  return Math.max(d.min, Math.min(d.max, Number(valor)));
}

// ---------------- estado ----------------
const E = {
  version: 0,
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
  E.sistema = null;
  E.subvista = null;
  // Ya no hay casos ni curva de intensidad: el profesor pone los signos que
  // quiera y arma el toxidrome que va a trabajar. Esto ES el estado clínico,
  // no una excepción sobre un escenario.
  E.signos = Object.fromEntries(Object.entries(SIGNOS).map(([n, d]) => [n, d.normal]));
  E.toxidrome = null;
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

function calcular() {
  const real = lectorVigente();

  // Vitales: SOLO si el lector del simulador manda datos reales. Sin lector no
  // se muestran: un número simulado al lado de la cara estorba más de lo que
  // ayuda, y se presta para que el grupo razone con un dato que nadie midió.
  const vitales = {};
  if (real) {
    for (const [clave, valor] of Object.entries(E.lector_valores)) {
      const d = DATOS.signos_vitales[clave];
      if (!d || valor === null || valor === undefined) continue;
      vitales[clave] = { nombre: d.nombre, unidad: d.unidad, valor,
                         texto: formatearVital(clave, valor),
                         severidad: severidadVital(clave, valor), origen: "real" };
    }
  }

  const visual = Object.fromEntries(Object.entries(E.signos).map(([n, v]) => [n, Math.round(v * 1000) / 1000]));

  // Los hallazgos salen de los signos que puso el profesor, no de una curva:
  // lo que dice el panel y lo que se ve en el televisor no pueden separarse.
  const items = Object.entries(SIGNOS).map(([nombre, d]) => {
    const [texto, severidad] = escalaDe(nombre, E.signos[nombre]);
    return { nombre: d.nombre, texto, severidad, signo: nombre, donde: d.donde || "" };
  });
  const crit = items.filter((i) => i.severidad === "crit").length;
  const warn = items.filter((i) => i.severidad === "warn").length;
  const sistemas = DATOS.sistemas.map((s) => ({
    ...s, hallazgos: s.modelo3d ? items : [], criticos: crit, alertas: warn, disponible: !!s.modelo3d,
  }));

  let estadoPaciente;
  if (!E.iniciado) estadoPaciente = "EN ESPERA";
  else if (crit >= 2) estadoPaciente = "CRÍTICO";
  else if (crit || warn >= 2) estadoPaciente = "ALERTA";
  else estadoPaciente = "SIN HALLAZGOS";

  const t = ahora();
  const controlActivo = !!(E.controlador && t - (E.visto[E.controlador] || 0) < CONTROL_INACTIVO_S);

  E.snapshot = {
    version: E.version,
    signos_def: SIGNOS,
    toxidromes: DATOS.toxidromes.map((x) => ({ id: x.id, nombre: x.nombre, nota: x.nota || "", no_visible: x.no_visible || "" })),
    toxidrome: E.toxidrome,
    maniobras: { ...E.maniobras },
    maniobras_disponibles: Object.entries(MANIOBRAS)
      .filter(([, d]) => d.disponible)
      .map(([id, d]) => ({ id, nombre: d.nombre, exige: d.exige })),
    iniciado: E.iniciado,
    corriendo: E.corriendo,
    transcurrido_s: Math.round(transcurrido() * 10) / 10,
    estado_paciente: estadoPaciente,
    vitales, visual, sistemas,
    sistema_seleccionado: E.sistema,
    subvista: E.subvista,
    datos_reales: real,
    controlador: controlActivo ? E.controlador : null,
    sesion_id: E.sesion_id,
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
  registrar("maniobra", { maniobra: nombre, valor });
  calcular(); notificar();
  return { codigo: 200, cuerpo: { ok: true, maniobras: { ...E.maniobras } } };
}

function seleccionar(c) {
  if (c.cid !== E.controlador) return { codigo: 403, cuerpo: { error: "este celular no tiene el control" } };
  E.visto[c.cid] = ahora();
  const porId = Object.fromEntries(DATOS.sistemas.map((s) => [s.id, s]));
  const sistema = c.sistema ?? null;
  if (sistema !== null && !porId[sistema]) return { codigo: 400, cuerpo: { error: "sistema desconocido" } };
  if (sistema !== null && !sistemaModelado(sistema))
    return { codigo: 409, cuerpo: { error: "ese sistema no está disponible en este prototipo" } };
  const subs = sistema ? (porId[sistema].subvistas || []).map((v) => v.id) : [];
  let subvista = c.subvista ?? null;
  if (subvista !== null && !subs.includes(subvista)) subvista = null;
  if (sistema !== E.sistema) {
    E.sistema = sistema;
    E.subvista = subvista || (subs.length ? subs[0] : null);
    registrar(sistema ? "sistema_abierto" : "vista_general", { sistema, subvista: E.subvista });
  } else if (subvista && subvista !== E.subvista) {
    E.subvista = subvista;
    registrar("subvista_abierta", { sistema, subvista });
  }
  notificar();
  return { codigo: 200, cuerpo: { ok: true } };
}

function facilitador(c) {
  const { accion, valor } = c;
  if (accion === "iniciar") {
    if (!E.iniciado) {
      E.iniciado = true;
      // Arranca mostrando el primer sistema modelado: con solo la cabeza
      // hecha, una "vista general" del cuerpo no aporta nada.
      if (E.sistema === null) {
        const primero = DATOS.sistemas.find((s) => s.modelo3d);
        if (primero) {
          E.sistema = primero.id;
          const subs = (primero.subvistas || []).map((v) => v.id);
          E.subvista = subs.length ? subs[0] : null;
        }
      }
      registrar("sesion_iniciada", { sistema: E.sistema, subvista: E.subvista, signos: { ...E.signos } });
    }
    if (!E.corriendo) {
      E.corriendo = true; E.inicio_tramo = ahora();
      registrar("reanudado");
    }
  } else if (accion === "pausar" && E.corriendo) {
    E.acumulado += ahora() - E.inicio_tramo; E.corriendo = false; registrar("pausado");
  } else if (accion === "reiniciar") {
    registrar("reiniciado");
    nuevaSesion();
    registrar("sesion_nueva");
  } else if (accion === "signo") {
    const d = (valor && typeof valor === "object") ? valor : {};
    if (!(d.nombre in SIGNOS)) return { codigo: 400, cuerpo: { error: "signo desconocido" } };
    const v = limitarSigno(d.nombre, d.valor);
    if (Number.isNaN(v)) return { codigo: 400, cuerpo: { error: "valor inválido" } };
    E.signos[d.nombre] = v;
    E.toxidrome = null;             // ya no es el preajuste tal cual
    registrar("signo", { signo: d.nombre, valor: Math.round(v * 1000) / 1000 });
  } else if (accion === "toxidrome") {
    const t = TOXIDROMES[valor];
    if (!t) return { codigo: 400, cuerpo: { error: "toxidrome desconocido" } };
    for (const [nombre, v] of Object.entries(t.signos)) {
      if (nombre in SIGNOS) E.signos[nombre] = limitarSigno(nombre, v);
    }
    E.toxidrome = t.id;
    registrar("toxidrome", { toxidrome: t.id, signos: { ...E.signos } });
  } else if (accion === "normales") {
    for (const [nombre, d] of Object.entries(SIGNOS)) E.signos[nombre] = d.normal;
    E.toxidrome = null;
    registrar("signos_normales");
  } else if (accion === "url_control") {
    E.url_control = valor ? String(valor) : null;
    registrar("url_control", { valor: E.url_control });
  } else if (accion === "soltar_control") {
    registrar("control_liberado"); E.controlador = null;
  } else if (accion === "nota") {
    registrar("nota", { texto: String(valor).slice(0, 500) });
  } else {
    return { codigo: 400, cuerpo: { error: "acción desconocida" } };
  }
  calcular(); notificar();
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
    // Con ?json=1 lo devuelve interpretado, para pintarlo en el panel.
    if (url.searchParams.get("json")) {
      const filas = [];
      for (const linea of cuerpo.toString("utf-8").split("\n")) {
        if (!linea.trim()) continue;
        try { filas.push(JSON.parse(linea)); } catch (e) { /* línea a medias */ }
      }
      return responder(res, 200, { filas });
    }
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
// Ya no hay curva que avanzar: el tick solo mantiene el reloj al día en las
// pantallas conectadas y refresca quién sigue mirando.
setInterval(() => {
  const t = ahora();
  for (const res of E.suscriptores) if (res.__cid) E.visto[res.__cid] = t;
  calcular();
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
