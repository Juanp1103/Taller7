/* SimClin — visor 3D del paciente
 * ------------------------------------------------------------------
 * Modelo: static/modelo.glb, el personaje que armó el diseñador con MB-Lab.
 * Es un cuerpo completo a escala real (1,73 m) y EN METROS, así que todas las
 * medidas de abajo están en metros y la cara está allá arriba, cerca de y=1,6.
 * El visor solo encuadra la cabeza; el resto del cuerpo nunca entra en cuadro.
 *
 * El archivo que usamos NO es el que entrega MB-Lab tal cual: se le conectaron
 * las texturas (salían sin nada), se le dejaron solo seis morphs de los 82 que
 * traía, y se comprimió de 28,9 MB a 2,6 MB. Si llega una reexportación nueva
 * hay que repetir ese arreglo, está descrito en MODELO.md.
 *
 * Partes del modelo que importan, identificadas por el NOMBRE DEL MATERIAL:
 *   Character_MBLab_skin3        la piel: cuerpo, cara y el interior de la boca
 *   Character_MBLab_tongue       la lengua
 *   Character_MBLab_Iris_V4      el iris de los dos ojos
 *   Character_MBlab_pupil        la pupila del modelo (se esconde: ver abajo)
 *   Character_MBlab_human_eyes   la esclerótica
 *   Character_MBlab_cornea       la córnea, transparente
 *
 * Y los morphs que usamos:
 *   Expressions_mouthOpen_max    abrir la boca
 *   Expressions_tongueOut_max    sacar la lengua
 *
 * Lo que pone la app encima del modelo:
 *   - Cianosis alrededor de la boca y color de piel (pálida o rubicunda) en
 *     toda la cara, con un shader que respeta la textura de la escultura.
 *   - Cianosis CENTRAL en la lengua, que es donde se valora de verdad. Por eso
 *     la lengua se tiñe más y sin depender de la distancia a la boca.
 *   - Sudoración: la piel se vuelve brillante y aparecen gotas pegadas a la
 *     frente y las mejillas, colocadas lanzando rayos contra la malla.
 *   - La PUPILA, en milímetros reales. El modelo trae su propia pupila con un
 *     morph de dilatación, pero ese morph solo va de 3,3 a 5,7 mm y nosotros
 *     necesitamos desde 0,8 (puntiforme) hasta 9. Así que la pupila del modelo
 *     se esconde y dibujamos la nuestra encima del iris, del diámetro exacto.
 *
 * Todas las medidas de abajo están tomadas sobre ESTE modelo, en coordenadas
 * de mundo y en METROS, con la cara mirando hacia +Z. Si llega un modelo nuevo
 * hay que volver a medirlas.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const PALIDEZ = new THREE.Color(0xd9cec7);
const RUBICUNDEZ = new THREE.Color(0xc9654a);
const CIANOSIS = new THREE.Color(0x5f5a8a);
const CIANOSIS_LENGUA = new THREE.Color(0x6b5f93);

// Centro de la boca y radio de la zona que se tiñe de cianosis. Los labios son
// una elipse ancha y baja, así que la máscara aplasta el eje X: con una esfera
// el morado se subía al bigote y bajaba a la barbilla. El radio quedó apretado
// a propósito: con uno más grande los dientes también salían morados.
const BOCA = new THREE.Vector3(0, 1.5515, 0.1575);
const RADIO_BOCA = 0.0140;
const ACHATADO_BOCA = 0.5;

// El iris de este modelo es un disco plano mirando a +Z. Nuestra pupila se
// dibuja justo delante. Medido: iris de 11,66 mm, separación entre ojos 61,6 mm.
const OJO = { x: 0.0308, y: 1.6167, z: 0.1346 };

// Los dos morphs que el estudiante maneja desde el control.
const MORPH_BOCA = "Expressions_mouthOpen_max";
const MORPH_LENGUA = "Expressions_tongueOut_max";

/* Cada vista dice QUÉ zona hay que ver, no dónde poner la cámara: la
 * distancia se calcula con la forma que tenga el panel en ese momento. Así el
 * encuadre sigue siendo correcto cuando se esconden los signos vitales y la
 * caja pasa de 820 a 1500 px de ancho.
 * La cabeza de este modelo mide 171 x 226 mm, con la barbilla en y=1,50 y la
 * coronilla en y=1,73. La vista de labios va un poco más abierta que la de
 * antes porque al abrir la boca el mentón baja 35 mm. */
