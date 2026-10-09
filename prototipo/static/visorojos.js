/* SimClin — visor 3D de los ojos
 * ------------------------------------------------------------------
 * Reemplaza el esquema 2D que se usaba en la vista "Ojos / pupilas".
 *
 * El modelo que entregó el diseñador (static/ojo.glb) trae una sola malla con
 * DOS materiales: "Eye" (esclerótica + córnea) e "Iris". No trae pupila, y eso
 * está bien: la pupila la dibujamos nosotros, porque así su diámetro sale
 * directo del dato clínico del escenario. Dos milímetros son dos milímetros,
 * no "una malla escalada a ojo".
 *
 * Dos defectos del archivo se compensan acá y no bloquean nada:
 *   - el material "Eye" venía con transparencia (alpha BLEND) siendo opaco,
 *     lo que produce errores de orden de dibujo -> se fuerza opaco.
 *   - una franja del globo quedó con sombreado plano y se ve facetada como un
 *     engranaje -> se recalculan las normales soldando vértices.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// El globo del modelo mide 2 unidades de diámetro y un ojo humano mide unos
// 24 mm, así que 1 unidad = 12 mm. De ahí sale el radio de la pupila.
const MM_POR_UNIDAD = 12;
const Z_IRIS = 0.8215;          // cara frontal del iris, medida sobre el modelo
const SEPARACION = 2.22;        // distancia entre los dos ojos
const PUPILA_MIN_MM = 0.8;
const PUPILA_MAX_MM = 9.0;

const COLOR_IRIS = new THREE.Color(0x6b4a2f);
const COLOR_ESCLERA = new THREE.Color(0xf2efe9);
const COLOR_PUPILA = new THREE.Color(0x07090c);

/* El globo y la córnea son UNA sola malla cerrada, así que la cúpula de la
 * córnea queda por delante del iris y lo tapa. El diseñador lo resolvió
 * poniendo el material en transparente, pero eso en tiempo real trae problemas
 * de orden de dibujo (es lo que producía el borde festoneado).
 *
 * En vez de transparencia, se descarta en el shader el casquete frontal: queda
 * una ventana por donde se ve el iris, con el borde justo en el limbo. Sin
 * mezcla alfa no hay nada que ordenar y se ve limpio.
 * El radio del hueco es un poco menor que el del iris (0,556) para que no
 * aparezca una rendija entre el borde del hueco y el borde del iris.
 */
const HUECO_R = 0.50;
const HUECO_Y = 0.45;

function abrirCornea(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLocalOjo;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocalOjo = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLocalOjo;")
      .replace(
        "#include <clipping_planes_fragment>",
        `if (vLocalOjo.y > ${HUECO_Y.toFixed(3)} && length(vLocalOjo.xz) < ${HUECO_R.toFixed(3)}) discard;
         #include <clipping_planes_fragment>`
      );
  };
}

