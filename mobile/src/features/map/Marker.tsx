import { StyleSheet, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { availabilityVisual } from '@/components/Status';
import { Text } from '@/components/Text';
import type { MapStation } from '@/lib/stationModel';
import { useTheme } from '@/theme';

/**
 * Map pin: filled with the availability colour (available / in use / offline-fault / unknown, see MapLegend) with a
 * glyph (DC bolt, AC plug) and the max kW; partner stations get a ring in the info colour; selected: larger, outlined.
 */
export function StationPin({ s, selected, stale }: { s: MapStation; selected?: boolean; stale?: boolean }) {
  const { c } = useTheme();
  const v = availabilityVisual(stale ? 'unknown' : s.availability, c);
  const dc = s.currents.includes('DC');
  // Dark theme fills are light (4.5:1 needs dark ink); light theme fills are deep (white ink).
  const ink = c.scheme === 'dark' ? '#0a1417' : '#ffffff';
  return (
    <View style={{ alignItems: 'center' }}>
      <View
        style={[
          styles.pin,
          {
            backgroundColor: v.color,
            borderColor: selected ? c.text : s.kind === 'partner' ? c.info : c.surface,
            transform: [{ scale: selected ? 1.12 : 1 }],
            boxShadow: '0px 3px 8px rgba(0,0,0,0.3)',
          },
        ]}
      >
        <Icon name={dc ? 'bolt' : 'plug'} size={13} color={ink} fill={dc ? ink : 'none'} />
        <Text variant="caption" color={ink} style={{ fontFamily: 'Sora_700Bold', fontSize: 11, lineHeight: 13 }} maxFontSizeMultiplier={1.2}>
          {Math.round(s.maxPowerKw)}
        </Text>
      </View>
      <View style={[styles.tail, { borderTopColor: selected ? c.text : s.kind === 'partner' ? c.info : v.color }]} />
    </View>
  );
}

export function ClusterPin({ count, available }: { count: number; available: number }) {
  const { c } = useTheme();
  const size = count > 50 ? 52 : count > 10 ? 46 : 40;
  const color = available > 0 ? c.status.available : c.status.busy;
  return (
    <View style={[styles.cluster, { width: size, height: size, borderRadius: size / 2, backgroundColor: c.surface, borderColor: color, boxShadow: '0px 3px 10px rgba(0,0,0,0.3)' }]}>
      <Text variant="footnote" style={{ fontFamily: 'Sora_700Bold' }} maxFontSizeMultiplier={1.2}>
        {count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pin: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 7, height: 26, borderRadius: 13, borderWidth: 2 },
  tail: { width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 6, borderLeftColor: 'transparent', borderRightColor: 'transparent', marginTop: -1 },
  cluster: { alignItems: 'center', justifyContent: 'center', borderWidth: 3 },
  user: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: '#ffffff', boxShadow: '0px 0px 0px 6px rgba(29,95,184,0.2)' },
  legend: { alignSelf: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 2, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
});

/** The driver's position (drawn above the pins). */
export function UserDot() {
  const { c } = useTheme();
  return <View style={[styles.user, { backgroundColor: c.info }]} />;
}

/** What the pin colours mean (always shown with the map: colour is never the only cue — the list says it in words). */
export function MapLegend({ labels }: { labels: { available: string; busy: string; offline: string; partner?: string } }) {
  const { c } = useTheme();
  const items: [string, string][] = [
    [c.status.available, labels.available],
    [c.status.busy, labels.busy],
    [c.status.offline, labels.offline],
  ];
  return (
    <View style={[styles.legend, { backgroundColor: c.surface + 'ee', borderColor: c.line }]} accessibilityRole="text" accessibilityLabel={items.map((i) => i[1]).join(', ')}>
      {items.map(([color, label]) => (
        <View key={label} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: color }]} />
          <Text variant="caption" style={{ fontSize: 11 }} maxFontSizeMultiplier={1.3}>
            {label}
          </Text>
        </View>
      ))}
      {labels.partner ? (
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: 'transparent', borderWidth: 2, borderColor: c.info }]} />
          <Text variant="caption" style={{ fontSize: 11 }} maxFontSizeMultiplier={1.3}>
            {labels.partner}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
