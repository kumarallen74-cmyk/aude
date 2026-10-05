import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@/theme';

/**
 * The PlugSure mark: the charge ring (300° arc) around a bolt, on the badge colour.
 * Same geometry as the app icon (scripts/generate-assets.mjs) so in-app and launcher read as one brand.
 */
export function Logo({ size = 44, plain }: { size?: number; plain?: boolean }) {
  const { c } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <LinearGradient id="lg-bg" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#13323a" />
          <Stop offset="1" stopColor={c.badge} />
        </LinearGradient>
        <LinearGradient id="lg-acc" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={c.fill} />
          <Stop offset="1" stopColor={c.deep} />
        </LinearGradient>
      </Defs>
      {plain ? null : <Rect x="0" y="0" width="100" height="100" rx="24" fill="url(#lg-bg)" />}
      <Circle cx="50" cy="50" r="31" fill="none" stroke="url(#lg-acc)" strokeWidth="8" strokeLinecap="round" strokeDasharray="162.3 194.8" transform="rotate(120 50 50)" />
      <Path d="M54.5 26 L36 54 H49 L45.5 74 L64 46 H51 Z" fill={c.fill} />
    </Svg>
  );
}
