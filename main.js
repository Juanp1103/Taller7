import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ----------------------------------------------------
// ESCENA, CÁMARA, RENDERER
// ----------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.05,
  1000
);
camera.position.set(3, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// ----------------------------------------------------
// LUCES
// ----------------------------------------------------
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

// ----------------------------------------------------
// CONTROLES DE MOUSE
// ----------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 0.15; // permite acercarse mucho (necesario para el zoom al ojo)
controls.maxDistance = 20;

// ----------------------------------------------------
// VISTA INICIAL (para el botón "Vista general")
// ----------------------------------------------------
const VISTA_GENERAL = {
  position: new THREE.Vector3(3, 3, 5),
  target: new THREE.Vector3(0, 0, 0),
};

// Punto sobre el ojo derecho del modelo, obtenido con raycasting sobre la malla.
const VISTA_OJO = {
  position: new THREE.Vector3(0.4277, 0.2232, 0.1175),
  target: new THREE.Vector3(0.2577, 0.2032, 0.0175),
};

// ----------------------------------------------------
// CARGA DEL MODELO
// ----------------------------------------------------
const loader = new GLTFLoader();
loader.load(
  './models/ModeloPrototipo.glb',
  (gltf) => {
    scene.add(gltf.scene);
  },
  (progress) => {
    if (progress.total) {
      console.log('Cargando...', ((progress.loaded / progress.total) * 100).toFixed(0) + '%');
    }
  },
  (error) => {
    console.error('Error cargando el modelo:', error);
  }
);

// ----------------------------------------------------
// ANIMACIÓN SUAVE DE CÁMARA (para los botones)
// ----------------------------------------------------
let cameraAnimation = null;

function moveCameraTo(targetPosition, targetLookAt, duration = 1200) {
  cameraAnimation = {
    startTime: performance.now(),
    duration,
    fromPosition: camera.position.clone(),
    toPosition: targetPosition.clone(),
    fromTarget: controls.target.clone(),
    toTarget: targetLookAt.clone(),
  };
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function updateCameraAnimation() {
  if (!cameraAnimation) return;

  const elapsed = performance.now() - cameraAnimation.startTime;
  const t = Math.min(elapsed / cameraAnimation.duration, 1);
  const eased = easeInOutCubic(t);

  camera.position.lerpVectors(cameraAnimation.fromPosition, cameraAnimation.toPosition, eased);
  controls.target.lerpVectors(cameraAnimation.fromTarget, cameraAnimation.toTarget, eased);

  if (t >= 1) {
    cameraAnimation = null;
  }
}

// ----------------------------------------------------
// BOTONES
// ----------------------------------------------------
document.getElementById('btn-eye').addEventListener('click', () => {
  moveCameraTo(VISTA_OJO.position, VISTA_OJO.target);
});

document.getElementById('btn-reset').addEventListener('click', () => {
  moveCameraTo(VISTA_GENERAL.position, VISTA_GENERAL.target);
});

// ----------------------------------------------------
// RESPONSIVE
// ----------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ----------------------------------------------------
// LOOP DE ANIMACIÓN
// ----------------------------------------------------
function animate() {
  requestAnimationFrame(animate);

  updateCameraAnimation();
  controls.update();
  renderer.render(scene, camera);
}

animate();
