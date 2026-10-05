import { act, renderHook } from '@testing-library/react-native';
import { useTracksViewChanges } from '../useTracksViewChanges';

describe('Android marker tracksViewChanges', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('on for ~500 ms after mount, then off; on again when what the pin shows changes', async () => {
    const { result, rerender } = await renderHook(({ sig }: { sig: string }) => useTracksViewChanges(sig), { initialProps: { sig: 'available|2' } });
    expect(result.current).toBe(true);
    await act(async () => jest.advanceTimersByTime(499));
    expect(result.current).toBe(true);
    await act(async () => jest.advanceTimersByTime(2));
    expect(result.current).toBe(false);
    await rerender({ sig: 'available|2' });
    expect(result.current).toBe(false);
    await rerender({ sig: 'busy|0' });
    expect(result.current).toBe(true);
    await act(async () => jest.advanceTimersByTime(600));
    expect(result.current).toBe(false);
  });
});
