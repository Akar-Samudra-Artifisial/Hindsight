import { InputError, parseIncidentKey, parseWindowDays } from '../core/validate';

/** Rovo action / MCP tool payload: declared inputs arrive as top-level fields. */
type ActionPayload = Record<string, unknown>;

interface ActionReply {
  status: 'ok' | 'error' | 'not_implemented';
  message: string;
  [field: string]: unknown;
}

function guard(run: (payload: ActionPayload) => ActionReply): (payload: ActionPayload) => Promise<ActionReply> {
  return async (payload) => {
    try {
      return run(payload);
    } catch (err) {
      if (err instanceof InputError) return { status: 'error', message: err.message };
      throw err;
    }
  };
}

const notImplemented = (action: string, incidentKey: string): ActionReply => ({
  status: 'not_implemented',
  message: `${action} for ${incidentKey} is not implemented yet.`,
  incidentKey,
});

export const findPriorSignals = guard((p) => {
  const incidentKey = parseIncidentKey(p['incidentKey']);
  const windowDays = parseWindowDays(p['windowDays']);
  return { ...notImplemented('Find prior signals', incidentKey), windowDays, signals: [] };
});

export const confirmSignal = guard((p) => notImplemented('Confirm signal', parseIncidentKey(p['incidentKey'])));
export const traceSignalReach = guard((p) => notImplemented('Trace signal reach', parseIncidentKey(p['incidentKey'])));
export const proposeRoutes = guard((p) => notImplemented('Propose routes', parseIncidentKey(p['incidentKey'])));
export const createRoute = guard((p) => notImplemented('Create route', parseIncidentKey(p['incidentKey'])));
export const writePirSection = guard((p) => notImplemented('Write PIR section', parseIncidentKey(p['incidentKey'])));
