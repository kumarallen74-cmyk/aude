import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApiError } from '@/api/http';
import '@/i18n';
import { mergeStations } from '@/lib/stationModel';
import { ErrorState } from '../StateView';
import { QRCode } from '../QRCode';
import { SlideToStart } from '../SlideToStart';
import { StationRow } from '../StationRow';
import { ChargeRing } from '../ChargeRing';
import { Text } from '../Text';

const station = mergeStations(
  [
    {
      siteId: 's1', name: 'Senayan Hub — B1', address: null, lat: -6.2, lon: 106.8, spkluId: null, operator: 'Arus Kota', distanceKm: 1.2,
      connectors: [
        { connectorId: 'c1', ocppIdentity: 'AK', chargerName: 'AK', connectorNo: 1, type: 'cCCS2', typeLabel: 'CCS2', current: 'DC', maxPowerW: 120000, maxPowerKw: 120, chargingClass: 'fast', status: 'Available', available: true, blockedReason: null },
        { connectorId: 'c2', ocppIdentity: 'AK', chargerName: 'AK', connectorNo: 2, type: 'cCCS2', typeLabel: 'CCS2', current: 'DC', maxPowerW: 120000, maxPowerKw: 120, chargingClass: 'fast', status: 'Charging', available: false, blockedReason: 'In use.' },
      ],
      availableCount: 1, totalCount: 2, maxPowerKw: 120, fastest: '120 kW DC', priceFromMinor: 2466, priceFromMajor: 2466.78, currency: 'IDR', countryCode: 'ID', timezone: null, pricesIncludeTax: false,
      reliability: { score: 97, label: 'reliable', basis: '30d', lastSuccessAt: null },
    },
  ],
  [],
)[0]!;

describe('StationRow', () => {
  it('announces name, availability, power and price in one screen-reader label (spec §7)', async () => {
    const onPress = jest.fn();
    await render(<StationRow s={station} onPress={onPress} />);
    const row = screen.getByRole('button');
    expect(row.props.accessibilityLabel).toBe('Senayan Hub — B1, 1 of 2 available, 120 kW DC, from Rp 2,467 per kWh, Arus Kota, 1.2 km');
    expect(screen.getByText(/Rp 2,467/)).toBeTruthy();
    expect(screen.getByText('excl. PPN & local tax')).toBeTruthy();
    await fireEvent.press(row);
    expect(onPress).toHaveBeenCalled();
  });
  it('shows "status unknown" for cached (stale) data instead of guessing', async () => {
    await render(<StationRow s={station} stale />);
    expect(screen.getByText('Status unknown')).toBeTruthy();
  });
});

describe('SlideToStart', () => {
  it('offers a plain button when "start with a button" is on (WCAG 2.5.7)', async () => {
    const onComplete = jest.fn();
    await render(<SlideToStart label="Slide to pay Rp 100,000" onComplete={onComplete} simple testID="cta" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Slide to pay Rp 100,000' }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
  it('the slider exposes an accessibility action that starts too', async () => {
    const onComplete = jest.fn();
    await render(<SlideToStart label="Slide to start" onComplete={onComplete} testID="cta" />);
    const el = screen.getByTestId('cta');
    expect(el.props.accessibilityRole).toBe('adjustable');
    await fireEvent(el, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
  it('disabled does nothing', async () => {
    const onComplete = jest.fn();
    await render(<SlideToStart label="Go" onComplete={onComplete} disabled simple />);
    await fireEvent.press(screen.getByRole('button'));
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('ErrorState', () => {
  it('network error: human sentence + retry', async () => {
    const retry = jest.fn();
    await render(<ErrorState error={new ApiError('offline', '', 0)} onRetry={retry} />);
    expect(screen.getByText('No connection')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
  it('business error: shows the server sentence', async () => {
    await render(<ErrorState error={new ApiError('business', 'Konektor ini sedang dipesan pengemudi lain.', 422)} compact />);
    expect(screen.getByText('Konektor ini sedang dipesan pengemudi lain.')).toBeTruthy();
  });
});

describe('QRCode / ChargeRing / Text', () => {
  it('renders a labelled QR image', async () => {
    await render(<QRCode value="00020101021226650013ID.CO.QRIS.WWW" label="Payment QR code for Rp 100,000" />);
    expect(screen.getByLabelText('Payment QR code for Rp 100,000')).toBeTruthy();
  });
  it('ring renders its children', async () => {
    await render(
      <ChargeRing value={0.4}>
        <Text>12.30</Text>
      </ChargeRing>,
    );
    expect(screen.getByText('12.30')).toBeTruthy();
  });
  it('text scales with the OS font size but caps display numbers (no truncated prices at 200 %)', async () => {
    await render(
      <>
        <Text>body</Text>
        <Text variant="hero">99.99</Text>
      </>,
    );
    expect(screen.getByText('body').props.maxFontSizeMultiplier).toBe(2);
    expect(screen.getByText('99.99').props.maxFontSizeMultiplier).toBe(1.6);
  });
});
