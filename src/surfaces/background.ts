/**
 * Scaffold handlers for triggers, queue consumers and the scheduled trigger.
 * Each one only logs for now; the pipeline (collect → score → reach → propose, Sentinel, migrations) comes next.
 */
type ForgeEvent = Record<string, unknown> | undefined;

const stub = (name: string) => async (event: ForgeEvent): Promise<void> => {
  console.info(`${name}: not implemented yet`, { keys: Object.keys(event ?? {}) });
};

export const onWorkEvent = stub('onWorkEvent');
export const onAppLifecycle = stub('onAppLifecycle');
export const onConnectionChange = stub('onConnectionChange');
export const collectEvents = stub('collectEvents');
export const scoreCandidates = stub('scoreCandidates');
export const traceReach = stub('traceReach');
export const proposeRoutesJob = stub('proposeRoutesJob');
export const checkSentinel = stub('checkSentinel');
export const migrateSchema = stub('migrateSchema');
export const demoJob = stub('demoJob');
export const purgeExpired = stub('purgeExpired');
