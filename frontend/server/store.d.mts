export function db(): import('node:sqlite').DatabaseSync;
export function readSetting<T = unknown>(key: string, fallback?: T): T;
export function allSettings<T = unknown>(prefix: string): Record<string, T>;
export function writeSetting<T>(key: string, value: T, merge?: boolean): T;
