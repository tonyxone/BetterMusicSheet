"use client";

// An 88-key piano rendered with three.js, highlighting whichever notes are
// currently sounding.
//
// Purely presentational: it has no idea whether the highlight came from
// playback or from clicking a measure.
//
// Geometry follows a real instrument rather than the obvious approximation.
// Black keys are NOT centred on the boundary between two white keys - on a
// real piano the twelve semitones are equally spaced where they enter the
// action, so within an octave F# sits noticeably left of its boundary, G#
// close to centre, and A# right. Centring them (the naive layout) is the
// single thing that makes a drawn keyboard look wrong. Proportions are the
// standard ones too: black keys ~58% of a white key's width and ~60% of its
// length.
//
// Rendered on demand rather than in a requestAnimationFrame loop - nothing
// animates continuously, so a render loop would redraw identical frames.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

const FIRST_MIDI = 21; // A0
const LAST_MIDI = 108; // C8

const BLACK_CLASSES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

// White key = 1 unit wide. Real ratios: 2.4cm vs 1.4cm wide, 15cm vs 9cm long.
const WHITE_W = 1;
const WHITE_D = 6.25;
const WHITE_H = 0.55;
const BLACK_W = 0.583;
const BLACK_D = 3.75;
const BLACK_H = 0.95;
const GAP = 0.055; // hairline between white keys

const COLOR_WHITE = 0xfbf9f4;
const COLOR_BLACK = 0x1c1613;
// One colour per hand, so you can see at a glance which hand plays what.
const COLOR_RIGHT = 0x2f6fb5; // right hand (top staff)
const COLOR_LEFT = 0x3e8e5a;  // left hand
/** How much of the hand colour to mix into the key. Enough to read clearly at
 * a glance while still leaving the key itself visible underneath. */
const HIGHLIGHT_MIX = 0.7;
const COLOR_FELT = 0x8c2f2a;

export function isBlackKey(midi: number) {
  return BLACK_CLASSES.has(((midi % 12) + 12) % 12);
}

export function noteName(midi: number, withOctave = false) {
  const pc = ((midi % 12) + 12) % 12;
  return NOTE_NAMES[pc] + (withOctave ? String(Math.floor(midi / 12) - 1) : "");
}

/** Key centres in white-key units, measured from the left edge of the board.
 *
 * White keys tile evenly. Each black key is placed by the "twelve equal
 * divisions at the back of the octave" rule described above, which is what
 * produces the familiar uneven look of the 2- and 3-key groups. */
function keyLayout() {
  const centers = new Map<number, number>();
  let whiteIndex = 0;

  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (!isBlackKey(midi)) {
      centers.set(midi, whiteIndex + 0.5);
      whiteIndex++;
    }
  }

  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    if (!isBlackKey(midi)) continue;
    // Anchor on the C of this key's octave when it exists, else on the
    // neighbouring white key, so the bottom of the board (which starts at A0)
    // is laid out on the same rule as everywhere else.
    const pc = ((midi % 12) + 12) % 12;
    const belowWhite = centers.get(midi - 1);
    const aboveWhite = centers.get(midi + 1);
    if (belowWhite === undefined || aboveWhite === undefined) {
      centers.set(midi, (belowWhite ?? aboveWhite ?? 0) + (belowWhite === undefined ? -0.5 : 0.5));
      continue;
    }
    const boundary = (belowWhite + aboveWhite) / 2;
    // Offset from that boundary, in white-key units. An octave is 7 white
    // keys wide and its twelve semitones are equally spaced at the back, so
    // semitone n is centred at (n + 0.5) * 7/12; the offset is that minus the
    // white-key boundary it sits over. Hence the familiar look: C# and F#
    // lean left, A# leans right, G# sits nearly centred.
    const OFFSET: Record<number, number> = {
      1: -1 / 8,    // C#  centre 0.875 vs boundary 1
      3: 1 / 24,    // D#  centre 2.042 vs boundary 2
      6: -5 / 24,   // F#  centre 3.792 vs boundary 4
      8: -1 / 24,   // G#  centre 4.958 vs boundary 5
      10: 1 / 8,    // A#  centre 6.125 vs boundary 6
    };
    centers.set(midi, boundary + (OFFSET[pc] ?? 0));
  }

  return { centers, whiteCount: whiteIndex };
}

