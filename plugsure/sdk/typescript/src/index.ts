import { Operations } from './generated.js';
import { Transport, type ClientOptions, type RateLimitInfo } from './client.js';

export * from './generated.js';
export { PlugSureError, type ClientOptions, type RequestOptions, type RateLimitInfo, type BinaryBody } from './client.js';
export { verifyWebhookSignature, parseWebhook, WebhookSignatureError, type VerifyOptions } from './webhooks.js';

/**
 * The PlugSure CSMS API.
 *
 *   const plugsure = new PlugSure({ apiKey: process.env.PLUGSURE_API_KEY!, baseUrl: 'https://api.example.id' });
 *   const chargers = await plugsure.listChargePoints();
 *   const cp = await plugsure.getChargePoint({ identity: 'AUTEL-DC60-SMB-002' });
 *
 * One method per operation, named by the operation id in the API reference
 * (/api-docs.html). Errors are thrown as PlugSureError; a request refused for
 * the key's rate limit is retried after the wait the API asks for.
 */
export class PlugSure extends Operations {
  constructor(options: ClientOptions) {
    super(new Transport(options));
  }

  /** The key's rate limit as of the last answer (undefined before the first request). */
  get rateLimit(): RateLimitInfo | undefined {
    return (this.transport as Transport).rateLimit;
  }
}

export default PlugSure;
