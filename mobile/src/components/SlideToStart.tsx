import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { radius, space, useTheme } from '@/theme';
import { Button, haptic } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

const KNOB = 56;

/**
 * "Slide to start" (avoids accidental taps that cost money, spec §6.4) with a full-width button alternative:
 * screen readers, the "simple start" setting, and WCAG 2.5.7 (dragging movements) all get the button.
 */
export function SlideToStart({ label, onComplete, disabled, loading, simple, testID }: { label: string; onComplete: () => void; disabled?: boolean; loading?: boolean; simple?: boolean; testID?: string }) {
  const { c } = useTheme();
  const [width, setWidth] = useState(0);
  const [srOn, setSrOn] = useState(false);
  const [x] = useState(() => new Animated.Value(0));
  const max = Math.max(0, width - KNOB - 8);

  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setSrOn).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setSrOn);
    return () => sub.remove();
  }, []);

  const responder = useMemo(() => {
    const gesture = { done: false };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: (_, g) => !disabled && Math.abs(g.dx) > 4,
      onPanResponderGrant: () => haptic('selection'),
      onPanResponderMove: (_, g) => x.setValue(Math.max(0, Math.min(max, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (g.dx >= max * 0.86 && !gesture.done) {
          gesture.done = true;
          haptic('success');
          Animated.timing(x, { toValue: max, duration: 90, useNativeDriver: false }).start(() => {
            onComplete();
            setTimeout(() => {
              gesture.done = false;
              x.setValue(0);
            }, 900);
          });
        } else {
          Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
        }
      },
    });
  }, [disabled, max, onComplete, x]);

  if (simple || srOn || loading) {
    return <Button testID={testID} label={label} icon="bolt" onPress={onComplete} disabled={disabled} loading={loading} />;
  }
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityActions={[{ name: 'activate', label }]}
      onAccessibilityAction={() => !disabled && onComplete()}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: c.accentSoft, borderColor: c.line, opacity: disabled ? 0.5 : 1 }]}
    >
      <Animated.View style={[styles.fill, { backgroundColor: c.fill, width: Animated.add(x, KNOB + 8), opacity: 0.25 }]} />
      <Text variant="button" color={c.accent} align="center" style={{ position: 'absolute', left: KNOB + space.lg, right: space.lg }}>
        {label}
      </Text>
      <Animated.View {...responder.panHandlers} style={[styles.knob, { width: KNOB, height: KNOB, backgroundColor: c.fill, transform: [{ translateX: x }] }]}>
        <Icon name="bolt" size={26} color={c.on} fill={c.on} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 64, borderRadius: radius.pill, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: radius.pill },
  knob: { position: 'absolute', left: 4, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
});