/** A white key with its front edge rounded, so it reads as a key rather than
 * a slab. Extruded along Y, then laid flat. */
function whiteKeyGeometry() {
  const w = WHITE_W - GAP;
  const d = WHITE_D;
  const r = 0.12;
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -d / 2 + r);
  s.lineTo(-w / 2, d / 2);
  s.lineTo(w / 2, d / 2);
  s.lineTo(w / 2, -d / 2 + r);
  s.quadraticCurveTo(w / 2, -d / 2, w / 2 - r, -d / 2);
  s.lineTo(-w / 2 + r, -d / 2);
  s.quadraticCurveTo(-w / 2, -d / 2, -w / 2, -d / 2 + r);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: WHITE_H,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.025,
    bevelSegments: 2,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function blackKeyGeometry() {
  const geo = new THREE.BoxGeometry(BLACK_W, BLACK_H, BLACK_D);
  // Taper the top slightly, the way a real black key narrows toward its top
  // face - catches the light instead of reading as a flat brick.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * 0.82);
      pos.setZ(i, pos.getZ(i) * 0.98);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export type ActiveKey = { midi: number; role: number };

export function Keyboard3D({
  activeKeys,
  showKeyNames = false,
}: {
  activeKeys: ActiveKey[];
  showKeyNames?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<Map<number, THREE.Mesh>>(new Map());
  const renderRef = useRef<() => void>(() => {});
  const layoutLabelsRef = useRef<() => void>(() => {});

  const layout = useMemo(() => keyLayout(), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const { centers, whiteCount } = layout;
    const spanX = whiteCount * WHITE_W;

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // Orthographic, not perspective: with perspective the far keys shrink,
    // which defeats comparing one key to another.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    camera.position.set(0, 30, 21);
    camera.lookAt(0, 0, -0.35);

    scene.add(new THREE.AmbientLight(0xffffff, 1.55));
    const key = new THREE.DirectionalLight(0xfff6e8, 1.85);
    key.position.set(-10, 26, 16);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffe9c8, 0.5);
    rim.position.set(12, 10, -14);
    scene.add(rim);

    // Felt strip along the back, as on a real instrument - also hides the gap
    // where the black keys meet the back rail.
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(spanX + 0.5, 0.34, 0.75),
      new THREE.MeshStandardMaterial({ color: COLOR_FELT, roughness: 1 }),
    );
    felt.position.set(0, WHITE_H / 2, -WHITE_D / 2 - 0.3);
    scene.add(felt);

    const whiteGeo = whiteKeyGeometry();
    const blackGeo = blackKeyGeometry();
    const keys = new Map<number, THREE.Mesh>();

    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const black = isBlackKey(midi);
      const material = new THREE.MeshStandardMaterial({
        color: black ? COLOR_BLACK : COLOR_WHITE,
        roughness: black ? 0.42 : 0.62,
        metalness: 0.03,
        emissive: new THREE.Color(0x000000),
      });
      const mesh = new THREE.Mesh(black ? blackGeo : whiteGeo, material);
      const x = centers.get(midi)! * WHITE_W - spanX / 2;
      mesh.position.set(
        x,
        black ? WHITE_H / 2 + BLACK_H / 2 - 0.2 : 0,
        // Black keys sit toward the back; white key fronts stay flush.
        black ? -(WHITE_D - BLACK_D) / 2 : 0,
      );
      mesh.userData = { midi, black, baseY: mesh.position.y };
      scene.add(mesh);
      keys.set(midi, mesh);
    }

    keysRef.current = keys;
    const render = () => renderer.render(scene, camera);
    renderRef.current = render;

    // Labels are HTML rather than textures: crisp at any size, themeable, and
    // no per-key texture memory. The camera never moves, so their positions
    // only need recomputing on resize.
    const layoutLabels = () => {
      const layer = labelLayerRef.current;
      if (!layer) return;
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      const v = new THREE.Vector3();
      layer.querySelectorAll<HTMLElement>("[data-midi]").forEach((el) => {
        const midi = Number(el.dataset.midi);
        const mesh = keys.get(midi);
        if (!mesh) return;
        const black = mesh.userData.black as boolean;
        // Anchor near the front face of each key, where a player would look.
        v.set(
          mesh.position.x,
          mesh.position.y + (black ? BLACK_H / 2 : WHITE_H / 2),
          mesh.position.z + (black ? BLACK_D / 2 - 0.5 : WHITE_D / 2 - 0.75),
        );
        v.project(camera);
        el.style.left = `${((v.x + 1) / 2) * w}px`;
        el.style.top = `${((-v.y + 1) / 2) * h}px`;
      });
    };
    layoutLabelsRef.current = layoutLabels;

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      // updateStyle must stay on: with a devicePixelRatio above 1 the
      // drawing buffer is larger than the element, and without a matching
      // CSS size the canvas displays at buffer size and gets clipped.
      renderer.setSize(w, h);
      // Fit the board horizontally; height follows the element's aspect so
      // keys never distort.
      const halfW = spanX / 2 + 0.8;
      const halfH = (halfW * h) / w;
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
      render();
      layoutLabels();
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    return () => {
      ro.disconnect();
      whiteGeo.dispose();
      blackGeo.dispose();
      felt.geometry.dispose();
      (felt.material as THREE.Material).dispose();
      keys.forEach((m) => (m.material as THREE.Material).dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      keysRef.current = new Map();
    };
  }, [layout]);

  useEffect(() => {
    const keys = keysRef.current;
    if (!keys.size) return;
    // A pitch played by both hands at once takes the right hand's colour;
    // picking one beats blending into a third colour that means neither.
    const roleOf = new Map<number, number>();
    for (const k of activeKeys) {
      if (!roleOf.has(k.midi) || k.role === 0) roleOf.set(k.midi, k.role);
    }
    keys.forEach((mesh, midi) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const role = roleOf.get(midi);
      const lit = role !== undefined;
      const litColor = role === 1 ? COLOR_LEFT : COLOR_RIGHT;
      const black = mesh.userData.black as boolean;
      const base = black ? COLOR_BLACK : COLOR_WHITE;
      mat.color.setHex(base);
      if (lit) {
        // Blended rather than replaced, so the key stays visible underneath.
        // Black keys take a stronger mix - the same fraction of a colour over
        // near-black reads far darker than it does over ivory - and the boost
        // is clamped so it can never overshoot into a different hue.
        const mix = black ? Math.min(1, HIGHLIGHT_MIX * 1.25) : HIGHLIGHT_MIX;
        mat.color.lerp(new THREE.Color(litColor), mix);
      }
      mat.emissive.setHex(lit ? litColor : 0x000000);
      mat.emissiveIntensity = lit ? 0.3 : 0;
      // Press the key down while it sounds - the motion reads as "this one" far
      // faster than colour alone.
      const baseY = mesh.userData.baseY as number;
      mesh.position.y = lit ? baseY - 0.16 : baseY;
      mesh.rotation.x = lit ? 0.022 : 0;
    });
    renderRef.current();
  }, [activeKeys]);

  useEffect(() => {
    if (showKeyNames) layoutLabelsRef.current();
  }, [showKeyNames]);

  const labelled = useMemo(() => {
    const out: { midi: number; black: boolean; text: string }[] = [];
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const black = isBlackKey(midi);
      out.push({ midi, black, text: black ? noteName(midi) : noteName(midi, midi % 12 === 0) });
    }
    return out;
  }, []);

  const on = useMemo(() => new Set(activeKeys.map((k) => k.midi)), [activeKeys]);

  return (
    <div className="keyboard-3d" ref={mountRef}>
      <div className={`key-labels${showKeyNames ? " visible" : ""}`} ref={labelLayerRef}>
        {labelled.map((k) => (
          <span
            key={k.midi}
            data-midi={k.midi}
            className={`key-label${k.black ? " black" : ""}${on.has(k.midi) ? " lit" : ""}`}
          >
            {k.text}
          </span>
        ))}
      </div>
    </div>
  );
}

export default Keyboard3D;
