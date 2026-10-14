/* SimClin — visor 3D de la cabeza del paciente
 * ------------------------------------------------------------------
 * Modelo: static/modelo.glb, la cabeza esculpida que entregó el diseñador,
 * con los dos ojos ya montados en las órbitas y los párpados abiertos.
 * Trae tres nodos con nombre: "Head", "Eye" y "Eye_2".
 *
 * Lo que pone la app encima del modelo:
 *   - Cianosis alrededor de la boca y palidez en toda la cara, con un shader
 *     que respeta la textura y el mapa de normales de la escultura.
 *   - Sudoración: la piel se vuelve brillante y aparecen gotas pegadas a la
 *     frente y las mejillas, colocadas lanzando rayos contra la malla.
 *   - La PUPILA, que no viene en el modelo y así debe ser: su diámetro sale
 *     del valor en milímetros del escenario, no de escalar una malla a ojo.
 *   - Una ventana en la córnea para que se vea el iris (el globo y la córnea
 *     son una sola malla cerrada; sin esto la córnea tapa el iris).
 *
 * Todas las medidas de abajo están tomadas sobre ESTE modelo, en coordenadas
 * de mundo, con la cara mirando hacia +Z. Si llega un modelo nuevo hay que
 * volver a medirlas.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const PALIDEZ = new THREE.Color(0xd9cec7);
const CIANOSIS = new THREE.Color(0x5f5a8a);
const COLOR_IRIS = new THREE.Color(0x6b4a2f);
const COLOR_ESCLERA = new THREE.Color(0xf2efe9);

// Centro de la boca y radio de la zona que se tiñe de cianosis.
const BOCA = new THREE.Vector3(0, 0.196, 0.142);
const RADIO_BOCA = 0.021;

// Del ojo: el iris mira a +Y DENTRO del nodo (el nodo trae su propia rotación
// de 90°). Un globo mide 2 unidades locales y se toma como 24 mm.
const Z_IRIS = 0.8215;
const HUECO_R = 0.50;
const HUECO_Y = 0.45;
const MM_POR_UNIDAD = 12;

/* Cada vista dice QUÉ zona hay que ver, no dónde poner la cámara: la
 * distancia se calcula con la forma que tenga el panel en ese momento. Así el
 * encuadre sigue siendo correcto cuando se esconden los signos vitales y la
 * caja pasa de 820 a 1500 px de ancho. */
export const VISTAS = {
  cara:   { centro: [0, 0.255, 0.090], ancho: 0.300, alto: 0.285, fov: 36 },
  labios: { centro: [0, 0.196, 0.130], ancho: 0.115, alto: 0.078, fov: 24 },
  ojos:   { centro: [0, 0.264, 0.105], ancho: 0.165, alto: 0.078, fov: 20 },
};

/* El modelo pesa 4,5 MB con sus texturas de 2048. Cada vez que se vuelve a
 * abrir "Cabeza y Cuello" se creaba un visor nuevo y el archivo se volvía a
 * descargar, decodificar y subir a la tarjeta gráfica, con su "CARGANDO
 * MODELO" de varios segundos en pantalla. Se guarda una sola copia y las
 * siguientes veces se clona: las geometrías y las texturas se comparten. */
