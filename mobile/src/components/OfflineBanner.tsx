import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOnline } from '@/state/network';
import { radius, space, useTheme } from '@/theme';
import { Icon } from './Icon';
import { Text } from './Text';

/** Global "no connection" banner (spec §6.12); cached data stays visible underneath. */
export function OfflineBanner() {
  const online = useOnline();
  const { c } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  if (online) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ position: 'absolute', top: insets.top + space.xs, left: space.lg, right: space.lg, zIndex: 50, flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: c.text, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill }}
    >
      <Icon name="offline" size={16} color={c.bg} />
      <Text variant="footnote" color={c.bg} style={{ flex: 1 }}>
        {t('offline.banner')}
      </Text>
    </View>
  );
}
