/* SimClin — visor 3D del paciente
 * ------------------------------------------------------------------
 * Modelo: static/modelo.glb, el busto que entregó el diseñador (cabeza, cuello
 * y hombros), con los dos ojos montados en las órbitas, los párpados abiertos
 * y la boca completa por dentro: mandíbula, dentadura, faringe y LENGUA.
 *
 * Nodos que importan:
 *   "Eye" y "Eye001"        los dos ojos, cada uno con su material de iris
 *   "grp_blendShapes_01"    la cabeza, con el morph "jawOpen"
 *   "Human_-_Denture"       la boca por dentro, con su esqueleto de huesos
 *
 * Lo que pone la app encima del modelo:
 *   - Cianosis alrededor de la boca y palidez en toda la cara, con un shader
 *     que respeta la textura y el mapa de normales de la escultura.
 *   - Cianosis CENTRAL en la lengua, que es donde se valora de verdad. Por eso
 *     la lengua se tiñe más y sin depender de la distancia a la boca.
 *   - Sudoración: la piel se vuelve brillante y aparecen gotas pegadas a la
 *     frente y las mejillas, colocadas lanzando rayos contra la malla.
 *   - La PUPILA, que no viene en el modelo y así debe ser: su diámetro sale
 *     del valor en milímetros del escenario, no de escalar una malla a ojo.
 *   - Una ventana en la córnea para que se vea el iris (el globo y la córnea
 *     son una sola malla cerrada; sin esto la córnea tapa el iris).
 *   - La apertura de la boca: el morph abre los labios y, a la vez, se rota el
 *     hueso de la mandíbula, porque la dentadura es un objeto aparte y con el
 *     morph solo se vería una boca abierta con los dientes apretados.
 *
 * Todas las medidas de abajo están tomadas sobre ESTE modelo, en coordenadas
 * de mundo, con la cara mirando hacia +Z. Si llega un modelo nuevo hay que
 * volver a medirlas.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const PALIDEZ = new THREE.Color(0xd9cec7);
const CIANOSIS = new THREE.Color(0x5f5a8a);
const CIANOSIS_LENGUA = new THREE.Color(0x6b5f93);
const COLOR_IRIS = new THREE.Color(0x6b4a2f);
const COLOR_ESCLERA = new THREE.Color(0xf2efe9);

// Centro de la boca y radio de la zona que se tiñe de cianosis. Los labios son
// una elipse ancha y baja, así que la máscara aplasta el eje X: con una esfera
// el morado se subía al bigote y bajaba a la barbilla.
const BOCA = new THREE.Vector3(0, -0.034, 0.051);
const RADIO_BOCA = 0.018;
const ACHATADO_BOCA = 0.5;

// Del ojo: el iris mira a +Y DENTRO del nodo (el nodo trae su propia rotación
// de 90°). El tamaño en milímetros de una unidad local se saca de la escala
// del nodo, así no hay que recalibrarlo si el diseñador reexporta a otra
// escala: 1 unidad local = escala del nodo en metros.
const Z_IRIS = 0.8215;
const HUECO_R = 0.50;
const HUECO_Y = 0.45;

// Con la boca del todo abierta: cuánto baja la mandíbula y cuánto sube la
// lengua. Sin levantar la lengua queda hundida en el piso de la boca y no se
// alcanza a ver, que es justo lo que hay que mirar.
const GRADOS_MANDIBULA = 24;
const GRADOS_LENGUA = 18;

/* Cada vista dice QUÉ zona hay que ver, no dónde poner la cámara: la
 * distancia se calcula con la forma que tenga el panel en ese momento. Así el
 * encuadre sigue siendo correcto cuando se esconden los signos vitales y la
 * caja pasa de 820 a 1500 px de ancho. */
export const VISTAS = {
  cara:   { centro: [0, 0.025, 0.030], ancho: 0.205, alto: 0.250, fov: 36 },
  labios: { centro: [0, -0.038, 0.048], ancho: 0.092, alto: 0.064, fov: 24 },
  ojos:   { centro: [0, 0.043, 0.032], ancho: 0.130, alto: 0.060, fov: 20 },
};

/* El modelo se prepara UNA sola vez y se reutiliza. No se clona: clonar una
 * malla con esqueleto deja los huesos apuntando al original y la mandíbula
 * dejaría de moverse. Como el televisor solo muestra un visor a la vez, al
 * agregarlo a la escena nueva Three.js lo saca sola de la anterior. */
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
  uPalidez: { value: 0 },
  uColorCianosis: { value: CIANOSIS.clone() },
  uColorPalidez: { value: PALIDEZ.clone() },
};
const uniformesLengua = {
  uCianosis: uniformes.uCianosis,
  uColorCianosis: { value: CIANOSIS_LENGUA.clone() },
};

/* Tiñe la piel SIN perder la textura ni el relieve de la escultura: se
 * engancha al material que trae el modelo en vez de reemplazarlo. La
 * cianosis se concentra alrededor de la boca; la palidez cubre toda la cara.
 * Se usa la posición en coordenadas de mundo, así que no importa cómo esté
 * escalado o rotado el nodo de la cabeza. */
