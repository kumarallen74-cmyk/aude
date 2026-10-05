import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space, useTheme } from '@/theme';

/** Shimmer placeholder; static when the OS asks to reduce motion. */
export function Skeleton({ width = '100%', height = 16, r = radius.sm, style }: { width?: DimensionValue; height?: number; r?: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const [v] = useState(() => new Animated.Value(0.55));
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (reduce || cancelled) return;
        loop = Animated.loop(
          Animated.sequence([
            Animated.timing(v, { toValue: 1, duration: 650, useNativeDriver: true }),
            Animated.timing(v, { toValue: 0.55, duration: 650, useNativeDriver: true }),
          ]),
        );
        loop.start();
      });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [v]);
  return <Animated.View style={[{ width, height, borderRadius: r, backgroundColor: c.raised, opacity: v }, style]} />;
}

export function SkeletonList({ rows = 4, testID }: { rows?: number; testID?: string }) {
  const { c } = useTheme();
  return (
    <View testID={testID} accessibilityLabel="Loading" accessibilityRole="progressbar" style={{ gap: space.md }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={[styles.row, { backgroundColor: c.surface, borderColor: c.line }]}>
          <Skeleton width={48} height={48} r={radius.md} />
          <View style={{ flex: 1, gap: space.sm }}>
            <Skeleton width="70%" height={16} />
            <Skeleton width="45%" height={12} />
          </View>
          <Skeleton width={56} height={20} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
});
