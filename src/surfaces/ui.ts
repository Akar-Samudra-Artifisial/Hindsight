import Resolver from '@forge/resolver';

const SURFACES = new Set(['incident', 'insights', 'setup']);

const resolver = new Resolver();

resolver.define('getStatus', ({ payload }) => {
  const surface = typeof payload['surface'] === 'string' ? payload['surface'] : '';
  if (!SURFACES.has(surface)) return { error: `Unknown surface "${surface}".` };
  return { surface, ready: false };
});

export const handler = resolver.getDefinitions();