export const VISTAS = {
  cara:   { centro: [0, 1.6080, 0.060], ancho: 0.200, alto: 0.256, fov: 36 },
  labios: { centro: [0, 1.5465, 0.118], ancho: 0.108, alto: 0.078, fov: 24 },
  ojos:   { centro: [0, 1.6167, 0.100], ancho: 0.122, alto: 0.056, fov: 20 },
};

/* El modelo se prepara UNA sola vez y se reutiliza. Como el televisor solo
 * muestra un visor a la vez, al agregarlo a la escena nueva Three.js lo saca
 * solo de la anterior. */
let promesaModelo = null;

function cargarModelo() {
  if (!promesaModelo) {
    promesaModelo = new Promise((ok, falla) => {
      new GLTFLoader().load("/static/modelo.glb", (gltf) => ok(prepararModelo(gltf.scene)), undefined, falla);
    });
    promesaModelo.catch(() => { promesaModelo = null; });   // deja reintentar
  }
  return promesaModelo;
}

/* Los uniformes viven en el módulo porque el modelo también: hay un solo
 * paciente en pantalla y así el estado sobrevive a reabrir el sistema. */
const uniformes = {
  uBoca: { value: BOCA.clone() },
  uRadio: { value: RADIO_BOCA },
  uAchatado: { value: ACHATADO_BOCA },
  uCianosis: { value: 0 },
  // Un solo eje para el color de la piel: negativo pálido, positivo rubicundo.
  // Son los dos extremos de lo mismo y así el profesor tiene un control, no dos.
  uPiel: { value: 0 },
  uColorCianosis: { value: CIANOSIS.clone() },
  uColorPalidez: { value: PALIDEZ.clone() },
  uColorRubicundez: { value: RUBICUNDEZ.clone() },
};
const uniformesLengua = {
  uCianosis: uniformes.uCianosis,
  uColorCianosis: { value: CIANOSIS_LENGUA.clone() },
};

/* Tiñe la piel SIN perder la textura ni el relieve de la escultura: se
 * engancha al material que trae el modelo en vez de reemplazarlo. La cianosis
 * se concentra alrededor de la boca; el color de piel cubre toda la cara.
 * Se usa la posición en coordenadas de mundo, así que no importa cómo esté
 * escalado o rotado el nodo de la cabeza.
 * Ojo con "transformed" y no "position" en el vértice: este modelo tiene
 * morphs, y lo que hay que mirar es la posición YA deformada; si no, la
 * máscara se queda quieta cuando la boca se abre. */
function pintarPiel(material) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniformes);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMundo;")
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\nvMundo = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vMundo;
        uniform vec3 uBoca; uniform float uRadio; uniform float uAchatado;
        uniform float uCianosis; uniform float uPiel;
        uniform vec3 uColorCianosis; uniform vec3 uColorPalidez; uniform vec3 uColorRubicundez;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 rel = vMundo - uBoca;
        rel.x *= uAchatado;
        float d = length(rel);
        float mascara = 1.0 - smoothstep(uRadio * 0.60, uRadio * 1.10, d);
        vec3 piel = mix(diffuseColor.rgb, uColorPalidez, max(0.0, -uPiel) * 0.65);
        piel = mix(piel, uColorRubicundez, max(0.0, uPiel) * 0.5);
        piel = mix(piel, uColorCianosis, clamp(uCianosis, 0.0, 1.0) * (0.03 + 0.82 * mascara));
        diffuseColor.rgb = piel;`);
  };
  material.needsUpdate = true;
}

/* La lengua entera se tiñe, sin máscara: la cianosis central se valora en la
 * mucosa y es la que de verdad importa, así que se nota antes y más que la de
 * los labios. */
function pintarLengua(material) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniformesLengua);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>",
        "#include <common>\nuniform float uCianosis;\nuniform vec3 uColorCianosis;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, uColorCianosis, clamp(uCianosis, 0.0, 1.0) * 0.75);`);
  };
  material.needsUpdate = true;
}

/* Gotas de sudor: esferitas pegadas a la frente, las sienes y las mejillas. Se
 * colocan lanzando rayos de frente contra la malla para que queden sobre la
 * piel de este modelo y no en el aire. De cada ancla salen tres gotas con una
 * pizca de azar, para que no se vean en cuadrícula. */
