export function cameras(): Promise<import('../lib/go2rtc').Camera[]>;
export function allowedStream(id: string): Promise<boolean>;
