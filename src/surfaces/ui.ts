import Resolver from '@forge/resolver';
import { cloudIdFromInstallContext, readSpike } from '../adapters/teamworkGraph';

const SETUP_MODULE = 'hindsight-setup';
const SURFACES = new Set(['incident', 'insights', 'setup']);

const resolver = new Resolver();

resolver.define('getStatus', ({ payload }) => {
  const surface = typeof payload['surface'] === 'string' ? payload['surface'] : '';
  if (!SURFACES.has(surface)) return { error: `Unknown surface "${surface}".` };
  return { surface, ready: false };
});

interface ResolverContext {
  accountId?: string;
  moduleKey?: string;
  cloudId?: string;
  installContext?: string;
}

/** Teamwork Graph read spike, as the current user; setup page only. */
resolver.define('twgSpike', async ({ context }) => {
  const ctx = context as ResolverContext;
  if (ctx.moduleKey !== SETUP_MODULE) return { error: 'twgSpike is only available on Hindsight setup.' };
  if (!ctx.accountId) return { error: 'No user in context.' };
  const cloudId = ctx.cloudId || cloudIdFromInstallContext(ctx.installContext);
  if (!cloudId) return { error: 'Site id unavailable.' };
  return readSpike(cloudId, ctx.accountId);
});

export const handler = resolver.getDefinitions();
