import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';

/**
 * The PlugSure ring — the brand motif (app icon, splash, live session): a 300° arc that fills with charge.
 * `value` 0..1, or null for an indeterminate "breathing" ring.
 */
export function ChargeRing({ size = 220, stroke = 14, value, children, style, color }: { size?: number; stroke?: number; value: number | null; children?: React.ReactNode; style?: StyleProp<ViewStyle>; color?: string }) {
  const { c } = useTheme();
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const arc = circ * (300 / 360);
  const v = value == null ? 0.18 : Math.max(0, Math.min(1, value));
  const accent = color ?? c.fill;
  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '120deg' }] }}>
        <Defs>
          <LinearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={accent} stopOpacity={1} />
            <Stop offset="1" stopColor={c.deep} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.raised} strokeWidth={stroke} fill="none" strokeDasharray={`${arc} ${circ}`} strokeLinecap="round" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="url(#ring)" strokeWidth={stroke} fill="none" strokeDasharray={`${arc * v} ${circ}`} strokeLinecap="round" />
      </Svg>
      {children}
    </View>
  );
}
