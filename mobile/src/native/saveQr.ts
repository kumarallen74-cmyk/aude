import { Platform } from 'react-native';

/**
 * "Save QR" (spec §6.5): many wallets can only pay a QRIS / PayNow code from the gallery when the driver pays on the
 * same phone. The backend sends the code as a PNG data URI (`qr.qrPng`); it is written to the cache and added to the
 * photo library with WRITE-ONLY access (iOS "Add Photos Only", NSPhotoLibraryAddUsageDescription; Android 11+ needs
 * no permission to add to MediaStore, Android 8–10 WRITE_EXTERNAL_STORAGE — plugins/withSaveQrPermission.js). The
 * screen shows a rationale before the system prompt (`needsRationale`).
 */
export type SaveQrResult = 'saved' | 'denied' | 'unsupported' | 'error';

/** `data:image/png;base64,…` → the base64 body (null when it is not a PNG/GIF data URI). */
export function base64FromDataUri(uri: string): { base64: string; ext: 'png' | 'gif' } | null {
  const m = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(uri.trim());
  return m ? { base64: m[2]!, ext: m[1] as 'png' | 'gif' } : null;
}

/** A safe file name for the saved code. */
export function qrFileName(ref: string, ext: 'png' | 'gif'): string {
  return `qr-${ref.replace(/[^\w-]/g, '').slice(0, 40) || 'payment'}.${ext}`;
}

/** true when the system prompt has not been answered yet (show the in-app rationale first). */
export async function needsRationale(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const ML = await import('expo-media-library');
  const p = await ML.getPermissionsAsync(true, ['photo']);
  return !p.granted && p.canAskAgain;
}

export async function saveQrToPhotos(dataUri: string, ref: string): Promise<SaveQrResult> {
  const img = base64FromDataUri(dataUri);
  if (!img) return 'error';
  if (Platform.OS === 'web') {
    // Web preview: a download of the same image.
    if (typeof document === 'undefined') return 'unsupported';
    const a = document.createElement('a');
    a.href = dataUri;
    a.download = qrFileName(ref, img.ext);
    a.click();
    return 'saved';
  }
  try {
    const [ML, FS] = await Promise.all([import('expo-media-library'), import('expo-file-system')]);
    let p = await ML.getPermissionsAsync(true, ['photo']);
    if (!p.granted && p.canAskAgain) p = await ML.requestPermissionsAsync(true, ['photo']);
    if (!p.granted) return 'denied';
    const file = new FS.File(FS.Paths.cache, qrFileName(ref, img.ext));
    if (file.exists) file.delete();
    file.create();
    file.write(img.base64, { encoding: 'base64' });
    await ML.Asset.create(file.uri);
    return 'saved';
  } catch {
    return 'error';
  }
}
