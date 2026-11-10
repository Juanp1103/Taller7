# El modelo 3D del paciente

`static/modelo.glb` es la cara que se ve en el televisor. Este documento explica
de dónde sale, qué hay que arreglarle cada vez que el diseñador lo reexporta, y
qué medidas del visor dependen de él.

## De dónde sale

El diseñador lo arma con **MB-Lab**, un complemento de Blender que genera
personajes humanos. Lo que entrega es un cuerpo completo a escala real
(1,73 m de alto, en metros) con 82 morphs de expresión.

Ese archivo **no se puede usar tal cual**. Pesa 28,9 MB y sale sin texturas.

## Lo que hay que arreglarle

MB-Lab construye sus materiales con una red de nodos de Cycles —piel
procedural con subsurface, grupos de nodos—, y el exportador de glTF solo
entiende una cosa: una textura de imagen enchufada directo al Base Color de un
Principled BSDF. Todo lo demás lo descarta sin avisar. El resultado es que
siete de los nueve materiales salen vacíos y el personaje se ve gris.

Lo ideal es que el diseñador lo arregle antes de exportar, reemplazando la red
de nodos de cada material por un Principled BSDF simple. Mientras tanto, el
script `modelo/arreglar.js` lo hace sobre el `.glb` ya exportado:

1. **Conecta las texturas.** `human_male_albedo` a la piel y a la lengua,
   `sclera_color` al ojo, y un color plano al iris y a la pupila. La textura de
   la piel sí viene dentro del archivo: el exportador se la pega al material de
   la lengua, y además la mete como mapa de normales, donde no va.
2. **Mueve el UV del ojo.** El material de la esclerótica usa el juego de UV
   número 3. Si se borran los UV sobrantes sin mover ese primero, el ojo sale
   rojo.
3. **Poda los morphs.** De los 82 deja seis. Los otros 76 son el 73 % del peso
   del archivo y no los usa nadie: expansión del abdomen, del pecho, veinte
   variantes de sonrisa.
4. **Arregla las pestañas.** Vienen con el canal alfa invertido y se ven como
   tiras blancas sólidas.

Después se comprimen las texturas. El resultado baja de 28,9 MB a 2,6 MB.

```bash
cd modelo
npm install @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions
npm install -g @gltf-transform/cli
node arreglar.js  <entrada.glb>  arreglado.glb
gltf-transform resize arreglado.glb paso1.glb --width 1024 --height 1024
gltf-transform webp   paso1.glb    ../static/modelo.glb
```

No usar `gltf-transform optimize` (junta mallas y rompe las pupilas por
separado) ni Draco (no hay decodificador vendorizado y el salón puede estar sin
internet).

## Los seis morphs que quedan

| Morph | Para qué |
|---|---|
| `Expressions_mouthOpen_max` | maniobra "abrir la boca" |
| `Expressions_tongueOut_max` | maniobra "sacar la lengua" |
| `Expressions_pupilsDilatation_max` | sin usar (ver abajo) |
| `Expressions_pupilsDilatation_min` | sin usar (ver abajo) |
| `Expressions_eyeClosedL_max` | reservado para ptosis |
| `Expressions_eyeClosedR_max` | reservado para ptosis |

**Por qué la pupila no usa el morph del modelo.** Se midió: el morph va de
3,26 mm (contraída del todo) a 5,68 mm (dilatada del todo). La escala clínica
necesita desde 0,8 mm —puntiforme, el signo del opioide, que es el más
diagnóstico que tenemos— hasta 9. El morph no llega ni a un extremo ni al otro.
Así que la pupila del modelo se esconde y el visor dibuja la suya encima del
iris, del diámetro exacto en milímetros.

## Medidas que dependen del modelo

Están todas juntas al principio de `static/visor3d.js`, en metros y en
coordenadas de mundo, con la cara mirando hacia +Z. **Si llega un modelo nuevo
hay que volver a medirlas.**

| Qué | Valor | Cómo se midió |
|---|---|---|
| Centro de la boca | `(0, 1,5515, 0,1575)` | el vértice que más se mueve al abrir la boca |
| Radio de la cianosis | `0,0140` | apretado a propósito: más grande y los dientes salen morados |
| Centro del ojo | `(±0,0308, 1,6167, 0,1346)` | el iris es un disco plano mirando a +Z |
| Iris | 11,66 mm | caja de la malla del iris |
| Separación entre ojos | 61,6 mm | |
| Cabeza | 171 × 226 mm | malla de piel por encima de y=1,50 |
| Barbilla / coronilla | y 1,50 / 1,73 | |

Las gotas de sudor no se colocan a mano: el visor lanza rayos de frente contra
la malla desde una lista de anclas en la frente y las mejillas, y descarta las
que pegan en un borde muy inclinado. Si cambia la cabeza, basta con revisar que
las anclas sigan cayendo sobre la cara.

## Si el diseñador reexporta

Pídele, en este orden de importancia:

1. Que conecte las texturas a un Principled BSDF simple en cada material, para
   no tener que arreglarlo después.
2. Que exporte **con tangentes** ("Tangents" en las opciones de glTF). Sin
   ellas el mapa de normales se aproxima con derivadas y pierde definición.
3. Que mande un **mapa de rugosidad de la piel**, si MB-Lab se lo permite. No
   para encender el sudor —eso lo hace la app en vivo— sino para que el brillo
   caiga donde cae de verdad: frente, nariz y pómulos sí, labios y cejas no.
4. Que borre los morphs de expresión que no usamos, si puede, o que al menos
   sepa que se los vamos a quitar.

El parámetro **"oil skin"** de MB-Lab no sirve para la diaforesis: vive en la
red de nodos de Cycles y no viaja en el `.glb`. Y aunque viajara quedaría
horneado, un brillo fijo. La diaforesis la hace la app en vivo bajando la
rugosidad de la piel y pegando gotas, y así es como tiene que ser, porque el
profesor la sube y la baja durante la práctica.
