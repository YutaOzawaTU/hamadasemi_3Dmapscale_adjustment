import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

// Topo to STL — シンプル3D地図メーカー（React + Three.js）
// このファイルは NetCDF (HDF5) から標高グリッドを読み込み、簡易3D表示→STLで出力するための
// フロントエンドコンポーネントです。ブラウザ環境で動作することを前提にしています。

// ---------- ユーティリティ ----------
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function formatNumber(n: number) {
  return new Intl.NumberFormat().format(n);
}

function viridis(t: number): [number, number, number] {
  // 簡易版 Viridis カラーマップ（0..1 -> RGB）
  const a = [0.280268, 0.165368, 0.476043];
  const b = [0.23393, 0.472705, 0.310964];
  const c = [0.043831, 0.530361, 0.393395];
  const d = [2.0, 1.5, 1.0];
  const e = [0.0, 0.5, 1.0];
  const r = a[0] + b[0] * Math.pow(t, d[0]) + c[0] * Math.pow(t, e[0]);
  const g = a[1] + b[1] * Math.pow(t, d[1]) + c[1] * Math.pow(t, e[1]);
  const bl = a[2] + b[2] * Math.pow(t, d[2]) + c[2] * Math.pow(t, e[2]);
  return [Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, bl))];
}

const MAX_DIM = 1200;
const MAX_VERTICES = 1_500_000;

function scalePositionsFromGeometry(g: THREE.BufferGeometry, scale: number) {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3 + 0] = pos.getX(i) * scale;
    arr[i * 3 + 1] = pos.getY(i) * scale;
    arr[i * 3 + 2] = pos.getZ(i) * scale;
  }
  return arr;
}

