const fs = require('fs');
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { prune, dedup } = require('@gltf-transform/functions');
const { PropertyType } = require('@gltf-transform/core');

const CONSERVAR = [
  'Expressions_mouthOpen_max',
  'Expressions_tongueOut_max',
  'Expressions_pupilsDilatation_max',
  'Expressions_pupilsDilatation_min',
  'Expressions_eyeClosedL_max',
  'Expressions_eyeClosedR_max',
];

(async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read((process.argv[2] || 'entrada.glb'));
  const raiz = doc.getRoot();
  for (const a of raiz.listAnimations()) a.dispose();

  const mesh = raiz.listMeshes()[0];
  let orden = null;

  // 1. El material de los ojos usa el UV número 3. Antes de borrar los UV
  //    sobrantes hay que mover ese al 0, o la esclerótica sale roja.
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const nm = mat ? mat.getName() : '';
    if (/human_eyes/i.test(nm)) {
      const uv3 = prim.getAttribute('TEXCOORD_3');
      if (uv3) prim.setAttribute('TEXCOORD_0', uv3);
    }
  }
  for (const m of raiz.listMaterials()) {
    for (const info of [m.getBaseColorTextureInfo(), m.getNormalTextureInfo(), m.getMetallicRoughnessTextureInfo()]) {
      if (info) info.setTexCoord(0);
    }
  }

  // 2. Podar morphs y UV sobrantes.
  let quitados = 0;
  for (const prim of mesh.listPrimitives()) {
    const targets = prim.listTargets();
    const nombres = targets.map(t => t.getName());
    if (!orden) orden = nombres.filter(n => CONSERVAR.includes(n));
    for (let i = targets.length - 1; i >= 0; i--) {
      if (!CONSERVAR.includes(nombres[i])) { prim.removeTarget(targets[i]); targets[i].dispose(); quitados++; }
    }
    for (const uv of ['TEXCOORD_1','TEXCOORD_2','TEXCOORD_3','TEXCOORD_4']) prim.setAttribute(uv, null);
  }
  mesh.setWeights(orden.map(() => 0));
  for (const n of raiz.listNodes()) if (n.getWeights && n.getWeights().length) n.setWeights(orden.map(() => 0));
  console.log('morphs:', orden.join(', '));
  console.log('targets borrados:', quitados);

  // 3. Texturas a su sitio.
  const porNombre = {};
  for (const t of raiz.listTextures()) (porNombre[t.getName()] = porNombre[t.getName()] || []).push(t);
  const albedo = porNombre['human_male_albedo'][0];
  const sclera = porNombre['sclera_color'][0];
  const pestanas = porNombre['human_male_eyelash'] || [];

  // la pestaña venía con el alfa al revés: salían como tiras blancas sólidas
  const pngInv = fs.readFileSync(__dirname + '/pestana_alfa_invertida.png');
  let texPestanaColor = null;
  for (const t of pestanas) {
    const img = t.getImage();
    if (img && img.byteLength > 330000) continue;         // el normal map
  }
  texPestanaColor = pestanas.length > 1 ? pestanas[1] : pestanas[0];

  for (const m of raiz.listMaterials()) {
    const n = m.getName();
    if (/skin|tongue|nails|generic/i.test(n)) {
      m.setBaseColorTexture(albedo); m.setBaseColorFactor([1,1,1,1]);
      m.setNormalTexture(null); m.setMetallicFactor(0);
      m.setRoughnessFactor(/tongue/i.test(n) ? 0.45 : 0.72); m.setDoubleSided(false);
      const i = m.getBaseColorTextureInfo(); if (i) i.setTexCoord(0);
    } else if (/human_eyes/i.test(n)) {
      m.setBaseColorTexture(sclera); m.setBaseColorFactor([1,1,1,1]);
      m.setMetallicFactor(0); m.setRoughnessFactor(0.25); m.setDoubleSided(false);
      const i = m.getBaseColorTextureInfo(); if (i) i.setTexCoord(0);
    } else if (/Iris/i.test(n)) {
      m.setBaseColorFactor([0.42,0.29,0.18,1]); m.setMetallicFactor(0);
      m.setRoughnessFactor(0.40); m.setDoubleSided(false);
    } else if (/pupil/i.test(n)) {
      m.setBaseColorFactor([0.03,0.035,0.047,1]); m.setMetallicFactor(0);
      m.setRoughnessFactor(0.9); m.setDoubleSided(false);
    } else if (/cornea/i.test(n)) {
      m.setBaseColorFactor([1,1,1,0.08]); m.setAlphaMode('BLEND');
      m.setMetallicFactor(0); m.setRoughnessFactor(0.05); m.setDoubleSided(false);
    } else if (/eyelash/i.test(n)) {
      const t = m.getBaseColorTexture();
      if (t) { t.setImage(pngInv); t.setMimeType('image/png'); }
      m.setAlphaMode('MASK'); m.setAlphaCutoff(0.85);
      m.setBaseColorFactor([0.25,0.19,0.16,1]);
      m.setNormalTexture(null); m.setDoubleSided(true);
    }
  }

  // dedup sin materiales: si no, colapsa piel/lengua/unas en uno solo
  // y la app ya no puede distinguirlos por nombre
  await doc.transform(prune(), dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE, PropertyType.MESH, PropertyType.SKIN] }));
  await io.write((process.argv[3] || 'arreglado.glb'), doc);
  console.log('escrito');
})();
