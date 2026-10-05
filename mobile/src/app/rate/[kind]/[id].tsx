import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { RatingReason } from '@/api/feedback';
import { Button, haptic } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';
import { Text } from '@/components/Text';
import { space, useTheme } from '@/theme';

const LOW: RatingReason[] = ['start_failed', 'slow', 'stopped', 'price', 'location'];

/** Post-session 1–5★ with reason chips (Chargefox pattern, spec §4.15); feeds the reliability score ([§14 G9]). */
export default function RateScreen() {
  const { kind, id } = useLocalSearchParams<{ kind: 'charge' | 'roaming'; id: string }>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const [stars, setStars] = useState(0);
  const [reasons, setReasons] = useState<RatingReason[]>([]);
  const m = useMutation({ mutationFn: () => api.feedback.rate(kind === 'roaming' ? 'roaming' : 'charge', id!, stars, stars >= 4 ? ['great'] : reasons) });
  if (m.data) {
    return (
      <Screen back modal>
        <EmptyState icon="star" title={t('rate.thanks')} body={m.data === 'unsupported' ? t('rate.savedLater') : undefined} action={t('common.close')} onAction={() => router.back()} />
      </Screen>
    );
  }
  return (
    <Screen back modal title={t('rate.title')} footer={<Button label={t('rate.send')} disabled={!stars} loading={m.isPending} onPress={() => m.mutate()} testID="rate-send" />}>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.sm }} accessibilityRole="adjustable" accessibilityLabel={t('rate.a11y', { n: stars })}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => { haptic('selection'); setStars(n); }} accessibilityRole="button" accessibilityLabel={t('rate.star', { n })} hitSlop={6} style={{ padding: 6 }} testID={`star-${n}`}>
            <Icon name="star" size={40} color={n <= stars ? c.warning : c.lineStrong} fill={n <= stars ? c.warning : 'none'} />
          </Pressable>
        ))}
      </View>
      <Text align="center" tone="muted">
        {stars ? t(`rate.label.${stars}`) : t('rate.prompt')}
      </Text>
      {stars > 0 && stars < 4 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'center' }}>
          {LOW.map((r) => (
            <Chip key={r} label={t(`rate.reason.${r}`)} selected={reasons.includes(r)} onPress={() => setReasons(reasons.includes(r) ? reasons.filter((x) => x !== r) : [...reasons, r])} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}
