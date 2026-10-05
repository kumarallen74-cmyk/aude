-- 061: validate the NOT VALID foreign keys added by 059.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE: reads and writes continue
-- while the existing rows are checked (every one of them is 'IDR' / 'ID').
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['charging_session','cdr','payment_intent','driver_charge','driver_reservation',
    'reservation_checkout','subscription_plan','subscription_charge','subscription_session','promotion',
    'promotion_redemption','loyalty_program','loyalty_entry','fleet_invoice','fleet_credit_note',
    'commission_statement','commercial_plan','tariff']
  LOOP
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_currency_fk');
  END LOOP;
END $$;
ALTER TABLE site VALIDATE CONSTRAINT site_country_fk;
ALTER TABLE organisation VALIDATE CONSTRAINT organisation_home_country_fk;
ALTER TABLE tariff VALIDATE CONSTRAINT tariff_country_fk;
ALTER TABLE token VALIDATE CONSTRAINT token_spend_limit_currency_fk;
ALTER TABLE integration VALIDATE CONSTRAINT integration_country_fk;
