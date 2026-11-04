/**
 * Attachment limits and an image-dimension reader that only looks at the header (PNG, JPEG, GIF, WebP), so an
 * oversized image is refused before it is decoded or sent. No `vscode` import (used by the smoke test).
 */

/** Images plus files in one message. */
export const MAX_ATTACHMENTS = 20;
/** Longest side of an attached image, in pixels. */
export const MAX_IMAGE_SIDE = 7680;

export interface ImageSize {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif' | 'webp';
}

export function imageSize(b: Uint8Array): ImageSize | undefined {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    return { width: u32be(16), height: u32be(20), format: 'png' };
  }
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { width: u16le(6), height: u16le(8), format: 'gif' };
  }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') {
      return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), format: 'webp' };
    }
    if (chunk === 'VP8 ') {
      return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff, format: 'webp' };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: 'webp' };
    }
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first start-of-frame (SOF0–SOF15, except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        return undefined;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(i + 7), height: u16be(i + 5), format: 'jpeg' };
      }
      if (marker === 0xd9 || marker === 0xda) {
        return undefined;
      }
      i += 2 + u16be(i + 2);
    }
  }
  return undefined;
}

/** Why an image cannot be attached, or undefined when it can (unknown formats pass: the header could not be read). */
export function imageTooLarge(name: string, b: Uint8Array): string | undefined {
  const s = imageSize(b);
  return s && Math.max(s.width, s.height) > MAX_IMAGE_SIDE
    ? `${name} is ${s.width}×${s.height} px; images may be at most ${MAX_IMAGE_SIDE} px on a side`
    : undefined;
}
