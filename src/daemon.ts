/**
 * Daemon — the autonomous runtime. Runs the manage cycle every
 * managementIntervalMin and the screen cycle every screeningIntervalMin, with
 * busy-guards so cycles never overlap. DRY_RUN-aware; `--once` runs a single
 * pass and exits (handy for testing / cron). Ctrl+C shuts down gracefully.
 */
import { config } from "./config";
import { runScreenCycle } from "./screen-cycle";
import { runManageCycle } from "./manage";
import { assertChain } from "./chain/client";
import { log } from "./util/log";

let _manageBusy = false;
let _screenBusy = false;

async function manageTick(): Promise<void> {
  if (_manageBusy) {
    log.debug("daemon", "manage tick skipped (busy)");
    return;
  }
  _manageBusy = true;
  try {
    const r = await runManageCycle({ execute: true });
    log.info("daemon", `manage: evaluated ${r.evaluated}, closed ${r.closed}, stayed ${r.stayed}`);
  } catch (e) {
    log.error("daemon", `manage failed: ${(e as Error).message}`);
  } finally {
    _manageBusy = false;
  }
}

async function screenTick(deploy: boolean): Promise<void> {
  if (_screenBusy) {
    log.debug("daemon", "screen tick skipped (busy)");
    return;
  }
  _screenBusy = true;
  try {
    const r = await runScreenCycle({ deploy });
    log.info(
      "daemon",
      r.picked
        ? `screen: pick ${r.picked.name}${r.deployed ? " (deployed)" : " (not deployed)"}`
        : `screen: no deploy (${r.reason})`,
    );
  } catch (e) {
    log.error("daemon", `screen failed: ${(e as Error).message}`);
  } finally {
    _screenBusy = false;
  }
}

export interface DaemonOpts {
  once?: boolean;
  deploy?: boolean;
}

export async function runDaemon(opts: DaemonOpts = {}): Promise<void> {
  await assertChain();
  const s = config.schedule;
  const deploy = opts.deploy ?? s.autoDeploy;
  log.info(
    "daemon",
    `start — ${config.wallet.dryRun ? "DRY_RUN" : "LIVE"} | manage ${s.managementIntervalMin}m | screen ${s.screeningIntervalMin}m | autoDeploy ${deploy}`,
  );

  // Initial pass: manage first (protect), then screen (deploy).
  await manageTick();
  await screenTick(deploy);

  if (opts.once) {
    log.info("daemon", "--once complete");
    return;
  }

  const mi = setInterval(manageTick, s.managementIntervalMin * 60_000);
  const si = setInterval(() => screenTick(deploy), s.screeningIntervalMin * 60_000);
  const stop = () => {
    clearInterval(mi);
    clearInterval(si);
    log.info("daemon", "stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log.info("daemon", "running — Ctrl+C to stop");
  await new Promise<void>(() => {}); // keep alive until a signal
}
