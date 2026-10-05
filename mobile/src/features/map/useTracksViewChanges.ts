import { useEffect, useState } from 'react';

/**
 * react-native-maps on Android draws a custom marker view into a bitmap. With `tracksViewChanges` off from the start
 * the bitmap can be captured before the view (fonts, icon) has laid out — a blank or clipped pin; left on, every
 * marker re-renders every frame and panning stutters. So: on for the first `ms` after mount and after each change of
 * what the pin shows (`signature`), then off.
 */
export function useTracksViewChanges(signature: string, ms = 500): boolean {
  const [tracking, setTracking] = useState(true);
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    // A different pin (availability, selection, theme…): capture it again.
    setSeen(signature);
    setTracking(true);
  }
  useEffect(() => {
    if (!tracking) return;
    const h = setTimeout(() => setTracking(false), ms);
    return () => clearTimeout(h);
  }, [tracking, signature, ms]);
  return tracking;
}