export function crearVisorOjos(contenedor) {
  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const render = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  render.setPixelRatio(Math.min(devicePixelRatio, 2));
  render.outputColorSpace = THREE.SRGBColorSpace;
  contenedor.appendChild(render.domElement);
  Object.assign(render.domElement.style, { width: "100%", height: "100%", display: "block" });

  escena.add(new THREE.AmbientLight(0xcfe0ff, 0.75));
  const principal = new THREE.DirectionalLight(0xffffff, 2.1);
  principal.position.set(1.2, 1.7, 2.6);
  escena.add(principal);
  const relleno = new THREE.DirectionalLight(0xa8c4ff, 0.7);
  relleno.position.set(-2.2, 0.4, 1.4);
  escena.add(relleno);

  const pupilas = [];
  const grupos = [];
  let cargado = false;
  let mmObjetivo = 4, mmActual = 4;

  const geoPupila = new THREE.CircleGeometry(1, 64);
  const geoBrillo = new THREE.CircleGeometry(0.075, 24);

  new GLTFLoader().load(
    "/static/ojo.glb",
    (gltf) => {
      const base = gltf.scene;
      base.updateMatrixWorld(true);

      base.traverse((o) => {
        if (!o.isMesh) return;
        // Soldar vértices y recalcular normales quita el festón de facetas.
        // Las UV se borran antes de soldar: el modelo no trae texturas y, si se
        // dejan, los vértices de la costura no se sueldan y queda una línea
        // horizontal cruzando el globo.
        try {
          o.geometry.deleteAttribute("uv");
          o.geometry.deleteAttribute("uv1");
          o.geometry = mergeVertices(o.geometry, 1e-4);
          o.geometry.computeVertexNormals();
        } catch (err) {
          // si falla el soldado, el ojo igual se ve; solo queda más facetado
        }
        const esIris = o.material && o.material.name === "Iris";
        const mat = new THREE.MeshStandardMaterial({
          color: esIris ? COLOR_IRIS : COLOR_ESCLERA,
          roughness: esIris ? 0.45 : 0.24,
          metalness: 0,
          transparent: false,       // el archivo venía en alpha BLEND
          depthWrite: true,
          side: THREE.FrontSide,
        });
        if (!esIris) abrirCornea(mat);
        o.material = mat;
      });

      for (const signo of [-1, 1]) {
        const ojo = signo < 0 ? base : base.clone(true);
        const grupo = new THREE.Group();
        grupo.add(ojo);
        grupo.position.x = signo * (SEPARACION / 2);

        const pupila = new THREE.Mesh(geoPupila, new THREE.MeshBasicMaterial({ color: COLOR_PUPILA }));
        pupila.position.set(0, 0, Z_IRIS + 0.004);
        grupo.add(pupila);
        pupilas.push(pupila);

        const brillo = new THREE.Mesh(geoBrillo, new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.9,
        }));
        brillo.position.set(-0.19, 0.2, Z_IRIS + 0.03);
        grupo.add(brillo);

        escena.add(grupo);
        grupos.push(grupo);
      }

      aplicarPupila(mmActual);
      cargado = true;
      contenedor.dataset.estado = "listo";
      ajustarTamano();   // encuadra y orienta los dos ojos hacia la cámara
    },
    undefined,
    (err) => {
      contenedor.dataset.estado = "error";
      console.error("No se pudo cargar el modelo del ojo:", err);
    }
  );

  function aplicarPupila(mm) {
    const r = (Math.min(Math.max(mm, PUPILA_MIN_MM), PUPILA_MAX_MM) / 2) / MM_POR_UNIDAD;
    for (const p of pupilas) p.scale.set(r, r, 1);
  }

  // La cámara se aleja lo necesario para que los dos ojos quepan de ancho,
  // sea cual sea la forma de la caja (el panel del monitor es vertical).
  function encuadrar() {
    const anchoEscena = SEPARACION + 2.12;
    const altoEscena = 2.2;
    const aspecto = camara.aspect || 1;
    const vFov = (camara.fov * Math.PI) / 180;
    const distAlto = (altoEscena / 2) / Math.tan(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspecto);
    const distAncho = (anchoEscena / 2) / Math.tan(hFov / 2);
    camara.position.set(0, 0, Math.max(distAlto, distAncho) * 1.01);
    camara.lookAt(0, 0, 0);
    // Cada ojo mira a la cámara: así los dos se ven de frente y simétricos, en
    // vez de quedar el de un lado "mirando" hacia afuera por la perspectiva.
    for (const g of grupos) g.lookAt(camara.position);
  }

  function aplicarEstado(visual) {
    if (!visual) return;
    mmObjetivo = visual.pupila_mm || 4;
  }

  function ajustarTamano() {
    const w = contenedor.clientWidth, h = contenedor.clientHeight;
    if (!w || !h) return;
    render.setSize(w, h, false);
    camara.aspect = w / h;
    camara.updateProjectionMatrix();
    encuadrar();
  }
  new ResizeObserver(ajustarTamano).observe(contenedor);
  ajustarTamano();

  function bucle() {
    requestAnimationFrame(bucle);
    if (!cargado) return;
    // La pupila se mueve suave, como una reacción pupilar, en vez de saltar.
    if (Math.abs(mmObjetivo - mmActual) > 0.005) {
      mmActual += (mmObjetivo - mmActual) * 0.08;
      aplicarPupila(mmActual);
    }
    render.render(escena, camara);
  }
  requestAnimationFrame(bucle);

  return { aplicarEstado, ajustarTamano, escena, camara, get mm() { return mmActual; } };
}
