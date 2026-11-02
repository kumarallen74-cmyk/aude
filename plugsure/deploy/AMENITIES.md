# Accessibility and site amenities (v1.49.0)

**Assets & energy → Amenities & access.** What each site offers while the car charges, and how accessible it is.

## Amenities

- Toilets, prayer room (musholla), food and drink, a shop, Wi-Fi, a roof or shade, lighting at night, security, a
  lounge, free parking.
- Opening hours, or open 24 hours.
- Notes for drivers.

## Accessibility

Record:
- the accessible bays: wider, close to the charger, marked;
- whether there is a step-free route from the bay to the charger and the screen;
- the bay width;
- how far the cable reaches;
- the height of the highest control a driver must reach (the screen, the card reader).

Five checks make the score:
1. an accessible bay;
2. step-free;
3. a bay at least 3.6 m wide;
4. a cable of at least 3 m;
5. the controls at most 120 cm high.

A site with an accessible bay and a step-free route is shown as **accessible**. *Checked today* records when someone
last checked on site.

## In the app

- Each station shows its amenities and whether it is accessible.
- The station list has filters: accessible, toilets, prayer room, food, shade. The API equivalent is
  `GET /d/v1/stations?amenities=accessible,toilet`.
- On a station, drivers report what is wrong: a blocked bay, no step-free route, a short cable, a screen too high, an
  amenity that is not there, or something else. Each report raises `access.report`. Resolve it here, or dismiss it,
  saying what was done.