function crearGotas(raiz, cabeza) {
  const rc = new THREE.Raycaster();
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xeaf6ff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0,
  });
  // (x, y) en metros, coordenadas de mundo. Frente, sienes y mejillas.
  const anclas = [
    [0, 1.686], [-0.020, 1.683], [0.020, 1.683], [-0.040, 1.676], [0.040, 1.676],
    [0, 1.674], [-0.020, 1.671], [0.020, 1.671], [-0.042, 1.664], [0.042, 1.664],
    [0, 1.662], [-0.022, 1.658], [0.022, 1.658], [-0.044, 1.652], [0.044, 1.652],
    [-0.058, 1.620], [0.058, 1.620], [-0.054, 1.600], [0.054, 1.600],
    [-0.048, 1.580], [0.048, 1.580], [-0.036, 1.566], [0.036, 1.566],
  ];
  const gotas = [];
  for (const [ax, ay] of anclas) {
    for (let k = 0; k < 3; k++) {
      const x = ax + (Math.random() - 0.5) * 0.011;
      const y = ay + (Math.random() - 0.5) * 0.008;
      rc.set(new THREE.Vector3(x, y, 0.9), new THREE.Vector3(0, 0, -1));
      const hit = rc.intersectObject(cabeza, true)[0];
      if (!hit) continue;
      // Si el rayo pegó en un borde muy inclinado (oreja, contorno de la cara)
      // la gota se vería flotando fuera de la silueta, así que se descarta.
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal.z < 0.3) continue;
      const g = new THREE.Mesh(geo, mat.clone());
      const escala = 0.00055 + Math.random() * 0.00045;
      g.scale.setScalar(escala);
      g.position.copy(hit.point).addScaledVector(normal, escala * 0.55);
      g.userData = { yInicial: g.position.y };
      raiz.add(g);
      gotas.push(g);
    }
  }
  return gotas;
}

/* Deja el modelo listo una sola vez: materiales, pupilas, gotas, y las
 * referencias que hacen falta para las maniobras. */
function prepararModelo(raiz) {
  raiz.updateMatrixWorld(true);

  const pupilas = [];
  const morphs = { boca: [], lengua: [] };
  let materialPiel = null;
  let cabeza = null;

  raiz.traverse((o) => {
    if (!o.isMesh) return;
    const dicc = o.morphTargetDictionary || {};
    if (MORPH_BOCA in dicc) morphs.boca.push({ malla: o, indice: dicc[MORPH_BOCA] });
    if (MORPH_LENGUA in dicc) morphs.lengua.push({ malla: o, indice: dicc[MORPH_LENGUA] });

    const nombre = (o.material && o.material.name) || "";
    // La pupila del modelo se esconde: dibujamos la nuestra, en milímetros.
    if (/pupil/i.test(nombre)) { o.visible = false; return; }
    o.material = o.material.clone();          // conserva textura y normales
    if (/tongue/i.test(nombre)) {
      pintarLengua(o.material);
    } else if (/skin/i.test(nombre)) {
      materialPiel = o.material;
      pintarPiel(o.material);
      // la malla más grande con piel es el cuerpo, y es contra esa que se
      // lanzan los rayos de las gotas
      const n = o.geometry.attributes.position.count;
      if (!cabeza || n > cabeza.geometry.attributes.position.count) cabeza = o;
    }
  });

  // Pupila propia: un disco plano justo delante del iris, con su reflejo.
  for (const lado of [-1, 1]) {
    const pupila = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({ color: 0x07090c })
    );
    pupila.position.set(lado * OJO.x, OJO.y, OJO.z);
    raiz.add(pupila);
    pupilas.push(pupila);

    const brillo = new THREE.Mesh(
      new THREE.CircleGeometry(0.00055, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 })
    );
    brillo.position.set(lado * OJO.x - 0.0022, OJO.y + 0.0022, OJO.z + 0.0002);
    raiz.add(brillo);
  }

  const gotas = cabeza ? crearGotas(raiz, cabeza) : [];
  return { raiz, pupilas, gotas, materialPiel, morphs };
}

