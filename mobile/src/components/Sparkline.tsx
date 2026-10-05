import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { useTheme } from '@/theme';

/** Power over time while charging. */
export function Sparkline({ data, width = 300, height = 56 }: { data: number[]; width?: number; height?: number }) {
  const { c } = useTheme();
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const pts = data.map((d, i) => [(i / (data.length - 1)) * width, height - ((d - min) / (max - min || 1)) * (height - 6) - 3] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <Svg width={width} height={height} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <LinearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c.fill} stopOpacity={0.35} />
          <Stop offset="1" stopColor={c.fill} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={area} fill="url(#spark)" />
      <Path d={line} stroke={c.fill} strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}
