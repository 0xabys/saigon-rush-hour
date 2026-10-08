import * as THREE from 'three';
import { Rng } from '../core/rng';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Light grey speckled asphalt, multiplied by the road material colour. */
export function asphaltTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  const r = new Rng(11);
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const v = 170 + r.int(85);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(r.int(256), r.int(256), 1 + r.int(2), 1 + r.int(2));
  }
  // Patch repairs and oil stains give the street a lived-in look.
  for (let i = 0; i < 10; i++) {
    g.fillStyle = `rgba(120,115,110,${0.12 + r.next() * 0.12})`;
    g.beginPath();
    g.ellipse(r.int(256), r.int(256), 10 + r.int(30), 6 + r.int(14), r.next() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
}

/** Warm cream paving with faint tile joints. */
export function pavingTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  const r = new Rng(23);
  g.fillStyle = '#f2ebdc';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = r.next();
    g.fillStyle = v < 0.5 ? 'rgba(160,140,110,0.10)' : 'rgba(255,255,255,0.18)';
    g.fillRect(r.int(256), r.int(256), 2, 2);
  }
  g.strokeStyle = 'rgba(150,130,100,0.20)';
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  return finish(c);
}

/** Soft grass with clumps. */
export function grassTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  const r = new Rng(37);
  g.fillStyle = '#e9efd8';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = r.next() < 0.5 ? 'rgba(90,130,60,0.10)' : 'rgba(255,255,230,0.12)';
    g.fillRect(r.int(256), r.int(256), 2 + r.int(3), 2 + r.int(3));
  }
  return finish(c);
}

/** Radial glow used for street-lamp pools at night. */
export function glowTexture(inner = 'rgba(255,214,150,1)', outer = 'rgba(255,190,120,0)'): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.4, inner.replace(/[\d.]+\)$/, '0.35)'));
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return finish(c, false);
}

/** Digits 0–9 laid out horizontally for the signal countdown billboards. */
export function digitAtlas(): THREE.CanvasTexture {
  const [c, g] = canvas(640, 128);
  g.clearRect(0, 0, 640, 128);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 112px "JetBrains Mono", ui-monospace, monospace';
  for (let d = 0; d < 10; d++) g.fillText(String(d), d * 64 + 32, 68, 60);
  const t = finish(c, false, false);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Vietnamese P.123b-style "no right turn" plate with "khi đèn đỏ" supplementary panel. */
export function noRightOnRedTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 192);
  g.fillStyle = '#f6f2e8';
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 13;
  g.strokeStyle = '#d23a2a';
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.stroke();
  // Right-turn arrow.
  g.strokeStyle = '#1d1a17';
  g.fillStyle = '#1d1a17';
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(48, 100);
  g.lineTo(48, 58);
  g.lineTo(78, 58);
  g.stroke();
  g.beginPath();
  g.moveTo(92, 58);
  g.lineTo(74, 42);
  g.lineTo(74, 74);
  g.closePath();
  g.fill();
  g.strokeStyle = '#d23a2a';
  g.lineWidth = 11;
  g.beginPath();
  g.moveTo(28, 28);
  g.lineTo(100, 100);
  g.stroke();
  g.fillStyle = '#f6f2e8';
  g.fillRect(8, 132, 112, 52);
  g.strokeStyle = '#1d1a17';
  g.lineWidth = 3;
  g.strokeRect(9.5, 133.5, 109, 49);
  g.fillStyle = '#1d1a17';
  g.font = '700 22px "Be Vietnam Pro", sans-serif';
  g.textAlign = 'center';
  g.fillText('KHI ĐÈN', 64, 154);
  g.fillText('ĐỎ', 64, 177);
  return finish(c, false);
}

/** Shop sign strip: a few hand-lettered Saigon shop names. */
export function signAtlas(): THREE.CanvasTexture {
  const names = ['PHỞ HÒA', 'BÁNH MÌ', 'CÀ PHÊ', 'TIỆM VÀNG', 'NHÀ THUỐC', 'CƠM TẤM', 'HỦ TIẾU', 'TẠP HÓA'];
  const bgs = ['#c8372d', '#e0a33a', '#2c5f9e', '#3f8f5a', '#d96c3a', '#f2e6c8', '#b5302a', '#2f6b6a'];
  const [c, g] = canvas(512, 512);
  names.forEach((n, i) => {
    const y = i * 64;
    g.fillStyle = bgs[i];
    g.fillRect(0, y, 512, 64);
    g.fillStyle = i === 5 ? '#b5302a' : '#fbf6ea';
    g.font = '800 40px "Be Vietnam Pro", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(n, 256, y + 34, 480);
  });
  return finish(c, false);
}

/**
 * Corrugated-sheet site hoarding, one 2.4 m panel across (8 ribs) and 2.4 m tall: grey-scale, multiplied by the
 * panel's vertex colour. Dark rusty skirt at the foot, folded cap at the top, a post seam at both panel edges.
 */
export function corrugatedTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 128;
  const [c, g] = canvas(W, H);
  const r = new Rng(77);
  const rib = W / 8;
  for (let x = 0; x < W; x++) {
    // Each rib is a sine bump: lit flank, crest, shaded flank.
    const k = 0.74 + 0.26 * Math.cos(((x % rib) / rib) * Math.PI * 2 - 0.9);
    g.fillStyle = `hsl(0 0% ${Math.round(k * 100)}%)`;
    g.fillRect(x, 0, 1, H);
  }
  // Weathering: faint vertical streaks and a few scuffs.
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(60,50,40,${0.04 + 0.06 * r.next()})`;
    g.fillRect(r.range(0, W), r.range(0, H * 0.8), r.range(1, 3), r.range(10, 50));
  }
  // Foot (canvas y grows downwards): mud and rust.
  const foot = g.createLinearGradient(0, H * 0.82, 0, H);
  foot.addColorStop(0, 'rgba(120,84,52,0)');
  foot.addColorStop(1, 'rgba(120,84,52,0.75)');
  g.fillStyle = foot;
  g.fillRect(0, H * 0.82, W, H * 0.18);
  // Folded top cap and the post seams.
  g.fillStyle = 'rgba(40,40,44,0.5)';
  g.fillRect(0, 0, W, 5);
  g.fillStyle = 'rgba(40,40,44,0.55)';
  g.fillRect(0, 0, 2, H);
  g.fillRect(W - 2, 0, 2, H);
  return finish(c);
}