export function crearVisor(contenedor) {
  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(VISTAS.cara.fov, 1, 0.002, 50);
  const render = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  render.setPixelRatio(Math.min(devicePixelRatio, 2));
  render.outputColorSpace = THREE.SRGBColorSpace;
  contenedor.appendChild(render.domElement);
  Object.assign(render.domElement.style, { width: "100%", height: "100%", display: "block" });

  escena.add(new THREE.AmbientLight(0xbfd6ff, 0.60));
  const principal = new THREE.DirectionalLight(0xffffff, 2.0);
  principal.position.set(0.5, 2.2, 1.8);
  escena.add(principal);
  const relleno = new THREE.DirectionalLight(0x7fb0ff, 0.55);
  relleno.position.set(-1.4, 1.8, 1.0);
  escena.add(relleno);
  // Con la boca abierta el interior queda en sombra y la lengua no se ve. Esta
  // luz se enciende sola con la apertura y no toca el resto de la cara.
  const luzBoca = new THREE.PointLight(0xffe9e2, 0, 0.09, 2);
  luzBoca.position.set(0, BOCA.y + 0.004, BOCA.z - 0.012);
  escena.add(luzBoca);

  let modelo = null;
  let cargado = false;
  let mmObjetivo = 4, mmActual = 4;
  let bocaObjetivo = 0, bocaActual = 0;
  let lenguaObjetivo = 0, lenguaActual = 0;

  function aplicarPupila(mm) {
    if (!modelo) return;
    // el modelo está en metros, así que el radio en metros es mm/2/1000
    const r = Math.min(Math.max(mm, 0.8), 9) / 2000;
    for (const p of modelo.pupilas) p.scale.set(r, r, 1);
  }

  /* Abrir la boca y sacar la lengua son morphs del propio modelo. */
  function aplicarBoca(v) {
    if (!modelo) return;
    const k = Math.min(Math.max(v, 0), 1);
    for (const m of modelo.morphs.boca) m.malla.morphTargetInfluences[m.indice] = k;
    luzBoca.intensity = k * 0.012;
  }
  function aplicarLengua(v) {
    if (!modelo) return;
    const k = Math.min(Math.max(v, 0), 1);
    for (const m of modelo.morphs.lengua) m.malla.morphTargetInfluences[m.indice] = k;
  }

  cargarModelo().then(
    (m) => {
      modelo = m;
      escena.add(m.raiz);
      aplicarPupila(mmActual);
      aplicarBoca(bocaActual);
      aplicarLengua(lenguaActual);
      cargado = true;
      contenedor.dataset.estado = "listo";
      ajustarTamano();
      irAVista(vistaActual, true);
    },
    (err) => {
      contenedor.dataset.estado = "error";
      console.error("No se pudo cargar el modelo 3D:", err);
    }
  );

  /* ---------- cámara ---------- */
  let vistaActual = "cara";
  let vuelo = null;
  const objetivo = new THREE.Vector3(...VISTAS.cara.centro);

  // Solo dibujamos cuando algo cambió. Un televisor con la cara quieta no
  // necesita 60 cuadros por segundo, y así el portátil no se calienta.
  let cuadrosPendientes = 2;
  const repintar = () => { cuadrosPendientes = Math.max(cuadrosPendientes, 2); };

  function distanciaDe(v) {
    const aspecto = camara.aspect || 1;
    const vFov = (v.fov * Math.PI) / 180;
    const distAlto = (v.alto / 2) / Math.tan(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspecto);
    const distAncho = (v.ancho / 2) / Math.tan(hFov / 2);
    return Math.max(distAlto, distAncho) * 1.03;
  }

  function posicionDe(v) {
    const c = new THREE.Vector3(...v.centro);
    return c.clone().setZ(c.z + distanciaDe(v));
  }

  function irAVista(nombre, instantaneo) {
    const v = VISTAS[nombre] || VISTAS.cara;
    vistaActual = VISTAS[nombre] ? nombre : "cara";
    const destino = posicionDe(v);
    const mira = new THREE.Vector3(...v.centro);
    if (instantaneo) {
      camara.position.copy(destino);
      objetivo.copy(mira);
      camara.fov = v.fov;
      camara.updateProjectionMatrix();
      camara.lookAt(objetivo);
      vuelo = null;
      repintar();
      return;
    }
    vuelo = {
      inicio: performance.now(), duracion: 1100,
      desdePos: camara.position.clone(), haciaPos: destino,
      desdeMira: objetivo.clone(), haciaMira: mira,
      desdeFov: camara.fov, haciaFov: v.fov,
    };
  }

  const suavizar = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function actualizarVuelo() {
    if (!vuelo) return;
    const t = Math.min((performance.now() - vuelo.inicio) / vuelo.duracion, 1);
    const k = suavizar(t);
    camara.position.lerpVectors(vuelo.desdePos, vuelo.haciaPos, k);
    objetivo.lerpVectors(vuelo.desdeMira, vuelo.haciaMira, k);
    camara.fov = vuelo.desdeFov + (vuelo.haciaFov - vuelo.desdeFov) * k;
    camara.updateProjectionMatrix();
    camara.lookAt(objetivo);
    if (t >= 1) vuelo = null;
  }

  /* ---------- estado clínico -> aspecto del modelo ---------- */
  function aplicarEstado(visual, maniobras) {
    if (!visual) return;
    uniformes.uCianosis.value = visual.cianosis || 0;
    uniformes.uPiel.value = visual.piel || 0;
    mmObjetivo = visual.pupila_mm || 4;
    // Las maniobras las hace el estudiante desde el control, no el escenario.
    bocaObjetivo = maniobras && maniobras.boca ? 1 : 0;
    lenguaObjetivo = maniobras && maniobras.lengua ? 1 : 0;
    const sudor = visual.sudor || 0;
    if (modelo && modelo.materialPiel) modelo.materialPiel.roughness = 0.72 - sudor * 0.45;
    if (modelo) for (const g of modelo.gotas) g.material.opacity = sudor * 0.62;
    repintar();
  }

  function ajustarTamano() {
    const w = contenedor.clientWidth, h = contenedor.clientHeight;
    if (!w || !h) return;
    render.setSize(w, h, false);
    camara.aspect = w / h;
    camara.updateProjectionMatrix();
    // Al cambiar la forma del panel hay que rehacer el encuadre de la vista.
    if (!vuelo) irAVista(vistaActual, true);
    repintar();
  }
  new ResizeObserver(ajustarTamano).observe(contenedor);
  ajustarTamano();

  /* Las transiciones van por TIEMPO, no por cuadro. En un computador lento (o
   * con tarjeta gráfica por software) el bucle corre a dos o tres cuadros por
   * segundo, y una interpolación por cuadro dejaba la boca a medio abrir y la
   * pupila a medio camino para siempre. */
  const acercar = (actual, objetivo, segundos, dt) =>
    actual + (objetivo - actual) * (1 - Math.exp(-dt / segundos));

  let ultimo = performance.now();
  function bucle(ahora) {
    requestAnimationFrame(bucle);
    const dtCrudo = (ahora - ultimo) / 1000;
    ultimo = ahora;
    const dt = Math.min(0.5, dtCrudo);          // para las transiciones
    const dtGota = Math.min(0.05, dtCrudo);     // para que las gotas no salten
    if (vuelo) { actualizarVuelo(); repintar(); }
    // La pupila se mueve suave, como una reacción pupilar, en vez de saltar.
    if (Math.abs(mmObjetivo - mmActual) > 0.005) {
      mmActual = acercar(mmActual, mmObjetivo, 0.35, dt);
      aplicarPupila(mmActual);
      repintar();
    }
    // La boca abre y cierra despacio: el salto seco se ve a tirones.
    if (Math.abs(bocaObjetivo - bocaActual) > 0.002) {
      bocaActual = acercar(bocaActual, bocaObjetivo, 0.30, dt);
      aplicarBoca(bocaActual);
      repintar();
    }
    // La lengua va un poco más lenta: primero se abre la boca, después sale.
    if (Math.abs(lenguaObjetivo - lenguaActual) > 0.002) {
      lenguaActual = acercar(lenguaActual, lenguaObjetivo, 0.40, dt);
      aplicarLengua(lenguaActual);
      repintar();
    }
    // Las gotas resbalan despacio y vuelven a empezar.
    if (modelo) {
      for (const g of modelo.gotas) {
        if (g.material.opacity > 0.02) {
          g.position.y -= dtGota * 0.0035;
          if (g.position.y < g.userData.yInicial - 0.014) g.position.y = g.userData.yInicial;
          repintar();
        }
      }
    }
    if (cargado && cuadrosPendientes > 0) {
      cuadrosPendientes -= 1;
      render.render(escena, camara);
    }
  }
  requestAnimationFrame(bucle);

  return { irAVista, aplicarEstado, ajustarTamano };
}
