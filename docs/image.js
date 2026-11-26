// Shrinks photos in the browser before saving, so storage and data use stay small.
const PHOTO_SIDE = 1280;
const PHOTO_MAX = 400000; // characters of base64 (~300 KB)
const THUMB_SIDE = 160;
const THUMB_MAX = 30000;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unsupported')); };
    img.src = url;
  });
}

let webp; // can this browser's canvas encode WebP? (Safari often cannot)
function encode(canvas, q) {
  if (webp !== false) {
    const s = canvas.toDataURL('image/webp', q);
    if (s.startsWith('data:image/webp')) { webp = true; return s; }
    webp = false;
  }
  return canvas.toDataURL('image/jpeg', q);
}

function draw(img, side) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, side / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background in JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function fit(img, side, max, qualities) {
  for (let s = side; s >= 64; s = Math.round(s * 0.75)) {
    const c = draw(img, s);
    for (const q of qualities) {
      const d = encode(c, q);
      if (d.length <= max) return d;
    }
  }
  return null;
}

export async function compress(file) {
  if (!file || (file.type && !file.type.startsWith('image/'))) throw new Error('not-image');
  const img = await loadImage(file);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('unsupported');
  const photo = fit(img, PHOTO_SIDE, PHOTO_MAX, [0.82, 0.72, 0.6, 0.5]);
  const thumb = fit(img, THUMB_SIDE, THUMB_MAX, [0.7, 0.5]);
  if (!photo || !thumb) throw new Error('too-big');
  return { photo, thumb };
}
