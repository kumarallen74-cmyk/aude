import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatDistance, formatKw } from '@/lib/format';
import { formatRate, taxLabelKey } from '@/lib/money';
import type { MapStation } from '@/lib/stationModel';
import { radius, space, useTheme } from '@/theme';
import { Card } from './Card';
import { Icon } from './Icon';
import { availabilityVisual, ReliabilityBadge } from './Status';
import { Text } from './Text';

export function availabilityText(t: (k: string, o?: Record<string, unknown>) => string, s: Pick<MapStation, 'availableCount' | 'totalCount' | 'availability'>): string {
  if (s.availability === 'offline') return t('station.offline');
  if (s.availability === 'fault' && s.availableCount === 0) return t('station.outOfOrder');
  if (s.availability === 'unknown') return t('station.statusUnknown');
  return t('station.availableOf', { available: s.availableCount, total: s.totalCount });
}

/** One station in lists: availability (colour + icon + text), power, network, distance, price with tax label. */
export function StationRow({ s, onPress, stale, testID }: { s: MapStation; onPress?: () => void; stale?: boolean; testID?: string }) {
  const { c } = useTheme();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const vis = availabilityVisual(stale ? 'unknown' : s.availability, c);
  const avail = stale ? t('station.statusUnknown') : availabilityText(t, s);
  const current = s.currents.includes('DC') ? 'DC' : 'AC';
  const a11y = [
    s.name,
    avail,
    s.maxPowerKw ? `${formatKw(s.maxPowerKw, lang)} ${current}` : null,
    s.priceFromMajor != null ? t('station.a11yPrice', { price: formatRate(s.priceFromMajor, s.currency, lang) }) : null,
    s.kind === 'partner' ? t('station.partnerNetwork', { operator: s.operator }) : s.operator,
    s.distanceKm != null ? formatDistance(s.distanceKm, lang) : null,
  ]
    .filter(Boolean)
    .join(', ');
  const meta = [avail, `${formatKw(s.maxPowerKw, lang)} ${current}`, s.distanceKm != null ? formatDistance(s.distanceKm, lang) : null].filter(Boolean) as string[];
  return (
    <Card onPress={onPress} accessibilityLabel={a11y} testID={testID} style={styles.card}>
      <View style={[styles.badge, { backgroundColor: vis.color + '1f', borderColor: vis.color + '55' }]}>
        <Icon name={vis.icon} size={18} color={vis.color} strokeWidth={2.6} />
        <Text variant="caption" color={vis.color} style={{ fontFamily: 'Sora_700Bold', fontSize: 11 }} maxFontSizeMultiplier={1.3}>
          {s.maxPowerKw ? Math.round(s.maxPowerKw) : '–'}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="title3" numberOfLines={2}>
          {s.name}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={2}>
          <Text variant="footnote" color={vis.color} style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
            {meta[0]}
          </Text>
          {meta.slice(1).map((m) => `  ·  ${m}`).join('')}
        </Text>
        <View style={styles.bottom}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', gap: space.xs + 2, alignItems: 'center' }}>
            {s.kind === 'partner' ? (
              <View style={[styles.net, { backgroundColor: c.infoSoft }]}>
                <Icon name="route" size={12} color={c.info} />
                <Text variant="caption" color={c.info} numberOfLines={1}>
                  {s.operator}
                </Text>
              </View>
            ) : (
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {s.operator}
              </Text>
            )}
            <ReliabilityBadge r={s.reliability} compact />
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {s.priceFromMajor != null ? (
              <Text variant="bodyStrong" style={{ fontFamily: 'Sora_700Bold' }}>
                {formatRate(s.priceFromMajor, s.currency, lang)}
                <Text variant="caption" tone="muted">
                  {' '}/kWh
                </Text>
              </Text>
            ) : (
              <Text variant="caption" tone="muted">
                {s.kind === 'partner' ? t('price.perOperator') : t('price.unknown')}
              </Text>
            )}
            {s.priceFromMajor != null ? (
              <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
                {s.kind === 'partner' ? t('price.perOperatorShort') : t(taxLabelKey(s.currency, s.pricesIncludeTax))}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  badge: { width: 48, height: 48, borderRadius: radius.md, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  bottom: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, marginTop: 2 },
  net: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, maxWidth: 160 },
});
