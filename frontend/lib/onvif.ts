// Server-only. Minimal ONVIF client for the camera settings the app exposes:
// date/time, image tuning, and vertical flip. ONVIF is the vendor-neutral
// path (README goal), so a different camera brand keeps working.
//
// Responses are parsed with small regexes rather than a full XML parser: we
// only ever read a handful of known leaf elements.
import { createHash, randomBytes } from "node:crypto";

export type Credentials = { host: string; user: string; password: string };

export type TimeSettings = {
  mode: "manual" | "ntp";
  utc: string | null; // camera's clock, ISO 8601
  offsetMinutes: number | null; // camera's local time minus UTC, e.g. -420 for PDT
  ntpServer: string;
};

// What to write. The Anpviz firmware ignores POSIX DST rules and the ONVIF
// DaylightSavings flag (both tested), so the camera only ever gets a fixed UTC
// offset; callers work out the right one for the moment and re-apply after a
// DST change.
export type TimeUpdate = { mode: "manual" | "ntp"; offsetMinutes: number; ntpServer: string };

export type ImageSettings = {
  brightness: number; // 1-255
  contrast: number;
  saturation: number;
  sharpness: number;
  dayNight: "auto" | "day" | "night";
  wdr: boolean;
  backlight: boolean;
};

export type CameraSettings = {
  info: { manufacturer: string; model: string; firmware: string };
  time: TimeSettings;
  image: ImageSettings;
};

const NS =
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
  'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
  'xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl" ' +
  'xmlns:tt="http://www.onvif.org/ver10/schema"';

// ONVIF IrCutFilter: ON = filter in = color (day), OFF = filter out = IR b/w (night).
const IR_CUT = { auto: "AUTO", day: "ON", night: "OFF" } as const;

export async function getSettings(cam: Credentials): Promise<CameraSettings> {
  const vsc = await soap(cam, "media_service", "<trt:GetVideoSourceConfigurations/>");
  const token = text(vsc, "SourceToken");
  if (!token) throw new Error("Camera returned no video source");
  const [info, dt, ntp, img] = await Promise.all([
    soap(cam, "device_service", "<tds:GetDeviceInformation/>"),
    soap(cam, "device_service", "<tds:GetSystemDateAndTime/>", false),
    soap(cam, "device_service", "<tds:GetNTP/>"),
    soap(cam, "imaging_service", imagingBody("GetImagingSettings", token)),
  ]);

  const irCut = text(img, "IrCutFilter");
  return {
    info: {
      manufacturer: text(info, "Manufacturer") ?? "",
      model: text(info, "Model") ?? "",
      firmware: text(info, "FirmwareVersion") ?? "",
    },
    time: {
      mode: text(dt, "DateTimeType") === "NTP" ? "ntp" : "manual",
      utc: parseUtc(section(dt, "UTCDateTime")),
      offsetMinutes: localOffsetMinutes(dt),
      ntpServer: text(ntp, "DNSname") ?? text(ntp, "IPv4Address") ?? "",
    },
    image: {
      brightness: num(img, "Brightness"),
      contrast: num(img, "Contrast"),
      saturation: num(img, "ColorSaturation"),
      sharpness: num(img, "Sharpness"),
      dayNight: irCut === "ON" ? "day" : irCut === "OFF" ? "night" : "auto",
      wdr: text(section(img, "WideDynamicRange"), "Mode") === "ON",
      backlight: text(section(img, "BacklightCompensation"), "Mode") === "ON",
    },
  };
}