// ---------- h5wasm の堅牢な読み込み ----------
async function importModuleFromUrlAsBlob(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const code = await res.text();
  const blob = new Blob([code], { type: "text/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    // bundler による書き換えを回避し、ブラウザが直接 blob を import する
    const mod = await import(/* @vite-ignore */ blobUrl);
    return mod.default || mod;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function importH5Wasm(): Promise<any> {
  let lastErr: any = null;
  try {
    // まず通常のパッケージ名で試す
    const m = await import("h5wasm");
    return (m && (m.default || m));
  } catch (e) {
    lastErr = e;
  }
  try {
    // 一部環境でパッケージスぺックが効くことがある
    const m = await import("h5wasm@0.4.9/dist/esm/hdf5_hl.js");
    return (m && (m.default || m));
  } catch (e) {
    lastErr = e;
  }

  // 最後に CDN を fetch -> blob -> import で回避
  const cdnList = [
    "https://cdn.jsdelivr.net/npm/h5wasm@0.4.9/dist/esm/hdf5_hl.js",
    "https://unpkg.com/h5wasm@0.4.9/dist/esm/hdf5_hl.js",
  ];
  for (const url of cdnList) {
    try {
      const mod = await importModuleFromUrlAsBlob(url);
      return mod;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("h5wasm import failed");
}

// ---------- メインコンポーネント ----------
export default function TopoToSTLApp(): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);

  const [fileName, setFileName] = useState<string>("");
  const [rows, setRows] = useState<number>(0);
  const [cols, setCols] = useState<number>(0);
  const [latRange, setLatRange] = useState<[number, number] | null>(null);
  const [lonRange, setLonRange] = useState<[number, number] | null>(null);
  const [zMin, setZMin] = useState<number | null>(null);
  const [zMax, setZMax] = useState<number | null>(null);

  const [exaggeration, setExaggeration] = useState<number>(1.0);
  const [baseThickness, setBaseThickness] = useState<number>(20);
  const [targetMaxDim, setTargetMaxDim] = useState<number>(900);
  const [unit, setUnit] = useState<"mm" | "m">("mm");

  const gridRef = useRef<{
    lats: Float32Array | Float64Array;
    lons: Float32Array | Float64Array;
    Z: Float32Array | Int16Array | Int32Array | Float64Array;
    shape: [number, number];
  } | null>(null);

  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [debugMsg, setDebugMsg] = useState<string>("");
  const [showDebug, setShowDebug] = useState<boolean>(false);

  // Three.js initialization
  useEffect(() => {
    if (!mountRef.current) return;
    const w = mountRef.current.clientWidth;
    const h = mountRef.current.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7fafc);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1e9);
    camera.position.set(0, -2000, 1500);
    camera.up.set(0, 0, 1);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1000, -1000, 2000);
    scene.add(dir);

    mountRef.current.appendChild(renderer.domElement);

    const handleResize = () => {
      if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      renderer.dispose();
      if (mountRef.current) mountRef.current.removeChild(renderer.domElement);
    };
  }, []);

  async function loadNetCDF(file: File) {
    setError("");
    setBusy("NetCDF を解析中…");
    try {
      setFileName(file.name || "uploaded.nc");
      const h5 = await importH5Wasm();
      const { FS } = await h5.ready;
      const ab = await file.arrayBuffer();
      try {
        FS.writeFile(file.name, new Uint8Array(ab));
      } catch (fsErr: any) {
        throw new Error(`FS.writeFile failed: ${(fsErr && fsErr.message) || String(fsErr)}`);
      }

      const f = new h5.File(file.name, "r");
      try {
        const rootKeys: string[] = f.keys();
        const elevCandidates = ["elevation", "z", "bathymetry", "bedrock"];
        const latCandidates = ["lat", "latitude", "y"];
        const lonCandidates = ["lon", "longitude", "x"];

        const findFirst = (cands: string[]) => {
          const key = rootKeys.find((k) => cands.some((c) => k.toLowerCase().includes(c)));
          return key || null;
        };

        let elevKey = findFirst(elevCandidates);
        let latKey = findFirst(latCandidates);
        let lonKey = findFirst(lonCandidates);

        const searchDeep = (groupPath = "") => {
          const grp = groupPath ? f.get(groupPath) : f;
          const keys: string[] = (grp as any).keys?.() || [];
          for (const k of keys) {
            const full = groupPath ? `${groupPath}/${k}` : k;
            const obj = (grp as any).get?.(k);
            if (!obj) continue;
            const isDataset = !!obj.value || !!obj.metadata;
            if (isDataset) {
              if (!elevKey && elevCandidates.some((c) => k.toLowerCase().includes(c))) elevKey = full;
              if (!latKey && latCandidates.some((c) => k.toLowerCase().includes(c))) latKey = full;
              if (!lonKey && lonCandidates.some((c) => k.toLowerCase().includes(c))) lonKey = full;
            } else {
              searchDeep(full);
            }
          }
        };

        if (!elevKey || !latKey || !lonKey) searchDeep("");
        if (!elevKey || !latKey || !lonKey) {
          throw new Error(`必要な変数が見つかりません（見つかった: ${rootKeys.join(", ")})`);
        }

        const Zds = f.get(elevKey);
        const latds = f.get(latKey);
        const londs = f.get(lonKey);

        const shape: [number, number] = Zds.shape || [0, 0];
        if (!shape || shape.length !== 2) throw new Error("標高データが2次元ではありません");

        const rows0 = shape[0];
        const cols0 = shape[1];
        if (rows0 * cols0 > 150_000_000) {
          throw new Error(`グリッドが大きすぎます（${formatNumber(rows0)}×${formatNumber(cols0)}）。領域を絞ってください。`);
        }

        const Zraw = Zds.value as Int16Array | Int32Array | Float32Array | Float64Array;
        const lats = latds.value as Float32Array | Float64Array;
        const lons = londs.value as Float32Array | Float64Array;

        gridRef.current = { lats, lons, Z: Zraw, shape: [rows0, cols0] };
        setRows(rows0);
        setCols(cols0);
        setLatRange([lats[0], lats[lats.length - 1]].sort((a, b) => a - b) as [number, number]);
        setLonRange([lons[0], lons[lons.length - 1]].sort((a, b) => a - b) as [number, number]);

        let minV = Infinity;
        let maxV = -Infinity;
        for (let i = 0; i < Zraw.length; i += Math.max(1, Math.floor(Zraw.length / 500_000))) {
          const v = Number(Zraw[i]);
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        setZMin(minV);
        setZMax(maxV);

        await buildOrUpdateMesh();
      } finally {
        try { (f as any).close?.(); } catch (e) {}
      }
    } catch (e: any) {
      console.error(e);
      if (e instanceof ReferenceError || /not defined/i.test(String(e))) {
        setError(`内部参照エラーが発生しました: ${e?.message || String(e)}. 実行コンソールの完全なエラーを共有してください。`);
      } else {
        setError(e?.message || String(e));
      }
    } finally {
      setBusy("");
    }
  }

  function calcSteps(r: number, c: number, maxDim: number) {
    const stepY = Math.max(1, Math.ceil(r / maxDim));
    const stepX = Math.max(1, Math.ceil(c / maxDim));
    const estRows = Math.ceil(r / stepY);
    const estCols = Math.ceil(c / stepX);
    let factor = 1;
    while (estRows * estCols * 2 > MAX_VERTICES) {
      factor++;
      if (factor > 20) break;
    }
    return { stepY: stepY * factor, stepX: stepX * factor };
  }

  function buildSolidGeometry(
    lats: Float32Array | Float64Array,
    lons: Float32Array | Float64Array,
    Z: Float32Array | Int16Array | Int32Array | Float64Array,
    shape: [number, number],
    exag: number,
    base: number,
    maxDim: number
  ) {
    const [R, C] = shape;
    const { stepY, stepX } = calcSteps(R, C, clamp(maxDim, 100, MAX_DIM));
    const rows1 = Math.ceil(R / stepY);
    const cols1 = Math.ceil(C / stepX);

    const avgLatDeg = (lats[0] + lats[lats.length - 1]) / 2;
    const avgLatRad = (avgLatDeg * Math.PI) / 180;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(avgLatRad);

    const rowsIdx = new Int32Array(rows1);
    const colsIdx = new Int32Array(cols1);
    for (let i = 0, v = 0; i < rows1; i++, v += stepY) rowsIdx[i] = Math.min(v, R - 1);
    for (let j = 0, v = 0; j < cols1; j++, v += stepX) colsIdx[j] = Math.min(v, C - 1);

    const lat0 = lats[rowsIdx[0]];
    const lon0 = lons[colsIdx[0]];

    const getZ = (i: number, j: number) => Number(Z[i * C + j]) * exag;

    let zMinSurface = Infinity;
    let zMaxSurface = -Infinity;
    for (let ii = 0; ii < rows1; ii++) {
      const i0 = rowsIdx[ii];
      for (let jj = 0; jj < cols1; jj++) {
        const j0 = colsIdx[jj];
        const z = getZ(i0, j0);
        if (z < zMinSurface) zMinSurface = z;
        if (z > zMaxSurface) zMaxSurface = z;
      }
    }

    const bottomZ = zMinSurface - Math.abs(base);

    const topVerts = rows1 * cols1;
    const totalVerts = topVerts * 2;

    const positions = new Float32Array(totalVerts * 3);
    const colors = new Float32Array(totalVerts * 3);

    let p = 0;
    let ci = 0;

    for (let ii = 0; ii < rows1; ii++) {
      const i0 = rowsIdx[ii];
      const y = (lats[i0] - lat0) * mPerDegLat;
      for (let jj = 0; jj < cols1; jj++) {
        const j0 = colsIdx[jj];
        const x = (lons[j0] - lon0) * mPerDegLon;
        const z = getZ(i0, j0);
        positions[p++] = x;
        positions[p++] = y;
        positions[p++] = z;
        colors[ci++] = 0;
        colors[ci++] = 0;
        colors[ci++] = 0;
      }
    }

    for (let ii = 0; ii < rows1; ii++) {
      for (let jj = 0; jj < cols1; jj++) {
        const idxTop = ii * cols1 + jj;
        const baseIdx = idxTop * 3;
        positions[p++] = positions[baseIdx + 0];
        positions[p++] = positions[baseIdx + 1];
        positions[p++] = bottomZ;
        colors[ci++] = 0.2;
        colors[ci++] = 0.2;
        colors[ci++] = 0.2;
      }
    }

    const dz = Math.max(1e-6, zMaxSurface - zMinSurface);
    for (let ii = 0; ii < rows1; ii++) {
      for (let jj = 0; jj < cols1; jj++) {
        const idxTop = ii * cols1 + jj;
        const z = positions[idxTop * 3 + 2];
        const t = clamp((z - zMinSurface) / dz, 0, 1);
        const [r, g, b] = viridis(t);
        const ci2 = idxTop * 3;
        colors[ci2] = r;
        colors[ci2 + 1] = g;
        colors[ci2 + 2] = b;
      }
    }

    const faces: number[] = [];
    const top = (r: number, c: number) => r * cols1 + c;
    const bottom = (r: number, c: number) => topVerts + r * cols1 + c;

    for (let i = 0; i < rows1 - 1; i++) {
      for (let j = 0; j < cols1 - 1; j++) {
        const v0 = top(i, j);
        const v1 = top(i, j + 1);
        const v2 = top(i + 1, j);
        const v3 = top(i + 1, j + 1);
        faces.push(v0, v1, v3, v0, v3, v2);
      }
    }

    for (let j = 0; j < cols1 - 1; j++) {
      const a = top(0, j), b = top(0, j + 1);
      const A = bottom(0, j), B = bottom(0, j + 1);
      faces.push(a, A, B, a, B, b);
    }
    for (let j = 0; j < cols1 - 1; j++) {
      const a = top(rows1 - 1, j), b = top(rows1 - 1, j + 1);
      const A = bottom(rows1 - 1, j), B = bottom(rows1 - 1, j + 1);
      faces.push(a, b, B, a, B, A);
    }
    for (let i = 0; i < rows1 - 1; i++) {
      const a = top(i, 0), b = top(i + 1, 0);
      const A = bottom(i, 0), B = bottom(i + 1, 0);
      faces.push(a, A, B, a, B, b);
    }
    for (let i = 0; i < rows1 - 1; i++) {
      const a = top(i, cols1 - 1), b = top(i + 1, cols1 - 1);
      const A = bottom(i, cols1 - 1), B = bottom(i + 1, cols1 - 1);
      faces.push(a, b, B, a, B, A);
    }

    for (let i = 0; i < rows1 - 1; i++) {
      for (let j = 0; j < cols1 - 1; j++) {
        const v0 = bottom(i, j);
        const v1 = bottom(i, j + 1);
        const v2 = bottom(i + 1, j);
        const v3 = bottom(i + 1, j + 1);
        faces.push(v0, v3, v1, v0, v2, v3);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.setIndex(faces);
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const size = new THREE.Vector3();
    bb.getSize(size);

    return { geom, rows1, cols1, size, bottomZ };
  }

  async function buildOrUpdateMesh() {
    const g = gridRef.current;
    if (!g) return;
    const { lats, lons, Z, shape } = g;
    setBusy("メッシュを生成中…");
    await new Promise((r) => setTimeout(r, 10));

    const { geom, size } = buildSolidGeometry(lats, lons, Z, shape, exaggeration, baseThickness, targetMaxDim);

    if (meshRef.current) {
      sceneRef.current!.remove(meshRef.current);
      (meshRef.current.geometry as THREE.BufferGeometry).dispose();
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = null;
    }

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.8, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    meshRef.current = mesh;
    sceneRef.current!.add(mesh);

    const camera = cameraRef.current!;
    const controls = controlsRef.current!;
    const diag = Math.max(size.x, size.y, size.z);
    const dist = diag * 1.6 + 1;
    camera.position.set(-dist * 0.6, -dist * 0.6, dist * 0.6);
    controls.target.set(size.x * 0.5, size.y * 0.5, size.z * 0.2);
    controls.update();

    setBusy("");
  }

  useEffect(() => {
    if (!gridRef.current) return;
    const t = setTimeout(() => buildOrUpdateMesh(), 100);
    return () => clearTimeout(t);
  }, [exaggeration, baseThickness, targetMaxDim]);

  function exportSTL() {
    if (!meshRef.current) return;
    const scale = unit === "mm" ? 1000 : 1;
    const mesh = meshRef.current.clone();
    mesh.updateMatrixWorld(true);
    const g = mesh.geometry as THREE.BufferGeometry;
    const arr = scalePositionsFromGeometry(g, scale);
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    g2.setIndex(g.getIndex()?.array as any);
    g2.computeVertexNormals();
    const m2 = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    const mesh2 = new THREE.Mesh(g2, m2);
    const exporter = new STLExporter();
    const binary = exporter.parse(mesh2, { binary: true }) as ArrayBuffer;
    const blob = new Blob([binary], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = fileName ? fileName.replace(/\.[^.]+$/, "") : "terrain";
    a.download = `${base}_solid_${unit}.stl`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  type TestResult = { name: string; passed: boolean; detail?: string };
  const [tests, setTests] = useState<TestResult[] | null>(null);

  function runTests() {
    const results: TestResult[] = [];

    try {
      const lats = new Float64Array([0, 0.1, 0.2]);
      const lons = new Float64Array([0, 0.1, 0.2]);
      const Z = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const shape: [number, number] = [3, 3];
      const { geom } = buildSolidGeometry(lats, lons, Z as any, shape, 1, 100, 999);
      const pos = geom.getAttribute("position");
      const idx = geom.getIndex();
      const posCount = pos ? pos.count : 0;
      const idxCount = idx ? idx.count : 0;
      const ok = posCount === 18 && idxCount === 96;
      results.push({ name: "buildSolidGeometry 3x3", passed: ok, detail: `positions=${posCount}, indices=${idxCount}` });
    } catch (e: any) {
      results.push({ name: "buildSolidGeometry 3x3", passed: false, detail: String(e?.message || e) });
    }

    try {
      const a = viridis(0);
      const b = viridis(1);
      const ok = a.every((v) => v >= 0 && v <= 1) && b.every((v) => v >= 0 && v <= 1);
      results.push({ name: "viridis range", passed: ok, detail: `a=${a.map((v) => v.toFixed(3))}, b=${b.map((v) => v.toFixed(3))}` });
    } catch (e: any) {
      results.push({ name: "viridis range", passed: false, detail: String(e?.message || e) });
    }

    try {
      const r = 5000,
        c = 5000;
      const stepY0 = Math.max(1, Math.ceil(r / MAX_DIM));
      const stepX0 = Math.max(1, Math.ceil(c / MAX_DIM));
      const estRows0 = Math.ceil(r / stepY0);
      const estCols0 = Math.ceil(c / stepX0);
      let factor = 1;
      while (estRows0 * estCols0 * 2 > MAX_VERTICES) {
        factor++;
        if (factor > 20) break;
      }
      const stepY = stepY0 * factor;
      const stepX = stepX0 * factor;
      const rows1 = Math.ceil(r / stepY);
      const cols1 = Math.ceil(c / stepX);
      const ok = rows1 * cols1 * 2 <= MAX_VERTICES;
      results.push({ name: "calcSteps vertices cap", passed: ok, detail: `rows1*cols1*2=${rows1 * cols1 * 2}` });
    } catch (e: any) {
      results.push({ name: "calcSteps vertices cap", passed: false, detail: String(e?.message || e) });
    }

    try {
      const geom = new THREE.BufferGeometry();
      const pos = new Float32Array([1, 2, 3, 4, 5, 6]);
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const scaled = scalePositionsFromGeometry(geom, 1000);
      const ok = scaled[0] === 1000 && scaled[1] === 2000 && scaled[2] === 3000 && scaled[3] === 4000;
      results.push({ name: "scalePositionsFromGeometry m→mm", passed: ok, detail: `scaled0=[${scaled.slice(0, 4).join(",")}]` });
    } catch (e: any) {
      results.push({ name: "scalePositionsFromGeometry m→mm", passed: false, detail: String(e?.message || e) });
    }

    try {
      const lats = new Float64Array([0, 0.1]);
      const lons = new Float64Array([0, 0.1]);
      const Z = new Float32Array([-50, -20, -10, -30]);
      const shape: [number, number] = [2, 2];
      const { bottomZ } = buildSolidGeometry(lats as any, lons as any, Z as any, shape, 1, 10, 999);
      const minZ = Math.min(...Array.from(Z));
      const ok = bottomZ < minZ;
      results.push({ name: "negative elevation preserved", passed: ok, detail: `bottomZ=${bottomZ}, minZ=${minZ}` });
    } catch (e: any) {
      results.push({ name: "negative elevation preserved", passed: false, detail: String(e?.message || e) });
    }

    setTests(results);
  }

  const help = (
    <div className="space-y-2 text-sm text-gray-700 leading-relaxed">
      <p className="font-semibold">はじめての方へ（3ステップ）</p>
      <ol className="list-decimal ml-5 space-y-1">
        <li>GEBCOの<strong>サブセットダウンロード</strong>で必要な範囲のNetCDF（*.nc）を取得します。</li>
        <li>下の<strong>ファイルを選択</strong>にドラッグ＆ドロップ、またはクリックしてアップロードします。</li>
        <li>スライダーで<strong>高さの誇張</strong>や<strong>台座の厚み</strong>を調整し、<strong>STLをダウンロード</strong>を押します。</li>
      </ol>
      <p className="text-xs text-gray-500">※ 大きすぎるグリッドは自動で間引きます。推奨は数百万ポリゴン以下。</p>
      <p className="text-xs text-gray-500">※ STLは単位情報を持ちません。一般的なスライサーはmmを既定として扱います（このアプリの既定もmm）。</p>
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-white to-gray-50 text-gray-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/70 border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Topo to STL — シンプル3D地図メーカー</h1>
          <div className="flex items-center gap-3 text-sm">
            {fileName && (
              <span className="px-2 py-1 rounded bg-gray-100 border text-gray-700 truncate max-w-[280px]" title={fileName}>
                {fileName}
              </span>
            )}
            <button
              onClick={() => {
                if (!controlsRef.current || !cameraRef.current || !meshRef.current) return;
                const bb = (meshRef.current.geometry as THREE.BufferGeometry).boundingBox;
                if (!bb) return;
                const size = new THREE.Vector3();
                bb.getSize(size);
                const diag = Math.max(size.x, size.y, size.z);
                const dist = diag * 1.6 + 1;
                cameraRef.current.position.set(-dist * 0.6, -dist * 0.6, dist * 0.6);
                controlsRef.current.target.set(size.x * 0.5, size.y * 0.5, size.z * 0.2);
                controlsRef.current.update();
              }}
              className="px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50"
            >
              ビューをリセット
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="space-y-4 lg:col-span-1">
          <div className="p-4 rounded-2xl border bg-white shadow-sm">
            <h2 className="font-semibold mb-2">1) データを用意</h2>
            <div className="text-sm text-gray-700 mb-3">GEBCOのダウンロードページでNetCDF（*.nc）を取得し、下から読み込んでください。</div>
            <a href="https://download.gebco.net/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white">GEBCO サイトを開く ↗</a>
          </div>

          <div className="p-4 rounded-2xl border bg-white shadow-sm">
            <h2 className="font-semibold mb-2">2) ファイルを選択</h2>
            <label className="block border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:bg-gray-50">
              <input
                type="file"
                accept=".nc,application/x-netcdf,application/netcdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadNetCDF(f);
                }}
              />
              <div className="text-gray-600">ここをクリック、または *.nc をドラッグ＆ドロップ</div>
              <div className="text-xs text-gray-500 mt-1">NetCDF4 (CF準拠) を推奨</div>
            </label>

            {help}

            {latRange && lonRange && (
              <div className="mt-3 text-xs text-gray-600">
                <div>緯度範囲: {latRange[0].toFixed(4)} — {latRange[1].toFixed(4)}</div>
                <div>経度範囲: {lonRange[0].toFixed(4)} — {lonRange[1].toFixed(4)}</div>
                <div>グリッド: {formatNumber(rows)} × {formatNumber(cols)}</div>
                {zMin !== null && zMax !== null && (
                  <div>標高/水深: {Math.round(zMin)} m 〜 {Math.round(zMax)} m</div>
                )}
              </div>
            )}
          </div>

          <div className="p-4 rounded-2xl border bg-white shadow-sm space-y-4">
            <h2 className="font-semibold">3) 可視化を調整</h2>

            <div>
              <label className="text-sm font-medium">縦方向の誇張: <span className="tabular-nums">{exaggeration.toFixed(2)}×</span></label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={exaggeration}
                  onChange={(e) => setExaggeration(parseFloat(e.target.value))}
                  className="flex-1"
                />
                <input
                  type="number"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={Number(exaggeration.toFixed(2))}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value || "0");
                    if (!Number.isNaN(v)) setExaggeration(clamp(v, 0.1, 20));
                  }}
                  className="w-24 px-2 py-1 border rounded"
                />
              </div>
              <div className="flex gap-2 mt-2">{[0.5, 1, 2, 5, 10, 15, 20].map((v) => (
                  <button
                    key={v}
                    onClick={() => setExaggeration(v)}
                    className={`px-2 py-1 rounded border ${exaggeration === v ? "bg-gray-900 text-white" : "bg-white"}`}
                  >
                    {v}×
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">台座の厚み（m） <span className="text-xs text-gray-500">（携行を考え薄め推奨: 5〜30m）</span></label>
              <input type="number" min={0} step={5} value={baseThickness} onChange={(e) => setBaseThickness(clamp(parseFloat(e.target.value || "0"), 0, 10_000))} className="mt-1 w-40 px-2 py-1 border rounded" />
            </div>

            <div>
              <label className="text-sm font-medium">間引き（行/列の最大）</label>
              <input type="range" min={200} max={MAX_DIM} step={50} value={targetMaxDim} onChange={(e) => setTargetMaxDim(parseInt(e.target.value))} className="w-full" />
              <div className="text-xs text-gray-500">値を小さくすると軽くなります（細部は減少）。</div>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-sm font-medium">エクスポート単位</label>
              <select value={unit} onChange={(e) => setUnit(e.target.value as any)} className="px-2 py-1 border rounded">
                <option value="mm">mm（3Dプリンタ向け既定）</option>
                <option value="m">m</option>
              </select>
            </div>

            <button onClick={exportSTL} disabled={!meshRef.current} className={`w-full py-2 rounded-xl text-white ${meshRef.current ? "bg-indigo-600 hover:bg-indigo-700" : "bg-gray-300"}`}>
              STLをダウンロード
            </button>

            {error && <div className="text-red-700 bg-red-50 border border-red-200 rounded-md p-2 text-sm">{error}</div>}
            {busy && <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2 text-sm">{busy}</div>}

            <div className="mt-2">
              <button onClick={() => setShowDebug(!showDebug)} className="text-xs underline text-gray-500">{showDebug ? "開発者ツールを隠す" : "開発者ツールを表示（テスト付き）"}</button>
              {showDebug && (
                <div className="mt-2 p-2 border rounded bg-gray-50">
                  <div className="flex gap-2">
                    <button onClick={runTests} className="px-2 py-1 text-xs rounded border bg-white hover:bg-gray-100">内蔵テストを実行</button>
                    <button onClick={async () => {
                      setDebugMsg("h5wasm インポートを検証中…");
                      try {
                        let ok = false;
                        try { await import("h5wasm"); ok = true; } catch {}
                        if (!ok) {
                          try { await import("h5wasm@0.4.9/dist/esm/hdf5_hl.js"); ok = true; } catch {}
                        }
                        if (!ok) {
                          await importModuleFromUrlAsBlob("https://cdn.jsdelivr.net/npm/h5wasm@0.4.9/dist/esm/hdf5_hl.js");
                          ok = true;
                        }
                        setDebugMsg(ok ? "OK: h5wasm を取得できました" : "NG: h5wasm を取得できません");
                      } catch (e: any) { setDebugMsg("NG: " + (e?.message || String(e))); }
                    }} className="px-2 py-1 text-xs rounded border bg-white hover:bg-gray-100">CDN接続テスト（h5wasm）</button>
                  </div>
                  {tests && (
                    <ul className="mt-2 text-xs space-y-1">{tests.map((t, i) => <li key={i} className={t.passed ? "text-emerald-700" : "text-red-700"}>{t.passed ? "✔" : "✖"} {t.name} — {t.detail}</li>)}</ul>
                  )}
                  {debugMsg && <div className="mt-2 text-xs text-gray-700">{debugMsg}</div>}
                </div>
              )}
            </div>

            <div className="text-xs text-gray-500 mt-2">STLは単位情報を含みません。スライサー側で単位(mm)として扱われます。必要に応じてエクスポート単位を切り替えてください。</div>
          </div>
        </section>

        <section className="lg:col-span-2">
          <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-2 border-b flex items-center justify-between">
              <div className="font-semibold">3Dプレビュー</div>
              <div className="text-xs text-gray-500">Z-up / 回転:ドラッグ / ズーム:ホイール / 移動:右ドラッグ</div>
            </div>
            <div ref={mountRef} className="w-full h-[70vh]" />
          </div>
        </section>
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-10 pt-4 text-xs text-gray-500">
        <p>データ出典の表記例: “GEBCO Compilation Group (2025) GEBCO 2025 Grid (doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29)”。</p>
      </footer>
    </div>
  );
}
