import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';
import { ChargeRing } from '@/components/ChargeRing';
import { Icon, type IconName } from '@/components/Icon';
import { Logo } from '@/components/Logo';
import { Text } from '@/components/Text';
import { brand } from '@/config';
import { settingsStore } from '@/state/settings';
import { radius, space, useTheme } from '@/theme';

/** Two cards, Skip always visible, no sign-up wall (spec §6.1). Permissions are asked later, in context. */
export default function Onboarding() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [step, setStep] = useState(0);
  const finish = () => {
    settingsStore.set({ onboarded: true });
    router.replace('/');
  };
  const cards: { title: string; body: string; icons: IconName[] }[] = [
    { title: t('onboarding.networks.title'), body: t('onboarding.networks.body'), icons: ['map', 'route', 'shield'] },
    { title: t('onboarding.pay.title'), body: t('onboarding.pay.body'), icons: ['qr', 'wallet', 'card'] },
  ];
  const card = cards[step]!;
  return (
    <View style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.lg }]} testID="onboarding">
      <View style={styles.top}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Logo size={36} />
          <Text variant="title3">{brand.appName}</Text>
        </View>
        <Button label={t('onboarding.skip')} variant="ghost" size="sm" full={false} onPress={finish} testID="onboarding-skip" />
      </View>
      <View style={styles.hero}>
        <ChargeRing size={Math.min(260, width - 96)} value={step === 0 ? 0.62 : 1} stroke={18}>
          <View style={styles.icons}>
            {card.icons.map((i, n) => (
              <View key={i} style={[styles.iconBubble, { backgroundColor: n === 1 ? c.fill : c.surface, borderColor: c.line, transform: [{ translateY: n === 1 ? -12 : 0 }] }]}>
                <Icon name={i} size={n === 1 ? 34 : 24} color={n === 1 ? c.on : c.accent} />
              </View>
            ))}
          </View>
        </ChargeRing>
      </View>
      <View style={{ gap: space.md, paddingHorizontal: space.xl }}>
        <Text variant="display" accessibilityRole="header">
          {card.title}
        </Text>
        <Text variant="body" tone="muted" style={{ fontSize: 17, lineHeight: 25 }}>
          {card.body}
        </Text>
      </View>
      <View style={{ paddingHorizontal: space.xl, gap: space.lg }}>
        <View style={styles.dots} accessibilityLabel={t('onboarding.progress', { n: step + 1, total: cards.length })}>
          {cards.map((_, i) => (
            <View key={i} style={[styles.dot, { backgroundColor: i === step ? c.fill : c.lineStrong, width: i === step ? 24 : 8 }]} />
          ))}
        </View>
        <Button label={step < cards.length - 1 ? t('onboarding.next') : t('onboarding.start')} iconRight={step < cards.length - 1 ? 'chevron' : undefined} icon={step === cards.length - 1 ? 'bolt' : undefined} onPress={() => (step < cards.length - 1 ? setStep(step + 1) : finish())} testID="onboarding-next" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'space-between' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.lg },
  hero: { alignItems: 'center', justifyContent: 'center', flex: 1, maxHeight: 360 },
  icons: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  iconBubble: { width: 64, height: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth * 2 },
  dots: { flexDirection: 'row', gap: 6, justifyContent: 'center' },
  dot: { height: 8, borderRadius: 4 },
});
