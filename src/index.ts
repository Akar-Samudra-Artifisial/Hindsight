export { confirmSignal, createRoute, findPriorSignals, proposeRoutes, traceSignalReach, writePirSection } from './surfaces/actions';
export {
  checkSentinel,
  collectEvents,
  demoJob,
  migrateSchema,
  onAppLifecycle,
  onConnectionChange,
  onWorkEvent,
  proposeRoutesJob,
  purgeExpired,
  scoreCandidates,
  traceReach,
} from './surfaces/background';
export { handler as uiResolver } from './surfaces/ui';
