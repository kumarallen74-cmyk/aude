import { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT, type Region as MapRegion } from 'react-native-maps';
import { ClusterPin, StationPin, UserDot } from './Marker';
import type { StationMapHandle, StationMapProps } from './types';
import { useTracksViewChanges } from './useTracksViewChanges';
import type { MapStation } from '@/lib/stationModel';

function StationMarker({ s, lat, lon, selected, stale, scheme, label, onPress }: { s: MapStation; lat: number; lon: number; selected: boolean; stale?: boolean; scheme: string; label: string; onPress: () => void }) {
  const tracks = useTracksViewChanges(`${s.availability}|${s.availableCount}|${Math.round(s.maxPowerKw)}|${selected}|${stale}|${scheme}`);
  return (
    <Marker coordinate={{ latitude: lat, longitude: lon }} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={tracks} onPress={onPress} accessibilityLabel={label}>
      <StationPin s={s} selected={selected} stale={stale} />
    </Marker>
  );
}

function ClusterMarker({ lat, lon, count, available, scheme, label, onPress }: { lat: number; lon: number; count: number; available: number; scheme: string; label: string; onPress: () => void }) {
  const tracks = useTracksViewChanges(`${count}|${available}|${scheme}`);
  return (
    <Marker coordinate={{ latitude: lat, longitude: lon }} tracksViewChanges={tracks} onPress={onPress} accessibilityLabel={label}>
      <ClusterPin count={count} available={available} />
    </Marker>
  );
}

/** Google Maps dark style for Android (Apple Maps follows the system appearance on iOS). */
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#122126' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8fa7a2' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a1417' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1d3439' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#25444a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b2a33' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

/**
 * Native map (react-native-maps: Apple Maps on iOS, Google Maps on Android). Markers are plain RN views whose
 * `tracksViewChanges` is on only for ~500 ms after they mount or change (useTracksViewChanges), so pins are captured
 * fully drawn and pan/zoom stays at 60 fps (spec §10).
 * MapLibre with the operator-chosen vector tiles ([OWNER] tile provider, spec §6.2) can replace this component
 * behind the same props.
 */
export const StationMap = forwardRef<StationMapHandle, StationMapProps>(function StationMap(p, ref) {
  const map = useRef<MapView>(null);
  useImperativeHandle(ref, () => ({ animateTo: (r) => map.current?.animateToRegion(r, 350) }), []);

  return (
    <MapView
      ref={map}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      initialRegion={p.region}
      onRegionChangeComplete={(r: MapRegion) => p.onRegionChange(r)}
      showsUserLocation={false}
      showsMyLocationButton={false}
      showsCompass={false}
      toolbarEnabled={false}
      userInterfaceStyle={p.scheme}
      customMapStyle={p.scheme === 'dark' ? DARK_STYLE : []}
      mapPadding={{ top: 0, left: 0, right: 0, bottom: p.bottomInset ?? 0 }}
      moveOnMarkerPress={false}
      accessibilityLabel={p.mapLabel ?? "Map"}
    >
      {p.items.map((it) =>
        it.type === 'cluster' ? (
          <ClusterMarker
            key={`c${it.id}`}
            lat={it.lat}
            lon={it.lon}
            count={it.count}
            available={it.available}
            scheme={p.scheme}
            label={p.clusterLabel ? p.clusterLabel(it.count, it.available) : `${it.count}`}
            onPress={() => p.onClusterPress(it.id, it.lat, it.lon)}
          />
        ) : (
          <StationMarker
            key={it.station.key}
            s={it.station}
            lat={it.lat}
            lon={it.lon}
            selected={p.selectedKey === it.station.key}
            stale={p.stale}
            scheme={p.scheme}
            label={p.stationLabel ? p.stationLabel(it.station) : it.station.name}
            onPress={() => p.onSelect(it.station.key)}
          />
        ),
      )}
      {/* Above the pins (zIndex): a cluster or pin never hides where the driver is. */}
      {p.user ? (
        <Marker coordinate={{ latitude: p.user.lat, longitude: p.user.lon }} anchor={{ x: 0.5, y: 0.5 }} zIndex={1000} tracksViewChanges={false} tappable={false} accessibilityLabel={p.userLabel}>
          <UserDot />
        </Marker>
      ) : null}
    </MapView>
  );
});
