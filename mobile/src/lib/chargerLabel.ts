/**
 * How a connector is named on screen: the operator's friendly charger name (the console's display name, e.g.
 * "Pillar B · DC fast") with the connector number; the raw OCPP identity ("AUTEL-DC60-SMB-002") only as a secondary,
 * single-line detail — what is printed on the charger, useful for support, never the headline.
 */
export function chargerLabel(
  c: { chargerName: string; ocppIdentity: string; connectorNo: number },
  t: (k: string, o?: Record<string, unknown>) => string,
): { title: string; detail: string | null } {
  const friendly = c.chargerName && c.chargerName !== c.ocppIdentity ? c.chargerName : null;
  return {
    title: friendly ? t('connector.nameNo', { name: friendly, n: c.connectorNo }) : t('connector.connectorNo', { n: c.connectorNo }),
    detail: c.ocppIdentity || null,
  };
}
