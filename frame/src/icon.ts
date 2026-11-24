// The menu bar's icon: the grid's four tiles, their corners round as vindu's icon has them, drawn here at 16 points (two
// pixels a point), their edges smoothed. On a Mac, a template image, which the system colours for its light or dark menu
// bar; elsewhere, light tiles with one in the shell's accent, for a taskbar that is dark or light.
import { nativeImage, type NativeImage } from 'electron';

/** The icon's pixels, 32 by 32, BGRA with each colour times its alpha (as Electron's bitmaps are). */
export function trayPixels(mac: boolean): Buffer {
  const size = 32, side = 10.5, round = 3, px = Buffer.alloc(size * size * 4);
  /** How much of the pixel at x, y a tile covers, its corner at x0, y0. */
  const cover = (x0: number, y0: number, x: number, y: number) => {
    const h = side / 2 - round, dx = Math.max(Math.abs(x - (x0 + side / 2)) - h, 0), dy = Math.max(Math.abs(y - (y0 + side / 2)) - h, 0);
    return Math.min(1, Math.max(0, round + 0.5 - Math.hypot(dx, dy)));
  };
  const ink = mac ? [0, 0, 0] : [0xec, 0xef, 0xf0], accent = mac ? ink : [0xe5, 0x87, 0x39]; // BGR: light, and the shell's blue
  const tiles: [number, number, number[]][] = [[4, 4, ink], [17.5, 4, ink], [4, 17.5, ink], [17.5, 17.5, accent]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (const [x0, y0, c] of tiles) {
    const a = cover(x0, y0, x + 0.5, y + 0.5); if (!a) continue;
    const i = (y * size + x) * 4; px[i] = Math.round(c[0] * a); px[i + 1] = Math.round(c[1] * a); px[i + 2] = Math.round(c[2] * a); px[i + 3] = Math.round(a * 255);
  }
  return px;
}

export function trayIcon(): NativeImage {
  const mac = process.platform === 'darwin';
  const icon = nativeImage.createFromBitmap(trayPixels(mac), { width: 32, height: 32, scaleFactor: 2 });
  if (mac) icon.setTemplateImage(true);
  return icon;
}
