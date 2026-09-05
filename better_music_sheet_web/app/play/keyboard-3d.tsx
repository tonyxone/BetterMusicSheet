"use client";

// An 88-key piano rendered with three.js, highlighting whichever notes are
// currently sounding.
//
// Purely presentational: it has no idea whether the highlight came from
// playback or from clicking a measure.
//
// Rendered on demand rather than in a requestAnimationFrame loop - the camera
// never moves and nothing animates, so a continuous loop would just burn
// battery to draw identical frames.

import { useEffect, useRef } from "react";
import * as THREE from "three";

const FIRST_MIDI = 21; // A0
const LAST_MIDI = 108; // C8

// Pitch classes that are black keys; everything else gets a white key.
const BLACK_CLASSES = new Set([1, 3, 6, 8, 10]);

const WHITE_W = 1;
const WHITE_D = 5.6;
const BLACK_W = 0.58;
const BLACK_D = 3.6;
const WHITE_H = 0.6;
const BLACK_H = 0.9;

const COLOR_WHITE = 0xfdfcf8;
const COLOR_BLACK = 0x211a14;
const COLOR_ON = 0xa83c34; // --accent
const EMISSIVE_ON = 0x8c4a1f; // --accent-deep

export function isBlackKey(midi: number) {
  return BLACK_CLASSES.has(((midi % 12) + 12) % 12);
}

/** x position of each key, in white-key units. White keys tile left to right;
 * a black key sits in the gap after the white key below it - which is why
 * there is no black key between E/F and B/C without any special-casing. */
function keyPositions() {
  const pos = new Map<number, number>();
  let whiteIndex = 0;
  let lastWhite = 0;
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (isBlackKey(midi)) {
      // Centred on the boundary between the white key below it and the next.
      pos.set(midi, lastWhite + 0.5);
    } else {
      pos.set(midi, whiteIndex);
      lastWhite = whiteIndex;
      whiteIndex++;
    }
  }
  return { pos, whiteCount: whiteIndex };
}

export function Keyboard3D({ activeMidis }: { activeMidis: number[] }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const keysRef = useRef<Map<number, THREE.Mesh>>(new Map());
  const renderRef = useRef<() => void>(() => {});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = null;

    const { pos, whiteCount } = keyPositions();
    const spanX = whiteCount * WHITE_W;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // Orthographic, not perspective: with a perspective camera the far keys
    // shrink, which makes it harder to compare one key to another - exactly
    // what this view exists for.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    camera.position.set(0, 26, 20);
    camera.lookAt(0, 0, -0.4);

    scene.add(new THREE.AmbientLight(0xffffff, 2.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.7);
    dir.position.set(-8, 30, 22);
    scene.add(dir);

    const keys = new Map<number, THREE.Mesh>();
    const whiteGeo = new THREE.BoxGeometry(WHITE_W * 0.92, WHITE_H, WHITE_D);
    const blackGeo = new THREE.BoxGeometry(BLACK_W, BLACK_H, BLACK_D);

    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const black = isBlackKey(midi);
      const material = new THREE.MeshStandardMaterial({
        color: black ? COLOR_BLACK : COLOR_WHITE,
        roughness: black ? 0.55 : 0.72,
        metalness: 0.02,
        emissive: new THREE.Color(0x000000),
      });
      const mesh = new THREE.Mesh(black ? blackGeo : whiteGeo, material);
      const x = (pos.get(midi)! + 0.5) * WHITE_W - spanX / 2;
      mesh.position.set(
        x,
        black ? WHITE_H / 2 + BLACK_H / 2 - 0.18 : 0,
        black ? -(WHITE_D - BLACK_D) / 2 : 0,
      );
      mesh.userData.midi = midi;
      mesh.userData.black = black;
      scene.add(mesh);
      keys.set(midi, mesh);
    }

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    keysRef.current = keys;

    const render = () => renderer.render(scene, camera);
    renderRef.current = render;

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      // Fit the whole keyboard horizontally, letting height follow the
      // element's aspect so keys never distort.
      const halfW = spanX / 2 + 0.6;
      const halfH = (halfW * h) / w;
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
      render();
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    return () => {
      ro.disconnect();
      whiteGeo.dispose();
      blackGeo.dispose();
      keys.forEach((m) => (m.material as THREE.Material).dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      rendererRef.current = null;
      keysRef.current = new Map();
    };
  }, []);

  useEffect(() => {
    const keys = keysRef.current;
    if (!keys.size) return;
    const on = new Set(activeMidis);
    keys.forEach((mesh, midi) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const lit = on.has(midi);
      mat.color.setHex(lit ? COLOR_ON : mesh.userData.black ? COLOR_BLACK : COLOR_WHITE);
      mat.emissive.setHex(lit ? EMISSIVE_ON : 0x000000);
      mat.emissiveIntensity = lit ? 0.55 : 0;
    });
    renderRef.current();
  }, [activeMidis]);

  return <div className="keyboard-3d" ref={mountRef} />;
}

export default Keyboard3D;