function pintarPiel(material) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniformes);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMundo;")
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\nvMundo = (modelMatrix * vec4(position, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vMundo;
        uniform vec3 uBoca; uniform float uRadio; uniform float uAchatado;
        uniform float uCianosis; uniform float uPalidez;
        uniform vec3 uColorCianosis; uniform vec3 uColorPalidez;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 rel = vMundo - uBoca;
        rel.x *= uAchatado;
        float d = length(rel);
        float mascara = 1.0 - smoothstep(uRadio * 0.55, uRadio * 1.15, d);
        vec3 piel = mix(diffuseColor.rgb, uColorPalidez, uPalidez * 0.65);
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

/* El globo y la córnea son una sola malla cerrada, así que la cúpula de la
 * córnea queda por delante del iris y lo taparía. En vez de transparencia
 * (que trae problemas de orden de dibujo) se descarta el casquete frontal:
 * queda una ventana con el borde justo en el limbo. */
function abrirCornea(material) {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLocalOjo;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocalOjo = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLocalOjo;")
      .replace("#include <clipping_planes_fragment>",
        `if (vLocalOjo.y > ${HUECO_Y.toFixed(3)} && length(vLocalOjo.xz) < ${HUECO_R.toFixed(3)}) discard;
         #include <clipping_planes_fragment>`);
  };
  material.needsUpdate = true;
}

function prepararOjo(nodo, pupilas) {
  nodo.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const esIris = (o.material.name || "").startsWith("Iris");
    const mat = new THREE.MeshStandardMaterial({
      color: esIris ? COLOR_IRIS : COLOR_ESCLERA,
      roughness: esIris ? 0.45 : 0.24,
      metalness: 0,
      side: THREE.FrontSide,
    });
    if (!esIris) abrirCornea(mat);
    o.material = mat;
  });

  // Dentro del nodo del ojo el iris mira hacia +Y, no hacia +Z.
  const pupila = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0x07090c })
  );
  pupila.position.set(0, Z_IRIS + 0.004, 0);
  pupila.rotation.x = -Math.PI / 2;
  nodo.add(pupila);
  pupilas.push(pupila);

  const brillo = new THREE.Mesh(
    new THREE.CircleGeometry(0.085, 20),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
  );
  brillo.position.set(-0.21, Z_IRIS + 0.03, -0.21);
  brillo.rotation.x = -Math.PI / 2;
  nodo.add(brillo);
}

/* Gotas de sudor: esferitas pegadas a la frente, las sienes y las mejillas. Se
 * colocan lanzando rayos de frente contra la malla para que queden sobre la
 * piel de este modelo y no en el aire. */
function crearGotas(raiz, cabeza) {
  const rc = new THREE.Raycaster();
  const geo = new THREE.SphereGeometry(1, 12, 10);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xeaf6ff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0,
  });
  // (x, y) en coordenadas de mundo; se evita la zona de los ojos.
  const puntos = [
    [0, 0.112], [-0.030, 0.100], [0.032, 0.102], [0, 0.082],
    [-0.048, 0.086], [0.048, 0.084], [-0.022, 0.066], [0.024, 0.068],
    [-0.058, 0.028], [0.058, 0.025], [-0.050, 0.002], [0.050, 0.000],
    [-0.044, -0.020], [0.044, -0.018],
  ];
  const gotas = [];
  for (const [x, y] of puntos) {
    rc.set(new THREE.Vector3(x, y, 0.6), new THREE.Vector3(0, 0, -1));
    const hit = rc.intersectObject(cabeza, true)[0];
    if (!hit) continue;
    // Si el rayo pegó en un borde muy inclinado (oreja, contorno de la cara)
    // la gota se vería flotando fuera de la silueta, así que se descarta.
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (normal.z < 0.3) continue;
    const g = new THREE.Mesh(geo, mat.clone());
    const escala = 0.0021 + Math.random() * 0.0013;
    g.scale.setScalar(escala);
    g.position.copy(hit.point).addScaledVector(normal, escala * 0.55);
    g.userData = { yInicial: g.position.y };
    raiz.add(g);
    gotas.push(g);
  }
  return gotas;
}

/* Deja el modelo listo una sola vez: materiales, pupilas, gotas, y las
 * referencias que hacen falta para abrir la boca. */
