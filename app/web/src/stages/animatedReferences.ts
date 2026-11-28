export const MAX_REFERENCE_IMAGES = 2;
export const MAX_REFERENCE_BYTES = 200 * 1024;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_IMAGE_EDGE = 768;

export interface SceneReferenceImage {
  label: string;
  mime: 'image/jpeg';
  base64: string;
}

function isSupportedImage(b: Uint8Array): boolean {
  return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    || (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10)
    || (b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80);
}

async function imageSource(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch { /* Some Safari builds decode more formats in HTMLImageElement. */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('The browser could not open this image. Choose a valid PNG, JPEG, or WebP.');
  }
}

const jpegBlob = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

/** Only the downsized preview is returned or transferred; original bytes/metadata remain local. */
export async function prepareSceneReference(file: File): Promise<SceneReferenceImage> {
  if (!file.size || file.size > MAX_INPUT_BYTES) throw new Error('Choose a reference under 12 MiB.');
  if (!isSupportedImage(new Uint8Array(await file.slice(0, 12).arrayBuffer()))) throw new Error('Choose a PNG, JPEG, or WebP reference.');
  const decoded = await imageSource(file);
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_IMAGE_PIXELS) throw new Error('Use a reference under 32 megapixels.');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Image resize is unavailable in this browser.');
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(decoded.width, decoded.height));
    for (let pass = 0; pass < 4; pass++) {
      canvas.width = Math.max(1, Math.floor(decoded.width * scale));
      canvas.height = Math.max(1, Math.floor(decoded.height * scale));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.72, 0.56, 0.42]) {
        const blob = await jpegBlob(canvas, quality);
        if (blob?.type !== 'image/jpeg' || blob.size > MAX_REFERENCE_BYTES) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const label = [...file.name.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, 64).join('') || 'Reference image';
        return { label, mime: 'image/jpeg', base64: btoa(binary) };
      }
      scale *= 0.8;
    }
    throw new Error('This image could not be compressed below 200 KiB. Crop it or choose a smaller reference.');
  } finally {
    decoded.release();
  }
}

/** Parse without injecting the supplied SVG into the page. Only editable top-level groups are displayed. */
export function topLevelSvgGroups(svg?: string): string[] {
  if (!svg) return [];
  const NS = 'http://www.w3.org/2000/svg';
  const root = new DOMParser().parseFromString(svg, 'application/xml').documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== NS) return [];
  return Array.from(new Set(Array.from(root.children)
    .filter((n) => n.localName === 'g' && n.namespaceURI === NS)
    .map((n) => n.getAttribute('id') ?? '')
    .filter((id) => id.length && id.length <= 100)));
}
