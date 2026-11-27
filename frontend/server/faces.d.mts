export type Identity = {
  id: string; name: string | null; created: number; lastSeen: number; lastCamera: string | null;
  sightings: number; samples: number; keys: string[];
};
export type Duplicate = { a: string; b: string; score: number };
export const ID_RE: RegExp;
export const KEY_RE: RegExp;
export const NAME_MAX: number;
export const DUPLICATE_THRESHOLD: number;
export function facesDir(): string;
export function listIdentities(): Identity[] | null;
export function thumbnail(id: string, key: string): Buffer | null;
export function duplicates(threshold?: number, dismissed?: Set<string>): Duplicate[];
export function pairKey(a: string, b: string): string;
export function gallerySimilarity(probes: ArrayLike<number>[], gallery: ArrayLike<number>[]): number;
export function setName(id: string, name: string): boolean;
export function merge(sources: string[], target: string): boolean;
export function forget(ids: string[] | 'all'): number;
export function forgetSamples(id: string, keys: string[]): number;
