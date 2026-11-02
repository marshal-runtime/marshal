import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { request } from "node:https";

export interface PushSubscriptionKeys {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** Uncompressed P-256 public point, base64url (the browser's applicationServerKey). */
  publicKey: string;
  privateJwk: { kty: string; crv: string; d: string; x: string; y: string };
}

export type PushSendResult = "sent" | "expired" | "failed";

// Only real browser push services; an authenticated phone must not be able to
// point the Mac at arbitrary URLs.
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const privateJwk = {
    kty: "EC",
    crv: "P-256",
    d: jwk.d ?? "",
    x: jwk.x ?? "",
    y: jwk.y ?? "",
  };
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(privateJwk.x, "base64url"),
    Buffer.from(privateJwk.y, "base64url"),
  ]).toString("base64url");
  return { publicKey, privateJwk };
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** RFC 8291 message encryption, single aes128gcm record (RFC 8188). */
export function encryptPushPayload(
  subscription: PushSubscriptionKeys,
  plaintext: Buffer,
  salt: Buffer = randomBytes(16),
  serverPrivateKey?: Buffer,
): Buffer {
  const serverEcdh = createECDH("prime256v1");
  if (serverPrivateKey) serverEcdh.setPrivateKey(serverPrivateKey);
  else serverEcdh.generateKeys();
  const uaPublic = Buffer.from(subscription.keys.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.keys.auth, "base64url");
  const asPublic = serverEcdh.getPublicKey();
  const ecdhSecret = serverEcdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
    Buffer.from([1]),
  ]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

/** RFC 8292 VAPID Authorization header value. */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string): string {
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: subject,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey({ key: vapid.privateJwk, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `vapid t=${unsigned}.${signature}, k=${vapid.publicKey}`;
}

export function sendWebPush(
  subscription: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidKeys,
  subject: string,
): Promise<PushSendResult> {
  if (!isAllowedPushEndpoint(subscription.endpoint)) return Promise.resolve("expired");
  const body = encryptPushPayload(subscription, Buffer.from(JSON.stringify(payload)));
  return new Promise((resolve) => {
    const req = request(
      subscription.endpoint,
      {
        method: "POST",
        timeout: 10_000,
        headers: {
          TTL: "86400",
          Urgency: "high",
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aes128gcm",
          "Content-Length": body.length,
          Authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
        },
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(
          status >= 200 && status < 300
            ? "sent"
            : status === 404 || status === 410
              ? "expired"
              : "failed",
        );
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve("failed"));
    req.end(body);
  });
}