// "manual" sets the camera's clock to this server's clock right now.
export async function setTime(cam: Credentials, t: TimeUpdate): Promise<void> {
  if (t.mode === "ntp") {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(t.ntpServer);
    await soap(
      cam,
      "device_service",
      `<tds:SetNTP><tds:FromDHCP>false</tds:FromDHCP><tds:NTPManual>` +
        (isIp
          ? `<tt:Type>IPv4</tt:Type><tt:IPv4Address>${xml(t.ntpServer)}</tt:IPv4Address>`
          : `<tt:Type>DNS</tt:Type><tt:DNSname>${xml(t.ntpServer)}</tt:DNSname>`) +
        `</tds:NTPManual></tds:SetNTP>`,
    );
  }

  const now = new Date();
  const utc =
    t.mode === "manual"
      ? `<tds:UTCDateTime><tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour>` +
        `<tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time>` +
        `<tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month>` +
        `<tt:Day>${now.getUTCDate()}</tt:Day></tt:Date></tds:UTCDateTime>`
      : "";
  try { await soap(
    cam,
    "device_service",
    `<tds:SetSystemDateAndTime><tds:DateTimeType>${t.mode === "ntp" ? "NTP" : "Manual"}</tds:DateTimeType>` +
      `<tds:DaylightSavings>false</tds:DaylightSavings>` +
      `<tds:TimeZone><tt:TZ>${posixOffset(t.offsetMinutes)}</tt:TZ></tds:TimeZone>${utc}</tds:SetSystemDateAndTime>`,
  ); } finally { clockOffset.delete(cam.host); }
}

export async function setImage(cam: Credentials, i: Partial<ImageSettings>): Promise<void> {
  // Element order matters: ONVIF validates against the schema sequence.
  const parts = [
    i.backlight !== undefined && `<tt:BacklightCompensation><tt:Mode>${i.backlight ? "ON" : "OFF"}</tt:Mode></tt:BacklightCompensation>`,
    i.brightness !== undefined && `<tt:Brightness>${i.brightness}</tt:Brightness>`,
    i.saturation !== undefined && `<tt:ColorSaturation>${i.saturation}</tt:ColorSaturation>`,
    i.contrast !== undefined && `<tt:Contrast>${i.contrast}</tt:Contrast>`,
    i.dayNight !== undefined && `<tt:IrCutFilter>${IR_CUT[i.dayNight]}</tt:IrCutFilter>`,
    i.sharpness !== undefined && `<tt:Sharpness>${i.sharpness}</tt:Sharpness>`,
    i.wdr !== undefined && `<tt:WideDynamicRange><tt:Mode>${i.wdr ? "ON" : "OFF"}</tt:Mode></tt:WideDynamicRange>`,
  ].filter(Boolean);
  if (parts.length === 0) return;

  const token = await videoSourceToken(cam);
  await soap(
    cam,
    "imaging_service",
    `<timg:SetImagingSettings><timg:VideoSourceToken>${xml(token)}</timg:VideoSourceToken>` +
      `<timg:ImagingSettings>${parts.join("")}</timg:ImagingSettings>` +
      `<timg:ForcePersistence>true</timg:ForcePersistence></timg:SetImagingSettings>`,
  );
}

// Sent as ONVIF "Rotate 180", but the Anpviz firmware applies it as a vertical
// flip only (top/bottom swap, left/right unchanged), so that's how it's labeled.
// A true 180° (flip + mirror) would need the camera's proprietary API. The
// firmware also never reports the setting back, so callers must remember it.
export async function setFlip(cam: Credentials, on: boolean): Promise<void> {
  const vsc = await soap(cam, "media_service", "<trt:GetVideoSourceConfigurations/>");
  const config = section(vsc, "Configurations");
  const token = /<(?:\w+:)?Configurations[^>]*token="([^"]+)"/.exec(vsc)?.[1];
  const bounds = /<(?:\w+:)?Bounds\s+([^>]*?)\/?>/.exec(config)?.[1];
  if (!token || !bounds) throw new Error("Camera returned no video source configuration");

  await soap(
    cam,
    "media_service",
    `<trt:SetVideoSourceConfiguration><trt:Configuration token="${xml(token)}">` +
      `<tt:Name>${xml(text(config, "Name") ?? token)}</tt:Name>` +
      `<tt:UseCount>${text(config, "UseCount") ?? "1"}</tt:UseCount>` +
      `<tt:SourceToken>${xml(text(config, "SourceToken") ?? token)}</tt:SourceToken>` +
      `<tt:Bounds ${bounds}/>` +
      `<tt:Extension><tt:Rotate><tt:Mode>${on ? "ON" : "OFF"}</tt:Mode>` +
      (on ? `<tt:Degree>180</tt:Degree>` : "") +
      `</tt:Rotate></tt:Extension>` +
      `</trt:Configuration><trt:ForcePersistence>true</trt:ForcePersistence></trt:SetVideoSourceConfiguration>`,
  );
}