function prepararModelo(raiz) {
  raiz.updateMatrixWorld(true);

  const pupilas = [];
  let materialPiel = null;
  let escalaOjo = 0.01293;
  let cabeza = null;
  const morphs = [];

  for (const nodo of raiz.children.slice()) {
    if (/^Eye/i.test(nodo.name)) {
      const e = new THREE.Vector3();
      nodo.getWorldScale(e);
      escalaOjo = e.x;
      prepararOjo(nodo, pupilas);
      continue;
    }
    nodo.traverse((o) => {
      if (o.morphTargetDictionary && "jawOpen" in o.morphTargetDictionary) {
        morphs.push({ malla: o, indice: o.morphTargetDictionary.jawOpen });
      }
      if (!o.isMesh && !o.isSkinnedMesh) return;
      if (!o.material) return;
      const nombre = o.material.name || "";
      o.material = o.material.clone();        // conserva textura y normales
      if (nombre === "Lengua") {
        pintarLengua(o.material);
      } else if (!/^(Lower|Upper|Throat)$/.test(nombre)) {
        materialPiel = o.material;            // la piel de la cara
        cabeza = o;
        pintarPiel(o.material);
      }
    });
  }

  const mandibula = raiz.getObjectByName("Human_-_Lower_Jaw_1")
                 || raiz.getObjectByName("Human - Lower Jaw");
  const mandibulaBase = mandibula ? mandibula.rotation.x : 0;
  const lengua = raiz.getObjectByName("Human_-_Tongue000")
              || raiz.getObjectByName("Human - Tongue.000");
  const lenguaBase = lengua ? lengua.rotation.x : 0;
  const gotas = cabeza ? crearGotas(raiz, cabeza) : [];

  return {
    raiz, pupilas, gotas, materialPiel, morphs,
    mandibula, mandibulaBase, lengua, lenguaBase,
    // 1 unidad local del ojo medida en milímetros de mundo.
    mmPorUnidad: escalaOjo * 1000,
  };
}

export function crearVisor(contenedor) {
  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(VISTAS.cara.fov, 1, 0.005, 50);
  const render = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  render.setPixelRatio(Math.min(devicePixelRatio, 2));
  render.outputColorSpace = THREE.SRGBColorSpace;
  contenedor.appendChild(render.domElement);
  Object.assign(render.domElement.style, { width: "100%", height: "100%", display: "block" });

  escena.add(new THREE.AmbientLight(0xbfd6ff, 0.60));
  const principal = new THREE.DirectionalLight(0xffffff, 1.9);
  principal.position.set(0.6, 1.0, 1.8);
  escena.add(principal);
  const relleno = new THREE.DirectionalLight(0x7fb0ff, 0.55);
  relleno.position.set(-1.6, 0.3, 1.0);
  escena.add(relleno);
  // Con la boca abierta el interior queda en sombra y la lengua no se ve. Esta
  // luz se enciende sola con la apertura y no toca el resto de la cara.
  const luzBoca = new THREE.PointLight(0xffe9e2, 0, 0.09, 2);
  luzBoca.position.set(0, BOCA.y + 0.004, BOCA.z + 0.012);
  escena.add(luzBoca);

  let modelo = null;
  let cargado = false;
  let mmObjetivo = 4, mmActual = 4;
  let bocaObjetivo = 0, bocaActual = 0;

  function aplicarPupila(mm) {
    if (!modelo) return;
    const r = (Math.min(Math.max(mm, 0.8), 9) / 2) / modelo.mmPorUnidad;
    for (const p of modelo.pupilas) p.scale.set(r, r, 1);
  }

  /* Abrir la boca son dos cosas a la vez: el morph de la cabeza separa los
   * labios, y el hueso de la mandíbula baja la dentadura. Con el morph solo se
   * vería una boca abierta con los dientes apretados. */
  function aplicarBoca(v) {
    if (!modelo) return;
    const k = Math.min(Math.max(v, 0), 1);
    for (const m of modelo.morphs) m.malla.morphTargetInfluences[m.indice] = k;
    if (modelo.mandibula) {
      modelo.mandibula.rotation.x = modelo.mandibulaBase + (k * GRADOS_MANDIBULA * Math.PI) / 180;
    }
    if (modelo.lengua) {
      modelo.lengua.rotation.x = modelo.lenguaBase + (k * GRADOS_LENGUA * Math.PI) / 180;
    }
    luzBoca.intensity = k * 0.004;
  }

  cargarModelo().then(
    (m) => {
      modelo = m;
      escena.add(m.raiz);
      aplicarPupila(mmActual);
      aplicarBoca(bocaActual);
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
  function aplicarEstado(visual) {
    if (!visual) return;
    uniformes.uCianosis.value = visual.cianosis || 0;
    uniformes.uPalidez.value = visual.palidez || 0;
    mmObjetivo = visual.pupila_mm || 4;
    bocaObjetivo = visual.boca || 0;
    const sudor = visual.sudor || 0;
    if (modelo && modelo.materialPiel) modelo.materialPiel.roughness = 1 - sudor * 0.55;
    if (modelo) for (const g of modelo.gotas) g.material.opacity = sudor * 0.45;
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
    // La boca también abre y cierra despacio.
    if (Math.abs(bocaObjetivo - bocaActual) > 0.002) {
      bocaActual = acercar(bocaActual, bocaObjetivo, 0.30, dt);
      aplicarBoca(bocaActual);
      repintar();
    }
    // Las gotas resbalan despacio y vuelven a empezar.
    if (modelo) {
      for (const g of modelo.gotas) {
        if (g.material.opacity > 0.02) {
          g.position.y -= dtGota * 0.006;
          if (g.position.y < g.userData.yInicial - 0.025) g.position.y = g.userData.yInicial;
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
