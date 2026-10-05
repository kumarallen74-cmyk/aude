import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { FavouriteTarget } from '@/api/favourites';
import { useStore } from '@/lib/store';
import { authStore, ensureDevice } from '@/state/auth';
import { qk, queryClient } from '@/state/queryClient';

/** Favourite toggle for a hosted site or a partner location (works for guests: favourites are per device too). */
export function useFavourite(target: FavouriteTarget | null) {
  const token = useStore(authStore, (s) => s.token);
  const list = useQuery({ queryKey: qk.favourites, queryFn: () => api.favourites.list(), enabled: !!token });
  const match =
    target && list.data
      ? list.data.find((f) => ('siteId' in target ? f.siteId === target.siteId : f.partnerId === target.partnerId && f.locationId === target.locationId))
      : undefined;
  const m = useMutation({
    mutationFn: async () => {
      await ensureDevice();
      if (!target) return;
      if (match) await api.favourites.remove(match.id);
      else await api.favourites.add(target);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.favourites }),
  });
  return { isFavourite: !!match, toggle: () => m.mutate(), busy: m.isPending, error: m.error };
}