async function videoSourceToken(cam: Credentials): Promise<string> {
  const res = await soap(cam, "media_service", "<trt:GetVideoSourceConfigurations/>");
  const token = text(res, "SourceToken");
  if (!token) throw new Error("Camera returned no video source");
  return token;
}

function imagingBody(op: string, token: string): string {
  return `<timg:${op}><timg:VideoSourceToken>${xml(token)}</timg:VideoSourceToken></timg:${op}>`;
}

// POSIX TZ signs are inverted: UTC-7 is "UTC7", UTC+5:30 is "UTC-5:30".
function posixOffset(offsetMinutes: number): string {
  const abs = Math.abs(offsetMinutes);
  const hm = abs % 60 ? `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}` : `${abs / 60}`;
  return `UTC${offsetMinutes > 0 ? "-" : ""}${hm}`;
}

// Derive the offset from the two clocks the camera reports, rather than parse
// its TZ string (firmware rewrites it, e.g. "UTC7" comes back as "MST7").
function localOffsetMinutes(dt: string): number | null {
  const utc = parseUtc(section(dt, "UTCDateTime"));
  const local = parseUtc(section(dt, "LocalDateTime"));
  if (!utc || !local) return null;
  return Math.round((Date.parse(local) - Date.parse(utc)) / 60_000);
}

// --- SOAP transport -------------------------------------------------------

// Camera clocks are often wrong (that's partly why this page exists), and some
// firmware rejects a WS-Security timestamp that's far from its own clock. Sign
// with the camera's time, not ours.
const clockOffset = new Map<string, { offsetMs: number; at: number }>();

async function cameraNow(cam: Credentials): Promise<Date> {
  const cached = clockOffset.get(cam.host);
  if (cached && Date.now() - cached.at < 60_000) return new Date(Date.now() + cached.offsetMs);
  const res = await soap(cam, "device_service", "<tds:GetSystemDateAndTime/>", false);
  const utc = parseUtc(section(res, "UTCDateTime"));
  const offsetMs = utc ? Date.parse(utc) - Date.now() : 0;
  clockOffset.set(cam.host, { offsetMs, at: Date.now() });
  return new Date(Date.now() + offsetMs);
}

async function soap(cam: Credentials, service: string, body: string, auth = true): Promise<string> {
  const header = auth ? await securityHeader(cam) : "";
  let res: Response;
  try {
    res = await fetch(`http://${cam.host}/onvif/${service}`, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}>${header}<s:Body>${body}</s:Body></s:Envelope>`,
      // Applying a change can take the camera several seconds (flip restarts
      // its video pipeline); reads should be quick.
      signal: AbortSignal.timeout(/^<\w+:Set/.test(body) ? 25_000 : 8_000),
      cache: "no-store",
    });
  } catch {
    throw new Error(`Camera at ${cam.host} is not reachable`);
  }
  const xmlText = await res.text();
  if (!res.ok || /<(?:\w+:)?Fault>/.test(xmlText)) {
    const reason = text(xmlText, "Text") ?? `HTTP ${res.status}`;
    if (res.status === 401 || /NotAuthorized|authority/i.test(xmlText)) {
      throw new Error("Camera rejected the username/password");
    }
    throw new Error(`Camera refused the change: ${reason}`);
  }
  return xmlText;
}

async function securityHeader(cam: Credentials): Promise<string> {
  const nonce = randomBytes(16);
  const created = (await cameraNow(cam)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const digest = createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(cam.password)]))
    .digest("base64");
  return (
    `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<UsernameToken><Username>${xml(cam.user)}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    `</UsernameToken></Security></s:Header>`
  );
}

// --- XML helpers ----------------------------------------------------------

function text(xmlText: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${tag}>`).exec(xmlText);
  return m ? decode(m[1]).trim() : undefined;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function section(xmlText: string, tag: string): string {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xmlText);
  return m ? m[1] : "";
}

function num(xmlText: string, tag: string): number {
  return Math.round(Number(text(xmlText, tag) ?? 0));
}

function parseUtc(dt: string): string | null {
  const [y, mo, d, h, mi, s] = ["Year", "Month", "Day", "Hour", "Minute", "Second"].map((t) =>
    Number(text(dt, t)),
  );
  if (!y) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
}

function xml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
