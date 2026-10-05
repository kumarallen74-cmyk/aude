import { Pressable, StyleSheet, View } from 'react-native';
import { radius, space, useTheme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success' | 'accent' | 'neutral';

export function Banner({ tone = 'info', title, body, icon, action, onPress, testID }: { tone?: BannerTone; title?: string; body?: string; icon?: IconName; action?: string; onPress?: () => void; testID?: string }) {
  const { c } = useTheme();
  const map: Record<BannerTone, [string, string, IconName]> = {
    info: [c.infoSoft, c.info, 'info'],
    warning: [c.warningSoft, c.warning, 'warning'],
    danger: [c.dangerSoft, c.danger, 'alert'],
    success: [c.successSoft, c.success, 'badgeCheck'],
    accent: [c.accentSoft, c.accent, 'bolt'],
    neutral: [c.raised, c.textMuted, 'info'],
  };
  const [bg, fg, defIcon] = map[tone];
  const content = (
    <View style={[styles.wrap, { backgroundColor: bg }]} testID={testID} accessibilityRole={onPress ? 'button' : 'alert'}>
      <Icon name={icon ?? defIcon} size={20} color={fg} />
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text variant="bodyStrong" color={tone === 'neutral' ? c.text : fg}>{title}</Text> : null}
        {body ? <Text variant="footnote" tone="muted" style={{ color: c.text, opacity: 0.86 }}>{body}</Text> : null}
      </View>
      {action ? (
        <Text variant="footnote" color={fg} style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
          {action}
        </Text>
      ) : null}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={[title, body, action].filter(Boolean).join('. ')} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md + 2, borderRadius: radius.md },
});
