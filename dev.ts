// Local dev entrypoint: start the forge on a fixed port without the
// make.fun env lifecycle (main.ts requires MAKEFUN_ENV_URL). Not used by
// the sealed suite; only for local grading.
//   MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types dev.ts [port]
import { createApp } from './app.ts';

const port = Number.parseInt(process.argv[2] ?? '18080', 10);
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port}\n`);
});
