/* SimClin — visor 3D de la cabeza del paciente
 * ------------------------------------------------------------------
 * Usa el modelo y la idea de "volar la cámara hasta el ojo" del repo de Juan
 * (Taller7: index.html + main.js con Three.js, OrbitControls y GLTFLoader).
 * Cambios respecto a ese prototipo:
 *   - Three.js se carga desde la carpeta vendor/ y no desde unpkg, para que
 *     funcione sin internet en el salón.
 *   - El modelo no se muestra gris: se le aplica un material de piel que
 *     cambia con el estado del paciente (palidez, cianosis peribucal,
 *     sudoración), calculado a partir de los datos del servidor.
 *   - Las vistas de cámara se eligen desde el celular, no con botones fijos.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const PIEL = new THREE.Color(0xd6a585);
const PALIDEZ = new THREE.Color(0xd9cec7);
const CIANOSIS = new THREE.Color(0x5b5ea6);

// Puntos de referencia medidos sobre el modelo (la cara mira hacia +X).
const BOCA = new THREE.Vector3(0.245, 0.0, 0.0);

export const VISTAS = {
  // Distancias calculadas para que quepa la zona de interés con fov 38°.
  cara:   { pos: [1.30, 0.13, 0.02], mira: [0.02, 0.12, 0.00] },
  labios: { pos: [0.60, 0.06, 0.11], mira: [0.24, 0.00, 0.00] },
  ojos:   { pos: [0.78, 0.25, 0.02], mira: [0.22, 0.20, 0.02] },
};

export function crearVisor(contenedor) {
  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
  const render = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  render.setPixelRatio(Math.min(devicePixelRatio, 2));
  contenedor.appendChild(render.domElement);
  render.domElement.style.width = "100%";
  render.domElement.style.height = "100%";
  render.domElement.style.display = "block";

  escena.add(new THREE.AmbientLight(0xbfd6ff, 0.55));
  const principal = new THREE.DirectionalLight(0xffffff, 1.25);
  principal.position.set(3, 2.4, 2);
  escena.add(principal);
  const relleno = new THREE.DirectionalLight(0x7fb0ff, 0.5);
  relleno.position.set(-2, 0.5, -1.5);
  escena.add(relleno);

  let gotas = [];
  let cargado = false;
  const uniformes = {
    uBoca: { value: BOCA.clone() },
    uRadio: { value: 0.105 },
    uCianosis: { value: 0 },
    uPalidez: { value: 0 },
    uColorCianosis: { value: CIANOSIS.clone() },
    uColorPalidez: { value: PALIDEZ.clone() },
  };

  // Material de piel: tiñe los labios (zona alrededor de la boca) según la
  // cianosis, y toda la cara según la palidez. Así se puede mostrar el signo
  // clínico sin que el modelo tenga los labios separados como malla aparte.
  const material = new THREE.MeshStandardMaterial({ color: PIEL, roughness: 0.62, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniformes);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPosM;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPosM = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vPosM;
         uniform vec3 uBoca; uniform float uRadio;
         uniform float uCianosis; uniform float uPalidez;
         uniform vec3 uColorCianosis; uniform vec3 uColorPalidez;`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         float d = distance(vPosM, uBoca);
         float mascara = 1.0 - smoothstep(uRadio * 0.45, uRadio * 1.35, d);
         vec3 piel = mix(diffuseColor.rgb, uColorPalidez, uPalidez * 0.7);
         piel = mix(piel, uColorCianosis, clamp(uCianosis, 0.0, 1.0) * (0.12 + 0.88 * mascara));
         diffuseColor.rgb = piel;`
      );
  };

  new GLTFLoader().load(
    "/static/modelo.glb",
    (gltf) => {
      gltf.scene.traverse((o) => { if (o.isMesh) o.material = material; });
      escena.add(gltf.scene);
      crearGotas(gltf.scene);
      cargado = true;
      contenedor.dataset.estado = "listo";
    },
    undefined,
    (err) => {
      contenedor.dataset.estado = "error";
      console.error("No se pudo cargar el modelo 3D:", err);
    }
  );

  // Gotas de sudor: esferitas pegadas a la frente y las mejillas. Se colocan
  // lanzando rayos contra la malla para que queden sobre la piel.
  function crearGotas(raiz) {
    const rc = new THREE.Raycaster();
    const geo = new THREE.SphereGeometry(1, 12, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xdff0ff, roughness: 0.08, metalness: 0, transparent: true, opacity: 0,
    });
    const puntos = [
      [0.33, 0.09], [0.30, -0.06], [0.355, 0.0], [0.26, 0.13],
      [0.24, -0.14], [0.12, 0.16], [0.10, -0.17], [0.05, 0.12],
      [0.04, -0.13], [-0.03, 0.10], [-0.06, -0.08], [-0.10, 0.04],
    ];
    for (const [y, z] of puntos) {
      rc.set(new THREE.Vector3(1.5, y, z), new THREE.Vector3(-1, 0, 0));
      const hit = rc.intersectObject(raiz, true)[0];
      if (!hit) continue;
      const g = new THREE.Mesh(geo, mat.clone());
      const escala = 0.006 + Math.random() * 0.004;
      g.scale.setScalar(escala);
      g.position.copy(hit.point).addScaledVector(hit.face.normal, escala * 0.55);
      g.userData = { yInicial: g.position.y, fase: Math.random() * 3 };
      escena.add(g);
      gotas.push(g);
    }
  }

  // --- animación de cámara (misma idea del botón "ojo" del repo original) ---
  let vuelo = null;
  const objetivo = new THREE.Vector3(0.02, 0.12, 0);
  camara.position.set(...VISTAS.cara.pos);
  camara.lookAt(objetivo);

  function irAVista(nombre, instantaneo) {
    const v = VISTAS[nombre] || VISTAS.cara;
    const destino = new THREE.Vector3(...v.pos);
    const mira = new THREE.Vector3(...v.mira);
    if (instantaneo) {
      camara.position.copy(destino);
      objetivo.copy(mira);
      camara.lookAt(objetivo);
      vuelo = null;
      return;
    }
    vuelo = {
      inicio: performance.now(), duracion: 1100,
      desdePos: camara.position.clone(), haciaPos: destino,
      desdeMira: objetivo.clone(), haciaMira: mira,
    };
  }

  const suavizar = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function actualizarVuelo() {
    if (!vuelo) return;
    const t = Math.min((performance.now() - vuelo.inicio) / vuelo.duracion, 1);
    const k = suavizar(t);
    camara.position.lerpVectors(vuelo.desdePos, vuelo.haciaPos, k);
    objetivo.lerpVectors(vuelo.desdeMira, vuelo.haciaMira, k);
    camara.lookAt(objetivo);
    if (t >= 1) vuelo = null;
  }

  // --- estado clínico -> aspecto del modelo ---
  function aplicarEstado(visual) {
    if (!visual) return;
    uniformes.uCianosis.value = visual.cianosis || 0;
    uniformes.uPalidez.value = visual.palidez || 0;
    const sudor = visual.sudor || 0;
    material.roughness = 0.62 - sudor * 0.30;   // piel más brillante = sudorosa
    for (const g of gotas) g.material.opacity = sudor * 0.85;
  }

  function ajustarTamano() {
    const w = contenedor.clientWidth, h = contenedor.clientHeight;
    if (!w || !h) return;
    render.setSize(w, h, false);
    camara.aspect = w / h;
    camara.updateProjectionMatrix();
  }
  new ResizeObserver(ajustarTamano).observe(contenedor);
  ajustarTamano();

  let ultimo = performance.now();
  function bucle(ahora) {
    requestAnimationFrame(bucle);
    const dt = Math.min(0.05, (ahora - ultimo) / 1000);
    ultimo = ahora;
    actualizarVuelo();
    // las gotas resbalan despacio y vuelven a empezar
    for (const g of gotas) {
      if (g.material.opacity > 0.02) {
        g.position.y -= dt * 0.012;
        if (g.position.y < g.userData.yInicial - 0.05) g.position.y = g.userData.yInicial;
      }
    }
    if (cargado) render.render(escena, camara);
  }
  requestAnimationFrame(bucle);

  return { irAVista, aplicarEstado, ajustarTamano };
}
