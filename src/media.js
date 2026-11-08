const THUMB = 240;

/** A small square JPEG made on the phone, uploaded before the full clip. */
export async function makeThumbnail(file) {
  const source = file.type.startsWith('video/') ? await videoFrame(file) : await imageSource(file);
  const { el, w, h } = source;
  const side = Math.min(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = THUMB;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(el, (w - side) / 2, (h - side) / 2, side, side, 0, 0, THUMB, THUMB);
  source.done?.();
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not make thumbnail'))), 'image/jpeg', 0.75));
}

async function imageSource(file) {
  // createImageBitmap respects EXIF orientation in current Safari and Chrome.
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { el: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch {}
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { el: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

function videoFrame(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    const fail = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the video')); };
    v.onerror = fail;
    v.onloadeddata = () => { v.currentTime = Math.min(0.3, (v.duration || 1) / 2); };
    v.onseeked = () => resolve({
      el: v, w: v.videoWidth, h: v.videoHeight, done: () => URL.revokeObjectURL(url),
    });
    // iOS sometimes won't decode a frame until play() is called.
    v.play?.().then(() => v.pause()).catch(() => {});
    setTimeout(() => v.readyState < 2 && fail(), 15000);
  });
}

export function extFor(type) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp',
  };
  return map[type] || (type.split('/')[1] || 'bin');
}

/**
 * Save to the camera roll. The share sheet is the only web route into Photos:
 * iOS shows "Save Image"/"Save Video", Android shows "Save to device"/Photos.
 * Must run from a tap. Falls back to a normal download.
 */
export async function saveFiles(files) {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      console.warn('share failed, downloading instead', e);
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  return 'downloaded';
}