let promesaModelo = null;
function cargarModelo() {
  if (!promesaModelo) {
    promesaModelo = new Promise((ok, falla) => {
      new GLTFLoader().load("/static/modelo.glb", (gltf) => ok(gltf.scene), undefined, falla);
    });
    promesaModelo.catch(() => { promesaModelo = null; });   // deja reintentar
  }
  return promesaModelo;
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

  let gotas = [];
  let cargado = false;
  let materialPiel = null;
  const pupilas = [];
  let mmObjetivo = 4, mmActual = 4;

  const uniformes = {
    uBoca: { value: BOCA.clone() },
    uRadio: { value: RADIO_BOCA },
    uCianosis: { value: 0 },
    uPalidez: { value: 0 },
    uColorCianosis: { value: CIANOSIS.clone() },
    uColorPalidez: { value: PALIDEZ.clone() },
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
          uniform vec3 uBoca; uniform float uRadio;
          uniform float uCianosis; uniform float uPalidez;
          uniform vec3 uColorCianosis; uniform vec3 uColorPalidez;`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          float d = distance(vMundo, uBoca);
          float mascara = 1.0 - smoothstep(uRadio * 0.55, uRadio * 1.15, d);
          vec3 piel = mix(diffuseColor.rgb, uColorPalidez, uPalidez * 0.65);
          piel = mix(piel, uColorCianosis, clamp(uCianosis, 0.0, 1.0) * (0.03 + 0.82 * mascara));
          diffuseColor.rgb = piel;`);
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

  function prepararOjo(nodo) {
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

  function aplicarPupila(mm) {
    const r = (Math.min(Math.max(mm, 0.8), 9) / 2) / MM_POR_UNIDAD;
    for (const p of pupilas) p.scale.set(r, r, 1);
  }

  cargarModelo().then(
    (original) => {
      const raiz = original.clone(true);
      raiz.updateMatrixWorld(true);
      escena.add(raiz);

      for (const nodo of raiz.children.slice()) {
        if (/^Eye/i.test(nodo.name)) {
          prepararOjo(nodo);
        } else {
          nodo.traverse((o) => {
            if (!o.isMesh || !o.material) return;
            o.material = o.material.clone();   // conserva textura y normales
            materialPiel = o.material;
            pintarPiel(o.material);
          });
        }
      }

      aplicarPupila(mmActual);
      crearGotas(raiz);
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

  // Gotas de sudor: esferitas pegadas a la frente y las mejillas. Se colocan
  // lanzando rayos de frente contra la malla para que queden sobre la piel.
  function crearGotas(raiz) {
    const rc = new THREE.Raycaster();
    const geo = new THREE.SphereGeometry(1, 12, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xeaf6ff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0,
    });
    // (x, y) en coordenadas de mundo; se evita la zona de los ojos.
    const puntos = [
      [0, 0.350], [-0.042, 0.337], [0.042, 0.339], [0, 0.318],
      [-0.068, 0.308], [0.068, 0.304], [-0.024, 0.300], [0.026, 0.302],
      [-0.070, 0.272], [0.070, 0.268], [-0.064, 0.240], [0.066, 0.236],
      [-0.050, 0.212], [0.052, 0.208],
    ];
    for (const [x, y] of puntos) {
      rc.set(new THREE.Vector3(x, y, 0.6), new THREE.Vector3(0, 0, -1));
      const hit = rc.intersectObject(raiz, true)[0];
      if (!hit) continue;
      // Si el rayo pegó en un borde muy inclinado (oreja, contorno de la cara)
      // la gota se vería flotando fuera de la silueta, así que se descarta.
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal.z < 0.3) continue;
      const g = new THREE.Mesh(geo, mat.clone());
      const escala = 0.0022 + Math.random() * 0.0016;
      g.scale.setScalar(escala);
      g.position.copy(hit.point).addScaledVector(normal, escala * 0.55);
      g.userData = { yInicial: g.position.y, fase: Math.random() * 3 };
      escena.add(g);
      gotas.push(g);
    }
  }

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
    const sudor = visual.sudor || 0;
    if (materialPiel) materialPiel.roughness = 1 - sudor * 0.55;  // piel brillante = sudorosa
    for (const g of gotas) g.material.opacity = sudor * 0.45;
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

  let ultimo = performance.now();
  function bucle(ahora) {
    requestAnimationFrame(bucle);
    const dt = Math.min(0.05, (ahora - ultimo) / 1000);
    ultimo = ahora;
    if (vuelo) { actualizarVuelo(); repintar(); }
    // La pupila se mueve suave, como una reacción pupilar, en vez de saltar.
    if (Math.abs(mmObjetivo - mmActual) > 0.005) {
      mmActual += (mmObjetivo - mmActual) * 0.08;
      aplicarPupila(mmActual);
      repintar();
    }
    // Las gotas resbalan despacio y vuelven a empezar.
    for (const g of gotas) {
      if (g.material.opacity > 0.02) {
        g.position.y -= dt * 0.008;
        if (g.position.y < g.userData.yInicial - 0.035) g.position.y = g.userData.yInicial;
        repintar();
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
