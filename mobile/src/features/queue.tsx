import { useMutation, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import type { QueueEntryView, SiteQueueView } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Section } from '@/components/Screen';
import { Text } from '@/components/Text';
import { useNow } from '@/lib/useNow';
import { useStore } from '@/lib/store';
import { authStore } from '@/state/auth';
import { queryClient } from '@/state/queryClient';
import { space } from '@/theme';

/**
 * Site queues (waitlist, `driver/queue.ts`): where every suitable connector is busy, a signed-in driver joins the
 * site's queue; when a connector frees up it is held for the first in line for `offerMinutes` (push `queue.offer`).
 */
export const queueKeys = { site: (siteId: string) => ['queue', 'site', siteId] as const, mine: ['queue', 'mine'] as const };

export type Want = { current: 'AC' | 'DC' | null; type: string | null };

/** Minutes left on an offer (0 when it has run out). */
export function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
}

/** The connector-kind choices of a site's queue ("any" first). */
export function wantChoices(q: Pick<SiteQueueView, 'types'>): { key: string; want: Want; label: string | null }[] {
  return [{ key: 'any', want: { current: null, type: null }, label: null }, ...q.types.map((x) => ({ key: `${x.current}|${x.type}`, want: { current: x.current, type: x.type }, label: `${x.typeLabel} ${x.current}` }))];
}

function EntryCard({ e, now }: { e: QueueEntryView; now: number }) {
  const { t } = useTranslation();
  const qc = useMutation({
    mutationFn: () => api.reservations.leaveQueue(e.id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['queue'] }),
  });
  if (e.offer) {
    const left = minutesLeft(e.offer.expiresAt, now);
    return (
      <Banner
        tone="success"
        icon="bolt"
        title={t('queue.offerTitle', { charger: e.offer.chargerName, no: e.offer.connectorNo })}
        body={t('queue.offerBody', { min: left })}
        action={t('queue.goCharge')}
        onPress={() => router.push(`/connector/${e.offer!.connectorId}`)}
        testID="queue-offer"
      />
    );
  }
  return (
    <Card style={{ gap: space.sm }} testID="queue-entry">
      <Text variant="title3">{e.position != null ? t('queue.position', { n: e.position }) : t('queue.waiting')}</Text>
      <Text variant="footnote" tone="muted">
        {[e.want.typeLabel ? `${e.want.typeLabel} ${e.want.current ?? ''}`.trim() : t('queue.anyConnector'), t('queue.offerRule', { min: e.offerMinutes })].join(' · ')}
      </Text>
      <Button label={t('queue.leave')} variant="ghost" size="sm" loading={qc.isPending} onPress={() => qc.mutate()} testID="queue-leave" />
    </Card>
  );
}

/** Station screen: the site's queue — join (with AC/DC and plug choice), your place, or a held connector. */
export function QueuePanel({ siteId, signedIn }: { siteId: string; signedIn: boolean }) {
  const { t } = useTranslation();
  const token = useStore(authStore, (s) => s.token);
  const now = useNow(15_000);
  const [pick, setPick] = useState('any');
  const q = useQuery({ queryKey: [...queueKeys.site(siteId), !!token], queryFn: () => api.stations.siteQueue(siteId), refetchInterval: 15_000, retry: false });
  const join = useMutation({
    mutationFn: (want: Want) => api.reservations.joinQueue(siteId, want),
    onSettled: () => void q.refetch(),
  });
  const leave = useMutation({ mutationFn: (id: string) => api.reservations.leaveQueue(id), onSettled: () => void q.refetch() });
  const s = q.data;
  if (!s?.enabled) return null;

  const choices = wantChoices(s);
  const chosen = choices.find((c) => c.key === pick) ?? choices[0]!;
  const freeNow = join.error instanceof ApiError ? ((join.error.body as { connectorId?: string } | undefined)?.connectorId ?? null) : null;

  return (
    <Section title={t('queue.title')}>
      <Text variant="footnote" tone="muted" testID="queue-summary">
        {t('queue.summary', { count: s.waiting, min: s.offerMinutes })}
      </Text>
      {s.mine ? (
        s.mine.offer ? (
          <EntryCard e={s.mine} now={now} />
        ) : (
          <Card style={{ gap: space.sm }} testID="queue-entry">
            <Text variant="title3">{s.mine.position != null ? t('queue.position', { n: s.mine.position }) : t('queue.waiting')}</Text>
            <Text variant="footnote" tone="muted">
              {t('queue.offerRule', { min: s.offerMinutes })}
            </Text>
            <Button label={t('queue.leave')} variant="ghost" size="sm" loading={leave.isPending} onPress={() => leave.mutate(s.mine!.id)} testID="queue-leave" />
          </Card>
        )
      ) : s.canJoin ? (
        <View style={{ gap: space.sm }}>
          {choices.length > 2 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {choices.map((c) => (
                <Chip key={c.key} label={c.label ?? t('queue.anyConnector')} selected={c.key === chosen.key} onPress={() => setPick(c.key)} testID={`queue-want-${c.key}`} />
              ))}
            </View>
          ) : null}
          <Button label={t('queue.join')} icon="clock" variant="secondary" loading={join.isPending} onPress={() => join.mutate(chosen.want)} testID="queue-join" />
        </View>
      ) : !signedIn ? (
        <Button label={t('queue.signIn')} variant="secondary" icon="user" onPress={() => router.push('/sign-in')} testID="queue-sign-in" />
      ) : s.reason ? (
        <Text variant="footnote" tone="muted" testID="queue-reason">
          {s.reason}
        </Text>
      ) : null}
      {freeNow ? (
        <Banner tone="success" title={join.error instanceof ApiError ? join.error.message : ''} action={t('queue.goCharge')} onPress={() => router.push(`/connector/${freeNow}`)} />
      ) : join.error instanceof ApiError ? (
        <Banner tone="warning" title={join.error.message} />
      ) : null}
    </Section>
  );
}

/** Activity tab: your place in a queue (or the connector held for you), and how the last one ended. */
export function MyQueue() {
  const { t } = useTranslation();
  const token = useStore(authStore, (s) => s.token);
  const now = useNow(15_000);
  const q = useQuery({ queryKey: queueKeys.mine, queryFn: () => api.reservations.myQueue(), enabled: !!token, refetchInterval: 15_000, retry: false });
  const e = q.data?.entry;
  if (!e) return null;
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="footnote" tone="muted">
        {t('queue.at', { site: e.siteName })}
      </Text>
      <EntryCard e={e} now={now} />
    </View>
  );
}
