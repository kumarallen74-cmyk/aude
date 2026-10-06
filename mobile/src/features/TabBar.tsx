import type { BottomTabBarProps } from 'expo-router/tabs';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { haptic } from '@/components/Button';
import { Icon, type IconName } from '@/components/Icon';
import { Text } from '@/components/Text';
import { useActiveCharge } from '@/state/activeCharge';
import { pendingHref, usePendingCheckout } from '@/state/checkout';
import { radius, space, useTheme } from '@/theme';

const TABS: Record<string, { icon: IconName; label: string }> = {
  index: { icon: 'map', label: 'tabs.map' },
  activity: { icon: 'activity', label: 'tabs.activity' },
  account: { icon: 'user', label: 'tabs.account' },
};

/** Bottom bar: Map · [Scan] · Activity · Account — Scan is a centre action, not a destination (spec §5). */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { c, shadow } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const active = useActiveCharge();
  // A payment left open (the app was closed on the bank's page, or killed after paying): resume it — the payment
  // screen polls, and starts the charge once the payment is confirmed.
  const pending = usePendingCheckout();
  const routes = state.routes.filter((r) => TABS[r.name]);
  const left = routes.slice(0, 1);
  const right = routes.slice(1);

  const item = (r: (typeof routes)[number]) => {
    const i = state.routes.indexOf(r);
    const focused = state.index === i;
    const meta = TABS[r.name]!;
    return (
      <Pressable
        key={r.key}
        testID={`tab-${r.name}`}
        accessibilityRole="tab"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={t(meta.label)}
        onPress={() => {
          haptic('selection');
          const e = navigation.emit({ type: 'tabPress', target: r.key, canPreventDefault: true });
          if (!focused && !e.defaultPrevented) navigation.navigate(r.name, r.params);
        }}
        style={styles.tab}
      >
        <View style={[styles.tabIcon, focused && { backgroundColor: c.accentSoft }]}>
          <Icon name={meta.icon} size={22} color={focused ? c.accent : c.textMuted} />
        </View>
        <Text variant="caption" color={focused ? c.accent : c.textMuted} numberOfLines={1}>
          {t(meta.label)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View pointerEvents="box-none">
      {active ? (
        <Pressable
          testID="session-pill"
          accessibilityRole="button"
          accessibilityLabel={t('pill.a11y', { site: active.siteName })}
          onPress={() => router.push(`/session/${active.kind}/${active.id}`)}
          style={[styles.pill, shadow(2), { backgroundColor: c.fill }]}
        >
          <View style={[styles.pulse, { backgroundColor: c.on }]} />
          <Text variant="footnote" color={c.on} style={{ flex: 1, fontFamily: 'PlusJakartaSans_700Bold' }} numberOfLines={1}>
            {t('pill.charging', { site: active.siteName })}
          </Text>
          <Icon name="chevron" size={18} color={c.on} />
        </Pressable>
      ) : pending ? (
        <Pressable
          testID="payment-pill"
          accessibilityRole="button"
          accessibilityLabel={t('pill.paymentA11y', { site: pending.siteName })}
          onPress={() => router.push(pendingHref(pending) as never)}
          style={[styles.pill, shadow(2), { backgroundColor: c.fill }]}
        >
          <Icon name="card" size={18} color={c.on} />
          <Text variant="footnote" color={c.on} style={{ flex: 1, fontFamily: 'PlusJakartaSans_700Bold' }} numberOfLines={1}>
            {t('pill.payment', { site: pending.siteName })}
          </Text>
          <Icon name="chevron" size={18} color={c.on} />
        </Pressable>
      ) : null}
      <View style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.line, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        {left.map(item)}
        <View style={styles.tab}>
          <Pressable
            testID="tab-scan"
            accessibilityRole="button"
            accessibilityLabel={t('tabs.scan')}
            accessibilityHint={t('tabs.scanHint')}
            onPress={() => {
              haptic('medium');
              router.push('/scan');
            }}
            style={({ pressed }) => [styles.fab, shadow(2), { backgroundColor: c.fill, borderColor: c.surface, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
          >
            <Icon name="scan" size={28} color={c.on} strokeWidth={2.4} />
          </Pressable>
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {t('tabs.scan')}
          </Text>
        </View>
        {right.map(item)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.xs },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', minHeight: 56, gap: 2 },
  tabIcon: { width: 56, height: 30, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  fab: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginTop: -26, borderWidth: 4 },
  pill: { marginHorizontal: space.lg, marginBottom: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, minHeight: 48, borderRadius: radius.pill },
  pulse: { width: 8, height: 8, borderRadius: 4 },
});
