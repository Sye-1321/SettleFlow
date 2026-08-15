import process from 'node:process';

import { DEMO_RECEIVER_CONTROL_PATH, SyntheticWebhookReceiver } from './webhook-receiver.mjs';

const receiver = new SyntheticWebhookReceiver({
  controlPath: DEMO_RECEIVER_CONTROL_PATH,
  port: 18_080,
});

async function shutdown() {
  await receiver.close();
  process.exitCode = 0;
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await receiver.start();
