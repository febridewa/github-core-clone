// Entry process: the forge server plus the handshake that lets the trial env find it.
//
// The env (MAKEFUN_ENV_URL, http://store:8080 inside a trial) is the only thing that
// talks to this process from the outside. The handshake is three steps, and the process
// does nothing else until the env says the trial is over:
//
//   * listen on an ephemeral port (never a fixed one: 8080 belongs to the env),
//   * POST the port to /register so the env can dial this forge,
//   * poll GET /done until it answers {"done": true}, then shut down and exit 0.
//
// Registration is retried with exponential backoff because the env may still be
// starting when this process comes up. A 200 means the env accepted the port; a 409
// means some other entry registered first, which is not an error for this process —
// it simply waits for the trial to end like any other. A 400 or 405 means the
// request itself is wrong, so the process gives up at once. Polling never holds a
// request open: /done answers immediately, so this is a plain loop with backoff.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('no MAKEFUN_ENV_URL: cannot register with the trial env\n');
  process.exit(1);
}

// One env request may take at most this long; a slower one is abandoned and retried.
const REQUEST_BUDGET_MS = 30_000;
// Backoff between retries: starts here, doubles each time, never exceeds the cap.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(failures: number): number {
  const step = Math.min(failures, 8);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** step);
}

/** Tell the env which port this forge listens on; returns once the env has the port. */
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let status: number | null = null;
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      status = response.status;
      if (status === 200 || status === 409) return;
      if (status === 400 || status === 405) {
        throw new Error(`register refused with HTTP ${status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused with HTTP ')) throw err;
    }
    // Any other status, or no answer at all: the env is not ready yet. Wait and retry.
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Ask the env, over and over, whether the trial has finished. */
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer, or a slow one: the trial is still running.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind a TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`forge listening on port ${port}\n`);

  await announce(port);
  process.stdout.write('registered with the env; waiting for done\n');

  await awaitDone();
  server.close();
  process.stdout.write('trial done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`forge failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
