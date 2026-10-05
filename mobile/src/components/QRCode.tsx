import qrcodeGenerator from 'qrcode-generator';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

/**
 * QRIS / PayNow QR rendered natively from the `qrString` (spec §6.5) — crisp at any size, no image download.
 * Always dark-on-white with a 4-module quiet zone so strict bank-app decoders read it, also in dark mode.
 */
export function QRCode({ value, size = 260, label }: { value: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcodeGenerator(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(r, col)) d += `M${col + 4},${r + 4}h1v1h-1z`;
      }
    }
    return { path: d, count: n + 8 };
  }, [value]);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ backgroundColor: '#fff', borderRadius: 16, padding: 4 }}>
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Rect x={0} y={0} width={count} height={count} fill="#ffffff" />
        <Path d={path} fill="#0a1417" />
      </Svg>
    </View>
  );
}
