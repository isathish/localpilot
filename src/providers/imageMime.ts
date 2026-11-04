/** The image type of base64 data, sniffed from its header (attachments may be PNG, JPEG, GIF or WebP); PNG when unknown. */
export function imageMime(b64: string): string {
  if (b64.startsWith('/9j/')) {
    return 'image/jpeg';
  }
  if (b64.startsWith('iVBORw0KGgo')) {
    return 'image/png';
  }
  if (b64.startsWith('R0lGOD')) {
    return 'image/gif';
  }
  if (b64.startsWith('UklGR') && Buffer.from(b64.slice(0, 16), 'base64').subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return 'image/png';
}
