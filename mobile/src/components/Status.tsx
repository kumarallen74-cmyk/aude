import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Reliability } from '@/api/types';
import type { Availability } from '@/lib/stationModel';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { radius, space, useTheme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Availability = colour + icon + text, never colour alone (spec §7). */
export function availabilityVisual(a: Availability | string, c: ReturnType<typeof useTheme>['c']): { color: string; icon: IconName } {
  switch (a) {
    case 'available':
    case 'Available':
      return { color: c.status.available, icon: 'check' };
    case 'busy':
    case 'Charging':
    case 'Occupied':
      return { color: c.status.busy, icon: 'bolt' };
    case 'Reserved':
    case 'Queued':
      return { color: c.status.reserved, icon: 'clock' };
    case 'fault':
    case 'Faulted':
    case 'Blocked':
    case 'Maintenance':
      return { color: c.status.fault, icon: 'warning' };
    case 'offline':
    case 'Offline':
    case 'Unavailable':
      return { color: c.status.offline, icon: 'boltOff' };
    default:
      return { color: c.status.offline, icon: 'info' };
  }
}

export function StatusDot({ status, label, size = 'md' }: { status: Availability | string; label: string; size?: 'sm' | 'md' }) {
  const { c } = useTheme();
  const v = availabilityVisual(status, c);
  return (
    <View style={[styles.pill, { backgroundColor: v.color + '22', paddingVertical: size === 'sm' ? 2 : 4 }]} accessibilityLabel={label}>
      <Icon name={v.icon} size={size === 'sm' ? 12 : 14} color={v.color} strokeWidth={2.6} />
      <Text variant="caption" color={v.color} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function ReliabilityBadge({ r, compact }: { r: Reliability | null | undefined; compact?: boolean }) {
  const { c } = useTheme();
  const { t, i18n } = useTranslation();
  const now = useNow();
  if (!r) return null;
  const tone = r.label === 'reliable' ? c.success : r.label === 'issue' ? c.warning : r.label === 'mixed' ? c.info : c.textMuted;
  const icon: IconName = r.label === 'reliable' ? 'shield' : r.label === 'issue' ? 'warning' : r.label === 'mixed' ? 'gauge' : 'star';
  const text =
    r.label === 'reliable' && r.score != null
      ? t('reliability.reliable', { pct: r.score })
      : r.label === 'mixed' && r.score != null
        ? t('reliability.mixed', { pct: r.score })
        : r.label === 'issue'
          ? t('reliability.issue', { ago: relativeTime(r.lastIssueAt ?? null, now, i18n.language) })
          : t('reliability.new');
  return (
    <View style={[styles.pill, { backgroundColor: tone + '1f', flexShrink: 1 }]} accessibilityLabel={text}>
      <Icon name={icon} size={14} color={tone} />
      <Text variant="caption" color={tone} numberOfLines={compact ? 1 : 2} style={{ flexShrink: 1 }}>
        {compact ? (r.score != null ? `${r.score}%` : r.label === 'issue' ? t('reliability.issueShort') : t('reliability.newShort')) : text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, borderRadius: radius.pill, alignSelf: 'flex-start', paddingVertical: 4 },
});

/** Localised connector status ("Available", "In use" …); unknown server statuses are shown as sent. */
export function statusLabel(t: (k: string) => string, s: string): string {
  const k = `status.${s}`;
  const v = t(k);
  return v === k ? s : v;
}
