import { parseMap, type GameMap } from './sim/map';

// Every map is part of the bundle: they are small, and the room decides which one is played.
const FILES = import.meta.glob<unknown>('../../../shared/maps/*.json', {
  eager: true,
  import: 'default',
});

/** The map with the given name, as the server names it in `welcome`. */
export function loadMap(name: string): GameMap {
  const path = Object.keys(FILES).find((key) => key.endsWith(`/${name}.json`));
  if (!path) throw new Error(`map ${name} is not known to this client`);
  return parseMap(FILES[path]);
}

export const MAP_FILES = Object.keys(FILES).map((key) => key.replace(/^.*\/|\.json$/g, ''));
