/** What a developer can act out at a sandbox (virtual) charger. */
export const SIMULATE_EVENTS = ['plug-in', 'unplug', 'tap-card', 'plug-and-charge', 'stop', 'fault', 'clear-fault', 'go-offline', 'come-online', 'reboot', 'status'] as const;
export type SimulateEvent = (typeof SIMULATE_EVENTS)[number];
