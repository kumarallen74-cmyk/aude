import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatRate, taxLabelKey } from '@/lib/money';
import { space } from '@/theme';
import { Text } from './Text';

/** Energy price per kWh with its tax label (spec §6.4 / §7: honest money, currency-explicit). */
export function PriceTag({ rate, currency, inclusive, partner, size = 'md', align = 'right' }: { rate: number | null; currency: string | null; inclusive: boolean; partner?: boolean; size?: 'md' | 'lg'; align?: 'left' | 'right' }) {
  const { t, i18n } = useTranslation();
  if (rate == null) {
    return (
      <Text variant="footnote" tone="muted" align={align}>
        {partner ? t('price.perOperator') : t('price.unknown')}
      </Text>
    );
  }
  return (
    <View style={{ alignItems: align === 'right' ? 'flex-end' : 'flex-start', gap: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.xxs }}>
        <Text variant={size === 'lg' ? 'title1' : 'title3'} style={{ fontFamily: 'Sora_700Bold' }}>
          {formatRate(rate, currency, i18n.language)}
        </Text>
        <Text variant="caption" tone="muted">
          /kWh
        </Text>
      </View>
      <Text variant="caption" tone="faint" align={align}>
        {partner ? t('price.perOperatorShort') : t(taxLabelKey(currency, inclusive))}
      </Text>
    </View>
  );
}
