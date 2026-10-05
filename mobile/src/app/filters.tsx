import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ListGroup, ListRow } from '@/components/ListRow';
import { Screen, Section } from '@/components/Screen';
import { Segmented } from '@/components/Segmented';
import { Text } from '@/components/Text';
import { brand } from '@/config';
import { useStations } from '@/features/stations';
import { applyFilters, DEFAULT_FILTERS, POWER_STEPS, type ConnectorFilter, type Filters } from '@/lib/filters';
import { formatRate } from '@/lib/money';
import { networksOf } from '@/lib/stationModel';
import { settingsStore, useSettings } from '@/state/settings';
import { space } from '@/theme';

const CONNECTORS: ConnectorFilter[] = ['CCS2', 'Type 2', 'CHAdeMO', 'GB/T'];
const PRICE_CAPS: Record<'IDR' | 'MYR' | 'SGD', number[]> = { IDR: [2000, 2500, 3000], MYR: [1, 1.3, 1.6], SGD: [0.6, 0.7, 0.8] };

/** All filters (spec §4.1.2): connector, AC/DC, power, availability, startable, network, price, open now. */
export default function FiltersScreen() {
  const { t, i18n } = useTranslation();
  const saved = useSettings((s) => s.filters);
  const [f, setF] = useState<Filters>(saved);
  const data = useStations(null);
  const networks = useMemo(() => networksOf(data.stations), [data.stations]);
  const count = useMemo(() => applyFilters(data.stations, f).length, [data.stations, f]);
  const currencies = useMemo(() => [...new Set(data.stations.map((s) => s.currency).filter(Boolean))] as ('IDR' | 'MYR' | 'SGD')[], [data.stations]);
  const set = (p: Partial<Filters>) => setF({ ...f, ...p });
  const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Screen
      back
      modal
      title={t('filters.title')}
      testID="filters-screen"
      right={<Button label={t('filters.reset')} variant="ghost" size="sm" full={false} onPress={() => setF(DEFAULT_FILTERS)} />}
      footer={
        <Button
          label={t('filters.show', { count })}
          onPress={() => {
            settingsStore.set({ filters: f });
            router.back();
          }}
          testID="apply-filters"
        />
      }
    >
      <ListGroup>
        <ListRow icon="check" label={t('filters.availableNow')} toggle={f.availableNow} onToggle={(v) => set({ availableNow: v })} />
        <ListRow icon="phone" label={t('filters.startable')} detail={t('filters.startableDetail')} toggle={f.startableInApp} onToggle={(v) => set({ startableInApp: v })} />
        <ListRow icon="clock" label={t('filters.openNow')} detail={t('filters.openNowDetail')} toggle={f.openNow} onToggle={(v) => set({ openNow: v })} />
        {brand.scope === 'network' ? <ListRow icon="route" label={t('filters.partners')} detail={t('filters.partnersDetail')} toggle={f.partners} onToggle={(v) => set({ partners: v })} last /> : null}
      </ListGroup>

      <Section title={t('filters.connector')}>
        <View style={styles.wrap}>
          {CONNECTORS.map((cn) => (
            <Chip key={cn} label={cn} selected={f.connectors.includes(cn)} onPress={() => set({ connectors: toggleIn(f.connectors, cn) })} />
          ))}
        </View>
      </Section>

      <Section title={t('filters.current')}>
        <Segmented value={f.current} onChange={(v) => set({ current: v })} options={[{ value: 'any', label: t('filters.any') }, { value: 'AC', label: 'AC' }, { value: 'DC', label: 'DC' }]} />
      </Section>

      <Section title={t('filters.minPower')}>
        <View style={styles.wrap}>
          {POWER_STEPS.map((kw) => (
            <Chip key={kw} label={kw === 0 ? t('filters.any') : `≥ ${kw} kW`} selected={f.minKw === kw} onPress={() => set({ minKw: kw })} />
          ))}
        </View>
      </Section>

      {currencies.map((cur) => (
        <Section key={cur} title={t('filters.maxPrice', { currency: cur })}>
          <View style={styles.wrap}>
            <Chip label={t('filters.any')} selected={f.maxPrice[cur] == null} onPress={() => set({ maxPrice: { ...f.maxPrice, [cur]: undefined } })} />
            {PRICE_CAPS[cur].map((p) => (
              <Chip key={p} label={`≤ ${formatRate(p, cur, i18n.language)}`} selected={f.maxPrice[cur] === p} onPress={() => set({ maxPrice: { ...f.maxPrice, [cur]: p } })} />
            ))}
          </View>
        </Section>
      ))}

      {networks.length > 1 ? (
        <Section title={t('filters.network')}>
          <View style={styles.wrap}>
            {networks.map((n) => (
              <Chip key={n} label={n} selected={f.networks.includes(n)} onPress={() => set({ networks: toggleIn(f.networks, n) })} />
            ))}
          </View>
          <Text variant="caption" tone="faint">
            {t('filters.networkHint')}
          </Text>
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm } });
