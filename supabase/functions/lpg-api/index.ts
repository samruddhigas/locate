import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_SECRET = Deno.env.get("SESSION_SECRET")!;
const LEGACY_SALT = "lpg_salt_2526";
const EXPECTED_PROJECT_URL = "https://uggqsvgxjhvdfkddqzyh.supabase.co";

// Fail closed: this function must never run against the retired project, even if
// an operator accidentally configures the wrong SUPABASE_URL secret.
if (!URL || URL.replace(/\/$/, "") !== EXPECTED_PROJECT_URL) {
  throw new Error("Refusing to start: SUPABASE_URL must be the Samruddhi NEW project");
}
if (!SERVICE_KEY || !SESSION_SECRET) {
  throw new Error("Missing required server-side Supabase or session secrets");
}

const db = createClient(URL, SERVICE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const tables = new Set([
  "lpg_masters",
  "lpg_delivered",
  "lpg_pending",
  "lpg_remarks",
  "lpg_gps",
  "lpg_users",
  "lpg_security",
  "lpg_login_log",
]);

const encoder = new TextEncoder();

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );

  return b64(new Uint8Array(signature));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// New PINs use per-account random salts and PBKDF2. The legacy verifier below
// remains only to upgrade existing accounts safely on their next successful login.
function createPinSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode("lpg-pin-v2:" + pin + SESSION_SECRET), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 310000, hash: "SHA-256" },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

async function hashPinLegacy(pin: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(pin + LEGACY_SALT));
  return hex(new Uint8Array(bytes));
}

async function pinFingerprint(pin: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode("lpg-pin-fingerprint:" + pin));
  return hex(new Uint8Array(bytes));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeToken(user: { name: string; role: string }) {
  const payload = b64(
    encoder.encode(
      JSON.stringify({
        name: user.name,
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
      }),
    ),
  );

  return `${payload}.${await sign(payload)}`;
}

async function verifyToken(token: string) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    if ((await sign(parts[0])) !== parts[1]) return null;

    const payload = JSON.parse(decodeBase64Url(parts[0]));
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.name !== "string" || !["admin", "staff", "delivery"].includes(payload.role)) return null;

    // Check the live account on every authenticated request. Disabled users or users
    // whose role/name changed lose access immediately; fail closed on DB errors.
    const { data: liveUser, error: liveUserError } = await db
      .from("lpg_users")
      .select("name,role,active")
      .eq("name", payload.name)
      .eq("role", payload.role)
      .eq("active", true)
      .maybeSingle();
    if (liveUserError || !liveUser || liveUser.name !== payload.name || liveUser.role !== payload.role || liveUser.active !== true) return null;

    return payload as { name: string; role: string; exp: number };
  } catch {
    return null;
  }
}

function parseCsv(text: string): Record<string, string>[] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  if (field.length || row.length) {
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
  }
  if (rows.length < 2) {
    throw new Error("CSV must contain a header and at least one data row");
  }

  const headers = rows[0].map((h) => h.trim());
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV contains duplicate column headers");
  }

  return rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(
        `CSV row ${index + 2} has ${values.length} fields; expected ${headers.length}`,
      );
    }
    const record: Record<string, string> = {};
    headers.forEach((header, i) => { record[header] = values[i].trim(); });
    return record;
  });
}

function csvDate(value: string, dateFormat: string): string | null {
  if (!value) return null;
  if (dateFormat !== "DD/MM/YYYY") {
    throw new Error("Date format must be DD/MM/YYYY");
  }

  const match = value.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/,
  );
  if (!match) {
    throw new Error(`Invalid date "${value}". Expected DD/MM/YYYY, e.g. 01/04/2026`);
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function csvNumber(value: string, column: string): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in ${column}: ${value}`);
  return n;
}
function mapDeliveredCsv(
  csvText: string,
  dateFormat: string,
  dateColumn: string,
): Record<string, unknown>[] {
  if (dateColumn !== "Actual Delivery Date") {
    throw new Error("Date column must be Actual Delivery Date");
  }

  const records = parseCsv(csvText);
  const requiredHeaders = [
    "Order No", "CashMemo No", "Consumer No", "Order Status",
    "Actual Delivery Date", "Order Quantity",
  ];

  const availableHeaders = new Set(Object.keys(records[0]));
  for (const header of requiredHeaders) {
    if (!availableHeaders.has(header)) {
      throw new Error(`Required HPCL CSV column missing: ${header}`);
    }
  }

  const seen = new Set<string>();

  return records.map((r, i) => {
    if ((r["Order Status"] || "").trim().toLowerCase() !== "delivered") {
      throw new Error(`CSV row ${i + 2} is not marked Delivered`);
    }

    const orderNo = (r["Order No"] || "").trim();
    const cashMemo = (r["CashMemo No"] || "").trim();
    const consumerNo = (r["Consumer No"] || "").trim();

    if (!orderNo || !cashMemo || !consumerNo) {
      throw new Error(
        `CSV row ${i + 2} is missing Order No, CashMemo No or Consumer No`,
      );
    }

    const key = JSON.stringify([orderNo, cashMemo, consumerNo]);
    if (seen.has(key)) {
      throw new Error(`Duplicate delivery identifiers in CSV row ${i + 2}`);
    }
    seen.add(key);

    const deliveryDate = csvDate(r[dateColumn] || "", dateFormat);
    if (!deliveryDate) {
      throw new Error(`CSV row ${i + 2} has no delivery date`);
    }

    const quantity = csvNumber(r["Order Quantity"] || "", "Order Quantity");
    if (quantity === null || !Number.isInteger(quantity)) {
      throw new Error(`CSV row ${i + 2} has an invalid Order Quantity`);
    }

    const textValue = (column: string): string | null => {
      const value = (r[column] || "").trim().replace(/^'/, "");
      return value || null;
    };

    const year = Number(deliveryDate.slice(0, 4));
    const month = Number(deliveryDate.slice(5, 7));
    const fyStart = month >= 4 ? year : year - 1;

    return {
      order_no: orderNo,
      cash_memo: cashMemo,
      consumer_no: consumerNo,
      consumer_name: textValue("Consumer Name"),
      nature: textValue("Nature of Consumer"),
      package: textValue("Package Code"),
      delivery_date: deliveryDate,
      delivery_man: textValue("Delivery Man"),
      mobile: textValue("Mobile No."),
      address: textValue("ConsumerAddress"),
      rsp: csvNumber(r["RSP"] || "", "RSP"),
      area: textValue("Delivery Area"),
      ekyc: textValue("Ekyc Status"),
      order_source: textValue("Order Source"),
      ivrs_no: textValue("IVRS BookingNumber"),
      dac_type: textValue("DAC TYPE"),
      qty: quantity,
      fy_key: `FY${fyStart}-${String(fyStart + 1).slice(-2)}`,
    };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return Response.json(
      { error: "POST required" },
      { status: 405, headers: cors },
    );
  }

  if (!URL || !SERVICE_KEY || !SESSION_SECRET) {
    return Response.json(
      { error: "Backend secrets are not configured" },
      { status: 500, headers: cors },
    );
  }

  try {
    const body = await req.json();
    const action = body.action;

    // One-time/admin PIN setup for the NEW project. This action is protected
    // by ADMIN_RESET_SECRET and updates only an existing admin account.
    // It intentionally runs before session-token validation.
    if (action === "setup_admin") {
      const configuredSecret = Deno.env.get("ADMIN_RESET_SECRET") || "";
      const suppliedSecret = String(body.setupSecret || "");
      const name = String(body.name || "").trim();
      const pin = String(body.pin || "");

      if (!configuredSecret || configuredSecret.length < 32) {
        return Response.json(
          { error: "ADMIN_RESET_SECRET is not configured correctly" },
          { status: 500, headers: cors },
        );
      }
      // Fixed-work character comparison; do not log or return either secret.
      if (suppliedSecret.length !== configuredSecret.length) {
        return Response.json({ error: "Invalid setup secret" }, { status: 401, headers: cors });
      }
      let secretDiff = 0;
      for (let i = 0; i < configuredSecret.length; i++) {
        secretDiff |= configuredSecret.charCodeAt(i) ^ suppliedSecret.charCodeAt(i);
      }
      if (secretDiff !== 0) {
        return Response.json({ error: "Invalid setup secret" }, { status: 401, headers: cors });
      }
      if (name.toLowerCase() !== "admin" || !/^\d{4,8}$/.test(pin)) {
        return Response.json(
          { error: "Use username admin and a 4–8 digit PIN" },
          { status: 400, headers: cors },
        );
      }

      const newAdminPinSalt = createPinSalt();
      const newAdminPinHash = await hashPin(pin, newAdminPinSalt);
      const newAdminFingerprint = await pinFingerprint(pin);
      const legacyAdminHash = await hashPinLegacy(pin);
      const [{data:reusedAdminFingerprint,error:adminFingerprintError},{data:reusedAdminLegacy,error:adminLegacyError}] = await Promise.all([
        db.from("lpg_users").select("id").neq("name","admin").eq("pin_fingerprint",newAdminFingerprint).limit(1),
        db.from("lpg_users").select("id").neq("name","admin").is("pin_salt",null).eq("pin_hash",legacyAdminHash).limit(1)
      ]);
      if (adminFingerprintError || adminLegacyError) return Response.json({ error: "Could not verify PIN uniqueness" }, { status: 503, headers: cors });
      if ((reusedAdminFingerprint || []).length || (reusedAdminLegacy || []).length)
        return Response.json({ error: "Choose a PIN not used by another account" }, { status: 409, headers: cors });

      const { data: updatedAdmin, error: updateError } = await db
        .from("lpg_users")
        .update({ pin_hash: newAdminPinHash, pin_salt:newAdminPinSalt, pin_fingerprint:newAdminFingerprint, active: true })
        .eq("name", "admin")
        .eq("role", "admin")
        .select("id,name,role,active")
        .maybeSingle();

      if (updateError) {
        return Response.json(
          { error: updateError.message },
          { status: 400, headers: cors },
        );
      }
      if (!updatedAdmin) {
        return Response.json(
          { error: "Existing admin row not found; no account was changed" },
          { status: 404, headers: cors },
        );
      }
      return Response.json(
        { success: true, message: "Admin PIN updated. Sign in with username admin." },
        { headers: cors },
      );
    }

    // Login is the only action that does not require a session token.
    if (action === "login") {
      const name = String(body.name || "").trim();
      const pin = String(body.pin || "");

      if (!name || !/^\d{4,8}$/.test(pin)) {
        return Response.json(
          { error: "Invalid login" },
          { status: 400, headers: cors },
        );
      }

      const requestIp = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim().slice(0, 80) || null;
      if (requestIp) {
        const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const { count: failedAttempts, error: rateError } = await db.from("lpg_login_log")
          .select("id", { count: "exact", head: true })
          .ilike("name", name).eq("ip", requestIp).eq("success", false)
          .gte("attempted_at", cutoff);
        if (rateError) return Response.json({ error: "Login service is temporarily unavailable" }, { status: 503, headers: cors });
        if ((failedAttempts || 0) >= 10) {
          return Response.json({ error: "Too many failed attempts. Wait 15 minutes and try again." }, { status: 429, headers: cors });
        }
      }

      // Match usernames without regard to capitalization, then enforce exact
      // normalized equality so ILIKE wildcard characters cannot broaden access.
      const { data: matchingUsers, error } = await db
        .from("lpg_users")
        .select("id,name,role,pin_hash,pin_salt,pin_fingerprint,active")
        .ilike("name", name)
        .limit(2);

      const normalizedName = name.toLowerCase();
      const exactMatches = (matchingUsers || []).filter((candidate: any) =>
        String(candidate.name || "").trim().toLowerCase() === normalizedName
      );
      // Refuse ambiguous duplicate usernames rather than authenticating the wrong account.
      const user = exactMatches.length === 1 ? exactMatches[0] : null;

      const pinValid = !!user && (user.pin_salt
        ? constantTimeEqual(user.pin_hash, await hashPin(pin, user.pin_salt))
        : constantTimeEqual(user.pin_hash, await hashPinLegacy(pin)));
      const valid =
        !!user &&
        user.active === true &&
        ["admin", "staff", "delivery"].includes(user.role) &&
        pinValid;

      if (valid && user) {
        const fingerprint = await pinFingerprint(pin);
        if (!user.pin_salt) {
          const salt = createPinSalt();
          const upgradedHash = await hashPin(pin, salt);
          const {data:upgraded,error:upgradeError}=await db.from("lpg_users")
            .update({pin_hash:upgradedHash,pin_salt:salt,pin_fingerprint:fingerprint})
            .eq("id",user.id).eq("pin_hash",user.pin_hash).select("id").maybeSingle();
          if (upgradeError || !upgraded) return Response.json({error:"PIN security upgrade could not be saved. Please retry login."},{status:503,headers:cors});
          user.pin_hash=upgradedHash;user.pin_salt=salt;user.pin_fingerprint=fingerprint;
        } else if (!user.pin_fingerprint) {
          const {error:fingerprintError}=await db.from("lpg_users").update({pin_fingerprint:fingerprint}).eq("id",user.id);
          if (fingerprintError) return Response.json({error:"PIN security update could not be saved. Please retry login."},{status:503,headers:cors});
          user.pin_fingerprint=fingerprint;
        }
      }

      await db.from("lpg_login_log").insert({
        name,
        success: !!valid,
        reason: valid ? "success" : "invalid_login",
        role: valid ? user.role : null,
        ip: requestIp,
      });

      if (!valid || error) {
        return Response.json(
          { error: "Invalid login" },
          { status: 401, headers: cors },
        );
      }

      return Response.json(
        {
          token: await makeToken(user),
          user: { name: user.name, role: user.role },
          expiresIn: 28800,
        },
        { headers: cors },
      );
    }

    // Public, token-scoped identity lookup: disclose only the linked consumer identity.
    if (action === "gps_link_info") {
      const linkToken = String(body.link_token || "").trim();
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(linkToken))
        return Response.json({ error:"Invalid location link" }, { status:400, headers:cors });
      const tokenHash = await sha256Hex(linkToken);
      const { data: link, error: linkErr } = await db.from("lpg_gps_links")
        .select("consumer_no,expires_at,used_at,active").eq("token_hash", tokenHash).maybeSingle();
      if (linkErr) return Response.json({error:"Location link is temporarily unavailable"},{status:503,headers:cors});
      if (!link || !link.active || link.used_at || Date.parse(link.expires_at) < Date.now())
        return Response.json({error:"ही लोकेशन लिंक कालबाह्य झाली आहे किंवा वापरली गेली आहे. एजन्सीकडून नवीन लिंक मागवा."},{status:410,headers:cors});
      const { data: consumer, error: consumerErr } = await db.from("lpg_masters")
        .select("consumer_no,consumer_name,area").eq("consumer_no", link.consumer_no).maybeSingle();
      if (consumerErr) return Response.json({error:"ग्राहकाची माहिती सध्या मिळू शकत नाही."},{status:503,headers:cors});
      if (!consumer) return Response.json({error:"या ग्राहक क्रमांकाची नोंद मास्टर डेटाबेसमध्ये सापडली नाही. एजन्सीशी संपर्क साधा."},{status:404,headers:cors});
      return Response.json({consumer_no:consumer.consumer_no,consumer_name:consumer.consumer_name || "",area:consumer.area || ""},{headers:cors});
    }

    // Public consumer capture: a one-time, expiring random token is required.
    // This endpoint never exposes consumer records or the GPS registry.
    if (action === "gps_link_capture") {
      const linkToken = String(body.link_token || "").trim();
      const rawLat = Number(body.raw_lat ?? body.lat), rawLng = Number(body.raw_lng ?? body.lng);
      const pinLat = Number(body.pin_lat ?? body.lat), pinLng = Number(body.pin_lng ?? body.lng);
      const acc = Number(body.acc);
      const validCoord = (a:number,b:number) => Number.isFinite(a) && a >= -90 && a <= 90 && Number.isFinite(b) && b >= -180 && b <= 180;
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(linkToken) || !validCoord(rawLat,rawLng) || !validCoord(pinLat,pinLng) || !Number.isFinite(acc) || acc <= 0 || acc > 30)
        return Response.json({error:"Invalid capture request: a fresh GPS fix with accuracy within 30 metres is required"},{status:400,headers:cors});
      const readings = Array.isArray(body.readings) ? body.readings.slice(-20) : [];
      const cleanReadings = readings.map((r:any) => ({lat:Number(r?.lat),lng:Number(r?.lng),acc:Number(r?.acc),ts:Number(r?.ts)}))
        .filter((r:any) => validCoord(r.lat,r.lng) && Number.isFinite(r.acc) && r.acc > 0 && r.acc <= 30 && Number.isFinite(r.ts) && Math.abs(Date.now()-r.ts) <= 5*60*1000);
      if (cleanReadings.length < 1)
        return Response.json({error:"At least one recent GPS fix is required"},{status:400,headers:cors});
      if (cleanReadings.some((r:any) => r.acc > 30))
        return Response.json({error:"GPS reading accuracy exceeds 30 metres"},{status:400,headers:cors});
      const pinOffset=Math.hypot((pinLat-rawLat)*111320,(pinLng-rawLng)*111320*Math.cos(rawLat*Math.PI/180));
      if (pinOffset > 500) return Response.json({error:"The entrance pin is too far from the captured GPS position. Please check the correct house."},{status:400,headers:cors});
      const tokenHash=await sha256Hex(linkToken);
      const {data:link,error:linkErr}=await db.from("lpg_gps_links").select("id,consumer_no,expires_at,used_at,active").eq("token_hash",tokenHash).maybeSingle();
      if(linkErr) return Response.json({error:"Location link is temporarily unavailable"},{status:503,headers:cors});
      if(!link||!link.active||link.used_at||Date.parse(link.expires_at)<Date.now()) return Response.json({error:"This location link has expired or has already been used. Please request a new link."},{status:410,headers:cors});
      const {data:old,error:oldErr}=await db.from("lpg_gps").select("status").eq("consumer_no",link.consumer_no).maybeSingle();
      if(oldErr) return Response.json({error:"Could not verify location status"},{status:503,headers:cors});
      if(old?.status==="approved") return Response.json({error:"A verified location is already saved. Please contact the agency for correction."},{status:409,headers:cors});
      const usedAt=new Date().toISOString();
      const {data:claimed,error:claimErr}=await db.from("lpg_gps_links").update({used_at:usedAt,active:false})
        .eq("id",link.id).eq("active",true).is("used_at",null).select("id").maybeSingle();
      if(claimErr) return Response.json({error:"Could not validate location link"},{status:503,headers:cors});
      if(!claimed) return Response.json({error:"This location link has already been used. Please request a new link."},{status:410,headers:cors});
      const row={consumer_no:link.consumer_no,lat:pinLat,lng:pinLng,acc,count:cleanReadings.length,status:"capturing",source:"CONSUMER_WHATSAPP",dm_name:"Consumer shared location",raw_lat:rawLat,raw_lng:rawLng,pin_lat:pinLat,pin_lng:pinLng,capture_mode:"consumer_whatsapp",captured_at:usedAt};
      const {data:saved,error:saveErr}=await db.from("lpg_gps").upsert(row,{onConflict:"consumer_no"}).select("consumer_no").single();
      if(saveErr) {
        await db.from("lpg_gps_links").update({used_at:null,active:true}).eq("id",link.id).eq("used_at",usedAt);
        return Response.json({error:"Could not save location. Please retry."},{status:503,headers:cors});
      }
      const {error:historyErr}=await db.from("lpg_gps_history").insert({consumer_no:link.consumer_no,raw_lat:rawLat,raw_lng:rawLng,pin_lat:pinLat,pin_lng:pinLng,acc,reading_count:cleanReadings.length,readings:cleanReadings,pin_offset_m:Number(pinOffset.toFixed(2)),source:"CONSUMER_WHATSAPP",capture_mode:"consumer_whatsapp",captured_by:"Consumer",status:"capturing",captured_at:usedAt});
      if(historyErr) return Response.json({success:true,history_saved:false,message:"Location saved; capture history needs database migration."},{headers:cors});
      return Response.json({success:true,history_saved:true,consumer_no:saved.consumer_no,message:"Location and entrance pin saved"},{headers:cors});
    }

    // Custom session token is sent in x-session-token.
    const token = (req.headers.get("x-session-token") || "").trim();
    const user = await verifyToken(token);

    if (!user) {
      return Response.json(
        { error: "Session expired or invalid" },
        { status: 401, headers: cors },
      );
    }

    // Office-published, date-specific route sequences. Only approved customer GPS pins
    // can be published; area-centre estimates remain planning hints, never delivery stops.
    if (action === "route_manage") {
      const op = String(body.op || "");
      const validDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
        !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
      const routeDate = String(body.route_date || new Date().toISOString().slice(0,10));
      if (!validDate(routeDate)) return Response.json({error:"Route date must use YYYY-MM-DD"}, {status:400,headers:cors});

      if (op === "list") {
        let deliveryMan = user.role === "delivery" ? user.name : String(body.delivery_man || "");
        if (user.role !== "delivery" && !["admin","staff"].includes(user.role))
          return Response.json({error:"Route access denied"}, {status:403,headers:cors});
        let routeQuery = db.from("lpg_delivery_routes").select("*")
          .eq("route_date",routeDate).eq("status","published")
          .order("published_at",{ascending:false}).limit(1);
        if (deliveryMan) routeQuery = routeQuery.eq("delivery_man",deliveryMan);
        const {data:routes,error:routeError}=await routeQuery;
        if (routeError) return Response.json({error:"Could not load published route"}, {status:503,headers:cors});
        const routeRow=routes?.[0]||null;
        if (!routeRow) return Response.json({route:null,stops:[]},{headers:cors});
        const {data:stops,error:stopsError}=await db.from("lpg_delivery_route_stops")
          .select("booking_key,consumer_no,stop_order,lat,lng,dist_from_prev_km")
          .eq("route_id",routeRow.id).order("stop_order",{ascending:true});
        if (stopsError) return Response.json({error:"Could not load route stops"}, {status:503,headers:cors});
        return Response.json({route:routeRow,stops:stops||[]},{headers:cors});
      }

      if (op !== "publish") return Response.json({error:"Unsupported route operation"}, {status:400,headers:cors});
      if (!["admin","staff"].includes(user.role))
        return Response.json({error:"Office admin or staff permission required to publish routes"}, {status:403,headers:cors});
      const deliveryMan=String(body.delivery_man||"").trim();
      const inputStops=Array.isArray(body.stops)?body.stops:[];
      if (!deliveryMan || deliveryMan.length>100 || inputStops.length<1 || inputStops.length>500)
        return Response.json({error:"Choose a delivery boy and provide 1–500 approved GPS stops"}, {status:400,headers:cors});
      const {data:deliveryUser,error:deliveryUserError}=await db.from("lpg_users")
        .select("name").eq("name",deliveryMan).eq("role","delivery").eq("active",true).maybeSingle();
      if (deliveryUserError) return Response.json({error:"Could not verify delivery account"}, {status:503,headers:cors});
      if (!deliveryUser) return Response.json({error:"Selected delivery boy does not have an active delivery account"}, {status:400,headers:cors});

      const seenKeys=new Set<string>();
      const requested=inputStops.map((stop:any,index:number)=>({
        booking_key:String(stop?.booking_key||"").trim(),
        consumer_no:String(stop?.consumer_no||"").trim(),
        stop_order:Number(stop?.stop_order||index+1)
      }));
      if (requested.some((s:any)=>!s.booking_key||s.booking_key.length>120||!s.consumer_no||s.consumer_no.length>40||
          !Number.isInteger(s.stop_order)||s.stop_order<1||s.stop_order>500||seenKeys.has(s.booking_key)||
          (seenKeys.add(s.booking_key),false))) {
        return Response.json({error:"Route contains invalid or duplicate booking stops"}, {status:400,headers:cors});
      }
      requested.sort((a:any,b:any)=>a.stop_order-b.stop_order);
      if (new Set(requested.map((s:any)=>s.stop_order)).size!==requested.length)
        return Response.json({error:"Route stop numbers must be unique"}, {status:400,headers:cors});

      const consumerNos=[...new Set(requested.map((s:any)=>s.consumer_no))];
      const {data:assignments,error:assignmentError}=await db.from("lpg_pending")
        .select("id,order_no,consumer_no,qty,delivery_man")
        .eq("delivery_man",deliveryMan).in("consumer_no",consumerNos);
      if (assignmentError) return Response.json({error:"Could not verify pending assignments"}, {status:503,headers:cors});
      const {data:gpsRows,error:gpsError}=await db.from("lpg_gps")
        .select("consumer_no,lat,lng,pin_lat,pin_lng,status,source")
        .in("consumer_no",consumerNos);
      if (gpsError) return Response.json({error:"Could not verify approved customer GPS pins"}, {status:503,headers:cors});
      const {data:temporaryRows,error:temporaryError}=await db.from("lpg_gps_temporary")
        .select("consumer_no,lat,lng,status,confirmation_count")
        .in("consumer_no",consumerNos).eq("status","temporary_approved");
      if (temporaryError) return Response.json({error:"Could not verify temporary delivery-location pins"}, {status:503,headers:cors});
      const gpsByConsumer=new Map((gpsRows||[]).filter((g:any)=>g.status==="approved"||g.source==="staff_pin").map((g:any)=>[String(g.consumer_no),g]));
      const temporaryByConsumer=new Map((temporaryRows||[]).map((g:any)=>[String(g.consumer_no),g]));
      const routeStops:any[]=[];
      for(const stop of requested){
        const assigned=(assignments||[]).find((r:any)=>String(r.consumer_no)===stop.consumer_no &&
          (String(r.order_no||"")===stop.booking_key || String(r.id||"")===stop.booking_key));
        if(!assigned) return Response.json({error:"Booking "+stop.booking_key+" is not assigned to "+deliveryMan}, {status:409,headers:cors});
        const gps:any=gpsByConsumer.get(stop.consumer_no);
        const temporary:any=temporaryByConsumer.get(stop.consumer_no);
        const location=gps||temporary;
        const lat=Number(gps?.pin_lat??gps?.lat??temporary?.lat),lng=Number(gps?.pin_lng??gps?.lng??temporary?.lng);
        if(!location||!Number.isFinite(lat)||lat < -90||lat>90||!Number.isFinite(lng)||lng < -180||lng>180)
          return Response.json({error:"Consumer "+stop.consumer_no+" has no office-approved or 3-delivery temporary GPS pin"}, {status:409,headers:cors});
        routeStops.push({...stop,lat,lng,location_source:gps?(gps.source==="staff_pin"?"office_manual_pin":"office_approved"):"temporary_3_delivery"});
      }

      const {data:depot,error:depotError}=await db.from("lpg_locations")
        .select("lat,lng").eq("is_default",true).maybeSingle();
      if(depotError||!depot||!Number.isFinite(Number(depot.lat))||!Number.isFinite(Number(depot.lng)))
        return Response.json({error:"A shared default depot location must be configured before publishing routes"}, {status:409,headers:cors});
      const km=(a:any,b:any)=>{const rad=Math.PI/180,dLat=(b.lat-a.lat)*rad,dLng=(b.lng-a.lng)*rad;
        const x=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLng/2)**2;
        return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));};
      let previous={lat:Number(depot.lat),lng:Number(depot.lng)},total=0;
      const stopRows=routeStops.map((stop:any)=>{const distance=km(previous,stop);previous={lat:stop.lat,lng:stop.lng};total+=distance;
        return {booking_key:stop.booking_key,consumer_no:stop.consumer_no,stop_order:stop.stop_order,lat:stop.lat,lng:stop.lng,dist_from_prev_km:Number(distance.toFixed(3))};});
      total+=km(previous,{lat:Number(depot.lat),lng:Number(depot.lng)});
      const routeVersion=crypto.randomUUID();
      const {data:newRoute,error:createRouteError}=await db.from("lpg_delivery_routes").insert({
        route_date:routeDate,delivery_man:deliveryMan,route_version:routeVersion,status:"published",
        stop_count:stopRows.length,total_distance_km:Number(total.toFixed(2)),published_by:user.name
      }).select("*").single();
      if(createRouteError||!newRoute) return Response.json({error:"Could not create route version"}, {status:503,headers:cors});
      const {error:insertStopsError}=await db.from("lpg_delivery_route_stops").insert(stopRows.map((s:any)=>({...s,route_id:newRoute.id})));
      if(insertStopsError){
        await db.from("lpg_delivery_routes").delete().eq("id",newRoute.id);
        return Response.json({error:"Route stops could not be saved; previous route remains active"}, {status:503,headers:cors});
      }
      const {error:supersedeError}=await db.from("lpg_delivery_routes").update({status:"superseded"})
        .eq("route_date",routeDate).eq("delivery_man",deliveryMan).eq("status","published").neq("id",newRoute.id);
      if(supersedeError) return Response.json({error:"New route saved, but previous route could not be superseded. Refresh route status before republishing."}, {status:503,headers:cors});
      return Response.json({success:true,route:newRoute,stops:stopRows,total_distance_km:Number(total.toFixed(2))},{headers:cors});
    }

    // Server-authoritative delivery completion. A completion is accepted only when
    // the signed-in delivery user owns the currently assigned booking and a valid
    // GPS record already exists for that consumer. The booking key makes retries idempotent.
    if (action === "delivery_completion") {
      const op = String(body.op || "");
      if (op === "list") {
        let query = db.from("lpg_delivery_completions")
          .select("booking_key,consumer_no,order_no,delivery_man,qty,completed_at,gps_status,location_check_status,location_distance_m,temporary_location_status,location_exception_id")
          .order("completed_at", { ascending: false }).limit(10000);
        if (user.role === "delivery") query = query.eq("delivery_man", user.name);
        else if (!["admin", "staff"].includes(user.role))
          return Response.json({ error: "Delivery completion access denied" }, { status: 403, headers: cors });
        const { data, error } = await query;
        if (error) return Response.json({ error: "Could not load saved delivery completions" }, { status: 503, headers: cors });
        return Response.json({ data: data || [] }, { headers: cors });
      }
      if (op !== "save") return Response.json({ error: "Unsupported delivery completion operation" }, { status: 400, headers: cors });
      if (user.role !== "delivery") return Response.json({ error: "Only the assigned delivery account can submit delivery completion" }, { status: 403, headers: cors });

      const bookingKey = String(body.booking_key || "").trim();
      const consumerNo = String(body.consumer_no || "").trim();
      const completedAtInput = body.completed_at ? String(body.completed_at) : new Date().toISOString();
      const completedAt = new Date(completedAtInput);
      if (!bookingKey || bookingKey.length > 120 || !consumerNo || consumerNo.length > 40 ||
          Number.isNaN(completedAt.getTime()) || completedAt.getTime() > Date.now() + 5 * 60 * 1000 ||
          completedAt.getTime() < Date.now() - 48 * 60 * 60 * 1000) {
        return Response.json({ error: "Invalid booking completion details" }, { status: 400, headers: cors });
      }

      const { data: existingCompletion, error: existingCompletionError } = await db
        .from("lpg_delivery_completions")
        .select("booking_key,consumer_no,delivery_man,completed_at,gps_captured_at,gps_lat,gps_lng,gps_accuracy,location_check_status,location_distance_m,temporary_location_status,location_exception_id")
        .eq("booking_key", bookingKey).maybeSingle();
      if (existingCompletionError) return Response.json({ error: "Could not verify existing completion" }, { status: 503, headers: cors });
      if (existingCompletion) {
        if (existingCompletion.delivery_man !== user.name || existingCompletion.consumer_no !== consumerNo)
          return Response.json({ error: "This booking is already completed under another account" }, { status: 409, headers: cors });
        let retryLocationCheck:any=null;
        const checkStatus=String(existingCompletion.location_check_status||"not_checked");
        const terminalChecks=["matched_approved","nearby_warning","deviation","candidate","provisional","temporary_approved","outlier_review","same_day_repeat"];
        if(existingCompletion.gps_lat!==null&&existingCompletion.gps_lat!==undefined&&
           existingCompletion.gps_lng!==null&&existingCompletion.gps_lng!==undefined&&
           existingCompletion.gps_accuracy!==null&&existingCompletion.gps_captured_at&&!terminalChecks.includes(checkStatus)){
          const {data:check,error:checkError}=await db.rpc("record_lpg_delivery_location_observation",{
            p_booking_key:bookingKey,p_consumer_no:consumerNo,p_delivery_man:user.name,
            p_lat:Number(existingCompletion.gps_lat),p_lng:Number(existingCompletion.gps_lng),
            p_accuracy:Number(existingCompletion.gps_accuracy),p_captured_at:existingCompletion.gps_captured_at,
            p_exception_reason:String(body.exception_reason||"").slice(0,300)||null
          });
          if(checkError)return Response.json({error:"Delivery was already saved, but its location check still needs retry: "+checkError.message,completion_saved:true},{status:503,headers:cors});
          retryLocationCheck=check||{result:"not_checked"};
          await db.from("lpg_delivery_completions").update({
            gps_status:"captured_"+String(retryLocationCheck.result||"checked"),
            location_check_status:String(retryLocationCheck.result||"checked"),
            location_distance_m:retryLocationCheck.distance_m??null,
            temporary_location_status:["candidate","provisional","temporary_approved"].includes(retryLocationCheck.result)?retryLocationCheck.result:null,
            location_exception_id:retryLocationCheck.exception_id??null
          }).eq("booking_key",bookingKey);
        }
        return Response.json({success:true,already_saved:true,completion:existingCompletion,
          location_check:retryLocationCheck||{result:checkStatus,distance_m:existingCompletion.location_distance_m,
          exception_id:existingCompletion.location_exception_id}},{headers:cors});
      }

      const { data: assignments, error: assignmentError } = await db.from("lpg_pending")
        .select("id,order_no,consumer_no,qty,delivery_man")
        .eq("consumer_no", consumerNo).eq("delivery_man", user.name).limit(100);
      if (assignmentError) return Response.json({ error: "Could not verify this booking assignment" }, { status: 503, headers: cors });
      const assigned = (assignments || []).find((row: any) =>
        String(row.order_no || "") === bookingKey || String(row.id || "") === bookingKey
      );
      if (!assigned) return Response.json({ error: "This booking is no longer assigned to your delivery account. Refresh bookings and contact the office if this is incorrect." }, { status: 403, headers: cors });

      const captureWindowStart = new Date(completedAt.getTime() - 30 * 60 * 1000).toISOString();
      const captureWindowEnd = new Date(completedAt.getTime() + 5 * 60 * 1000).toISOString();
      const {data:visitGps,error:visitGpsError}=await db.from("lpg_gps_history")
        .select("booking_key,raw_lat,raw_lng,pin_lat,pin_lng,acc,captured_at,capture_mode")
        .eq("booking_key",bookingKey).eq("consumer_no",consumerNo).eq("captured_by",user.name)
        .eq("capture_mode","delivery_after_mark_delivered")
        .gte("captured_at",captureWindowStart).lte("captured_at",captureWindowEnd)
        .order("captured_at",{ascending:false}).limit(1).maybeSingle();
      if(visitGpsError) return Response.json({error:"Could not verify this delivery's GPS observation: "+visitGpsError.message},{status:503,headers:cors});
      // Only the exact GPS history row for this booking, consumer and signed-in delivery user
      // may prove this visit. Never fall back to the consumer master pin or another visit.
      const gpsLat=Number(visitGps?.pin_lat);
      const gpsLng=Number(visitGps?.pin_lng);
      const gpsAccuracy=Number(visitGps?.acc);
      const gpsCapturedAt=visitGps?.captured_at ?? null;
      const gpsTime=gpsCapturedAt ? Date.parse(gpsCapturedAt) : NaN;
      const hasUsableGps=!!visitGps && visitGps.booking_key===bookingKey && visitGps.capture_mode==="delivery_after_mark_delivered" &&
        Number.isFinite(gpsLat)&&gpsLat>=-90&&gpsLat<=90&&Number.isFinite(gpsLng)&&gpsLng>=-180&&gpsLng<=180&&
        Number.isFinite(gpsAccuracy)&&gpsAccuracy>0&&gpsAccuracy<=30&&Number.isFinite(gpsTime)&&
        gpsTime>=completedAt.getTime()-30*60*1000&&gpsTime<=completedAt.getTime()+5*60*1000;

      if(!hasUsableGps) return Response.json({error:"Delivery cannot be marked done: a fresh GPS reading for this exact booking (1–30 m accuracy) has not been saved. Capture GPS again and retry."},{status:422,headers:cors});

      const record = {
        booking_key: bookingKey, consumer_no: consumerNo,
        order_no: assigned.order_no || null, pending_id: assigned.id,
        delivery_man: user.name, qty: Math.max(1, Number(assigned.qty) || 1),
        completed_at: completedAt.toISOString(), gps_captured_at: hasUsableGps ? gpsCapturedAt : null,
        gps_lat: hasUsableGps ? gpsLat : null, gps_lng: hasUsableGps ? gpsLng : null,
        gps_accuracy: hasUsableGps ? gpsAccuracy : null,
        gps_status: hasUsableGps ? "captured_pending_location_check" : "not_captured",
        source: "deliveryapp"
      };
      const { data, error } = await db.from("lpg_delivery_completions")
        .insert(record).select("booking_key,consumer_no,order_no,delivery_man,qty,completed_at").single();
      if (error) {
        if (error.code === "23505") {
          const { data: raced } = await db.from("lpg_delivery_completions")
            .select("booking_key,consumer_no,delivery_man,completed_at").eq("booking_key", bookingKey).maybeSingle();
          if (raced?.delivery_man === user.name && raced?.consumer_no === consumerNo)
            return Response.json({ success: true, already_saved: true, completion: raced }, { headers: cors });
          return Response.json({ error: "This booking was completed by another session. Refresh bookings." }, { status: 409, headers: cors });
        }
        return Response.json({ error: "Could not save delivery completion: " + error.message }, { status: 503, headers: cors });
      }
      let locationCheck:any={result:"not_checked"};
      if(hasUsableGps){
        const {data:check,error:checkError}=await db.rpc("record_lpg_delivery_location_observation",{
          p_booking_key:bookingKey,p_consumer_no:consumerNo,p_delivery_man:user.name,
          p_lat:gpsLat,p_lng:gpsLng,p_accuracy:gpsAccuracy,p_captured_at:gpsCapturedAt,
          p_exception_reason:String(body.exception_reason||"").slice(0,300)||null
        });
        if(checkError){
          await db.from("lpg_delivery_completions").update({gps_status:"captured_location_check_failed",location_check_status:"check_failed"}).eq("booking_key",bookingKey);
          return Response.json({error:"Delivery GPS was captured, but location verification could not be completed: "+checkError.message,completion_saved:true},{status:503,headers:cors});
        }
        locationCheck=check||{result:"not_checked"};
        await db.from("lpg_delivery_completions").update({
          gps_status:"captured_"+String(locationCheck.result||"checked"),
          location_check_status:String(locationCheck.result||"checked"),
          location_distance_m:locationCheck.distance_m??null,
          temporary_location_status:["candidate","provisional","temporary_approved"].includes(locationCheck.result)?locationCheck.result:null,
          location_exception_id:locationCheck.exception_id??null
        }).eq("booking_key",bookingKey);
      }
      return Response.json({success:true,completion:data,location_check:locationCheck},{headers:cors});
    }

    // Central persistent locations shared across devices/sessions. Read for all roles; mutate only admins.
    if (action === "locations_manage") {
      const op = String(body.op || "");
      if (op === "list") {
        const { data, error } = await db.from("lpg_locations").select("id,label,kind,lat,lng,active,is_default,created_at,updated_at").eq("active",true).order("label");
        if (error) return Response.json({error:"Could not load saved locations"},{status:503,headers:cors});
        return Response.json({locations:data||[]},{headers:cors});
      }
      if (user.role !== "admin") return Response.json({error:"Admin permission required"},{status:403,headers:cors});
      const label=String(body.label||"").trim(), kind=String(body.kind||"other");
      const lat=Number(body.lat), lng=Number(body.lng);
      if (["create","update"].includes(op) && (!label || label.length>100 || !["depot","godown","showroom","other"].includes(kind) || !Number.isFinite(lat)||lat < -90||lat>90||!Number.isFinite(lng)||lng < -180||lng>180))
        return Response.json({error:"Enter a valid location name, type, latitude and longitude"},{status:400,headers:cors});
      if (op === "set_default") {
        const id=String(body.id||"");
        const {data:chosen,error:chosenErr}=await db.from("lpg_locations").select("id").eq("id",id).eq("active",true).maybeSingle();
        if(chosenErr||!chosen) return Response.json({error:"Location not found or inactive"},{status:404,headers:cors});
        const {error:clearErr}=await db.from("lpg_locations").update({is_default:false,updated_at:new Date().toISOString()}).eq("is_default",true);
        if(clearErr) return Response.json({error:"Could not update default location"},{status:503,headers:cors});
        const {data,error}=await db.from("lpg_locations").update({is_default:true,updated_at:new Date().toISOString()}).eq("id",id).select("id,label,kind,lat,lng,active,is_default").single();
        if(error) return Response.json({error:"Could not set default location"},{status:503,headers:cors});
        return Response.json({success:true,location:data},{headers:cors});
      }
      if (op === "create") {
        const {data:existing,error:findErr}=await db.from("lpg_locations").select("id").ilike("label",label).maybeSingle();
        if (findErr) return Response.json({error:"Could not check location name"},{status:503,headers:cors});
        if (existing) return Response.json({error:"A location with this name already exists"},{status:409,headers:cors});
        const {data,error}=await db.from("lpg_locations").insert({label,kind,lat,lng,created_by:user.name}).select("id,label,kind,lat,lng,active").single();
        if (error) return Response.json({error:"Could not save location"},{status:400,headers:cors});
        return Response.json({success:true,location:data},{headers:cors});
      }
      if (op === "update") {
        const id=String(body.id||"");
        const {data,error}=await db.from("lpg_locations").update({label,kind,lat,lng,updated_at:new Date().toISOString()}).eq("id",id).select("id,label,kind,lat,lng,active").maybeSingle();
        if (error||!data) return Response.json({error:"Could not update location"},{status:400,headers:cors});
        return Response.json({success:true,location:data},{headers:cors});
      }
      if (op === "deactivate") {
        const id=String(body.id||"");
        const {error}=await db.from("lpg_locations").update({active:false,updated_at:new Date().toISOString()}).eq("id",id);
        if (error) return Response.json({error:"Could not remove location"},{status:400,headers:cors});
        return Response.json({success:true},{headers:cors});
      }
      return Response.json({error:"Unsupported locations_manage operation"},{status:400,headers:cors});
    }

    // Admin-only account creation: avoid browser-side table client issues and enforce duplicate checks server-side.
    if (action === "users_manage") {
      if (user.role !== "admin") return Response.json({ error: "Admin permission required" }, { status: 403, headers: cors });
      const op = String(body.op || "");
      if (op === "list") {
        const {data,error}=await db.from("lpg_users")
          .select("id,role,name,active,created_by,created_at").order("role").order("name");
        if(error)return Response.json({error:"Could not load user accounts"},{status:503,headers:cors});
        return Response.json({data:data||[]},{headers:cors});
      }
      if (op === "set_active" || op === "reset_pin") {
        const name=String(body.name||"").trim(),role=String(body.role||"").trim();
        if(!name||name.length>100||!["staff","delivery"].includes(role))
          return Response.json({error:"A valid staff or delivery account is required"},{status:400,headers:cors});
        const {data:target,error:targetError}=await db.from("lpg_users")
          .select("id,name,role,active").eq("name",name).eq("role",role).maybeSingle();
        if(targetError)return Response.json({error:"Could not verify selected account"},{status:503,headers:cors});
        if(!target)return Response.json({error:"User account not found"},{status:404,headers:cors});
        if(op==="set_active"){
          if(typeof body.active!=="boolean")return Response.json({error:"active must be true or false"},{status:400,headers:cors});
          const {data,error}=await db.from("lpg_users").update({active:body.active})
            .eq("id",target.id).select("id,name,role,active").single();
          if(error)return Response.json({error:error.message},{status:400,headers:cors});
          return Response.json({data},{headers:cors});
        }
        const pin=String(body.pin||"");
        if(!/^\\d{4,8}$/.test(pin))return Response.json({error:"PIN must be 4–8 digits"},{status:400,headers:cors});
        const salt=createPinSalt(),pinHash=await hashPin(pin,salt),fingerprint=await pinFingerprint(pin),legacyHash=await hashPinLegacy(pin);
        const [{data:reusedFingerprint,error:fingerprintError},{data:reusedLegacy,error:legacyError}]=await Promise.all([
          db.from("lpg_users").select("id").neq("id",target.id).eq("pin_fingerprint",fingerprint).limit(1),
          db.from("lpg_users").select("id").neq("id",target.id).is("pin_salt",null).eq("pin_hash",legacyHash).limit(1)
        ]);
        if(fingerprintError||legacyError)return Response.json({error:"Could not verify PIN uniqueness"},{status:503,headers:cors});
        if((reusedFingerprint||[]).length||(reusedLegacy||[]).length)
          return Response.json({error:"This PIN is already used by another account. Choose a different PIN."},{status:409,headers:cors});
        const {data,error}=await db.from("lpg_users").update({pin_hash:pinHash,pin_salt:salt,pin_fingerprint:fingerprint})
          .eq("id",target.id).select("id,name,role,active").single();
        if(error)return Response.json({error:error.message},{status:400,headers:cors});
        return Response.json({data,success:true},{headers:cors});
      }
      if (op !== "create") return Response.json({ error: "Unsupported users_manage operation" }, { status: 400, headers: cors });
      const role = String(body.role || "").trim();
      const name = String(body.name || "").trim();
      const pin = String(body.pin || "");
      if (!["staff", "delivery"].includes(role)) return Response.json({ error: "Role must be staff or delivery" }, { status: 400, headers: cors });
      if (!name || name.length > 100 || /[\\u0000-\\u001f]/.test(name)) return Response.json({ error: "Name is required and must be 100 characters or less" }, { status: 400, headers: cors });
      if (!/^\\d{4,8}$/.test(pin)) return Response.json({ error: "PIN must be 4–8 digits" }, { status: 400, headers: cors });
      const { data: existing, error: existingError } = await db.from("lpg_users").select("id,name,role").ilike("name", name).limit(5);
      if (existingError) return Response.json({ error: "Account duplicate check failed" }, { status: 400, headers: cors });
      if ((existing || []).some((u:any) => String(u.name).toLowerCase() === name.toLowerCase())) return Response.json({ error: "An account with this name already exists. Names must be unique across roles." }, { status: 409, headers: cors });
      const newUserPinSalt=createPinSalt(),newUserPinHash=await hashPin(pin,newUserPinSalt),newUserFingerprint=await pinFingerprint(pin),legacyUserHash=await hashPinLegacy(pin);
      const [{data:reusedFingerprint,error:fingerprintError},{data:reusedLegacy,error:legacyError}]=await Promise.all([
        db.from("lpg_users").select("id").eq("pin_fingerprint",newUserFingerprint).limit(1),
        db.from("lpg_users").select("id").is("pin_salt",null).eq("pin_hash",legacyUserHash).limit(1)
      ]);
      if(fingerprintError||legacyError)return Response.json({error:"Could not verify PIN uniqueness"},{status:503,headers:cors});
      if((reusedFingerprint||[]).length||(reusedLegacy||[]).length)
        return Response.json({error:"Each staff member must have a different PIN. Choose an unused PIN."},{status:409,headers:cors});
      const { data: created, error: createError } = await db.from("lpg_users").insert({ role, name, pin_hash: newUserPinHash, pin_salt:newUserPinSalt, pin_fingerprint:newUserFingerprint, active: true, created_by: user.name }).select("id,role,name,active,created_by,created_at").single();
      if (createError) return Response.json({ error: createError.message }, { status: 400, headers: cors });
      return Response.json({ data: created }, { headers: cors });
    }

    // Delivery-team consumer lookup for the initial GPS mapping campaign.
    // Returns only minimum identity/address fields; delivery users cannot browse other tables.
    if (action === "gps_search_consumers") {
      if (!["admin", "staff", "delivery"].includes(user.role))
        return Response.json({ error: "Consumer lookup not permitted" }, { status: 403, headers: cors });
      const q = String(body.q || "").trim().slice(0, 80);
      const area = String(body.area || "").trim().slice(0, 160);
      let query = db.from("lpg_masters").select("consumer_no,consumer_name,area,address,mobile,status")
        .order("consumer_name", { ascending: true }).limit(60);
      if (area) query = query.eq("area", area);
      if (q) {
        // Search consumer number, name, or address without exposing the full master.
        query = query.or(`consumer_no.ilike.%${q.replace(/[,%()]/g, " ")}%,consumer_name.ilike.%${q.replace(/[,%()]/g, " ")}%,address.ilike.%${q.replace(/[,%()]/g, " " )}%`);
      }
      const { data, error } = await query;
      if (error) return Response.json({ error: "Consumer search failed: " + error.message }, { status: 400, headers: cors });
      return Response.json({ data: data || [] }, { headers: cors });
    }

    // GPS capture action: authenticated delivery devices submit the best fresh high-accuracy fix
    // and a separately confirmed entrance pin; all registry access remains server-side.
    if (action === "gps_capture") {
      if (!["admin", "staff", "delivery"].includes(user.role)) {
        return Response.json({ error: "GPS capture not permitted" }, { status: 403, headers: cors });
      }
      const consumerNo = String(body.consumer_no || "").trim();
      const lat = Number(body.pin_lat ?? body.lat);
      const lng = Number(body.pin_lng ?? body.lng);
      const rawLat = Number(body.raw_lat ?? body.lat);
      const rawLng = Number(body.raw_lng ?? body.lng);
      const acc = Number(body.acc ?? 0);
      const captureMode = String(body.capture_mode || "initial_mapping").slice(0, 40);
      const bookingKey = String(body.booking_key || "").trim();
      const gpsMaxAgeMs = user.role === "delivery" ? 48 * 60 * 60 * 1000 : 5 * 60 * 1000;
      if (!consumerNo || consumerNo.length > 40 || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
          !Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(rawLat) || rawLat < -90 || rawLat > 90 ||
          !Number.isFinite(rawLng) || rawLng < -180 || rawLng > 180 || !Number.isFinite(acc) || acc <= 0 || acc > 30) {
        return Response.json({ error: "Invalid GPS capture values: valid coordinates and reported accuracy within 30 metres are required" }, { status: 400, headers: cors });
      }
      const pinOffsetMeters=Math.hypot((lat-rawLat)*111320,(lng-rawLng)*111320*Math.cos(rawLat*Math.PI/180));
      if(pinOffsetMeters>500) return Response.json({error:"Entrance pin is too far from the original GPS fix; please check the correct house"},{status:400,headers:cors});
      const readings = Array.isArray(body.readings) ? body.readings.slice(-20) : [];
      const nowMs=Date.now();
      const cleanReadings = readings.map((r:any)=>({lat:Number(r?.lat),lng:Number(r?.lng),acc:Number(r?.acc),ts:Number(r?.ts)}))
        .filter((r:any)=>Number.isFinite(r.lat)&&r.lat>=-90&&r.lat<=90&&Number.isFinite(r.lng)&&r.lng>=-180&&r.lng<=180&&Number.isFinite(r.acc)&&r.acc>0&&r.acc<=30&&Number.isFinite(r.ts)&&r.ts<=nowMs+60*1000&&r.ts>=nowMs-gpsMaxAgeMs);
      if(cleanReadings.length<1) return Response.json({error:"At least one valid GPS reading is required within the allowed capture window"},{status:400,headers:cors});
      const capturedAtMs=Math.max(...cleanReadings.map((r:any)=>r.ts));
      const capturedAt=new Date(capturedAtMs).toISOString();
      if(user.role==="delivery"&&captureMode==="delivery_after_mark_delivered"&&(!bookingKey||bookingKey.length>120))
        return Response.json({error:"A valid booking key is required for delivery GPS capture"},{status:400,headers:cors});
      const readMeanLat=cleanReadings.reduce((a:number,r:any)=>a+r.lat,0)/cleanReadings.length;
      const readMeanLng=cleanReadings.reduce((a:number,r:any)=>a+r.lng,0)/cleanReadings.length;
      const readSpread=Math.max(...cleanReadings.map((r:any)=>Math.hypot((r.lat-readMeanLat)*111320,(r.lng-readMeanLng)*111320*Math.cos(readMeanLat*Math.PI/180))));
      if(readSpread>30) return Response.json({error:"GPS readings are unstable; capture again while stationary"},{status:400,headers:cors});
      // Delivery users may capture GPS only for consumers in their own current office allocation.
      // The signed-in identity is taken from the validated session, never from request data.
      if (user.role === "delivery") {
        if (!["delivery_initial_mapping", "delivery_after_mark_delivered", "delivery_manual_lookup"].includes(captureMode)) {
          return Response.json({ error: "Unsupported delivery GPS capture mode" }, { status: 400, headers: cors });
        }
        if (captureMode !== "delivery_manual_lookup") {
          const { data: assignedBookings, error: assignmentError } = await db.from("lpg_pending")
            .select("id,order_no").eq("consumer_no", consumerNo).eq("delivery_man", user.name).limit(100);
          if (assignmentError) return Response.json({ error: "Could not verify this delivery assignment" }, { status: 503, headers: cors });
          if (!assignedBookings?.length) return Response.json({ error: "This consumer is not currently assigned to your delivery account" }, { status: 403, headers: cors });
          if (captureMode === "delivery_after_mark_delivered" && !assignedBookings.some((row:any) =>
            String(row.order_no || "") === bookingKey || String(row.id || "") === bookingKey
          )) return Response.json({ error: "This booking is not currently assigned to your delivery account" }, { status: 403, headers: cors });
        }
      }
      // A retry after a lost network response must not create a second visit or
      // increment the GPS evidence count again for the same completed booking.
      if (user.role === "delivery" && captureMode === "delivery_after_mark_delivered") {
        const { data: priorVisit, error: priorVisitError } = await db.from("lpg_gps_history")
          .select("id,captured_at,status,captured_by,capture_mode,acc").eq("booking_key", bookingKey).eq("consumer_no", consumerNo).maybeSingle();
        if (priorVisitError) return Response.json({ error: "Could not check prior delivery GPS sync" }, { status: 503, headers: cors });
        if (priorVisit) {
          if (priorVisit.captured_by !== user.name || priorVisit.capture_mode !== "delivery_after_mark_delivered" ||
              !Number.isFinite(Number(priorVisit.acc)) || Number(priorVisit.acc) <= 0 || Number(priorVisit.acc) > 30) {
            return Response.json({ error: "A conflicting or invalid GPS record exists for this booking. Contact the office." }, { status: 409, headers: cors });
          }
          return Response.json({ duplicate: true, status: priorVisit.status, captured_at: priorVisit.captured_at,
            message: "This booking's GPS visit was already saved." }, { headers: cors });
        }
      }
      const { data: existing, error: readError } = await db.from("lpg_gps")
        .select("lat,lng,acc,count,status,raw_lat,raw_lng,pin_lat,pin_lng").eq("consumer_no", consumerNo).maybeSingle();
      if (readError) return Response.json({ error: readError.message }, { status: 400, headers: cors });
      // Keep the office-approved master pin immutable, but still record the fresh
      // delivery visit fix so deviation checks compare this visit, not the old pin.
      if (existing?.status === "approved") {
        const approvedCaptureMode = captureMode;
        const approvedCaptureSource = approvedCaptureMode === "delivery_after_mark_delivered" ? "DELIVERY_BOY_DELIVERY" :
          approvedCaptureMode === "delivery_manual_lookup" ? "DELIVERY_BOY_MANUAL_LOOKUP" : "DELIVERY_BOY_INITIAL_MAPPING";
        const approvedCapturedAt = capturedAt;
        const approvedHistoryRow:any = {
          booking_key:approvedCaptureMode==="delivery_after_mark_delivered"?bookingKey:null,
          consumer_no:consumerNo,raw_lat:rawLat,raw_lng:rawLng,pin_lat:lat,pin_lng:lng,acc,
          reading_count:cleanReadings.length,readings:cleanReadings,
          pin_offset_m:Number(Math.hypot((lat-rawLat)*111320,(lng-rawLng)*111320*Math.cos(rawLat*Math.PI/180)).toFixed(2)),
          source:approvedCaptureSource,capture_mode:approvedCaptureMode,captured_by:user.name,
          status:"delivery_observation",captured_at:approvedCapturedAt
        };
        const approvedHistoryWrite=approvedHistoryRow.booking_key
          ?await db.from("lpg_gps_history").upsert(approvedHistoryRow,{onConflict:"booking_key,consumer_no"})
          :await db.from("lpg_gps_history").insert(approvedHistoryRow);
        if(approvedHistoryWrite.error) return Response.json({error:"Approved customer pin was preserved, but this visit's GPS observation could not be saved: "+approvedHistoryWrite.error.message},{status:503,headers:cors});
        return Response.json({ignored:true,status:"approved",observation_saved:true,
          observation:{raw_lat:rawLat,raw_lng:rawLng,pin_lat:lat,pin_lng:lng,acc,captured_at:approvedCapturedAt},
          message:"Approved customer pin preserved. This delivery visit was recorded for location verification."},{headers:cors});
      }
      const priorCount = existing ? Math.max(1, Number(existing.count) || 1) : 0;
      const n = priorCount + cleanReadings.length;
      // Keep the best reported fix instead of averaging offsets between adjacent houses.
      // Repeated visits increase evidence count, but delivery pins remain pending for office review.
      const keepNew = !existing || !Number.isFinite(Number(existing.acc)) || acc < Number(existing.acc);
      const newLat = keepNew ? lat : Number(existing.lat);
      const newLng = keepNew ? lng : Number(existing.lng);
      const bestAcc = existing && Number.isFinite(Number(existing.acc)) ? Math.min(acc, Number(existing.acc)) : acc;
      const {data:consumer,error:consumerErr}=await db.from("lpg_masters").select("consumer_no,consumer_name,area").eq("consumer_no",consumerNo).maybeSingle();
      if(consumerErr) return Response.json({error:"Could not verify consumer"},{status:503,headers:cors});
      if(!consumer) return Response.json({error:"Consumer not found in master record"},{status:404,headers:cors});
      const rawSavedLat = keepNew ? rawLat : (Number(existing?.raw_lat) || Number(existing?.lat) || rawLat);
      const rawSavedLng = keepNew ? rawLng : (Number(existing?.raw_lng) || Number(existing?.lng) || rawLng);
      const pinSavedLat = keepNew ? lat : (Number(existing?.pin_lat) || Number(existing?.lat) || lat);
      const pinSavedLng = keepNew ? lng : (Number(existing?.pin_lng) || Number(existing?.lng) || lng);
      const captureSource = captureMode === "delivery_after_mark_delivered" ? "DELIVERY_BOY_DELIVERY" : captureMode === "delivery_manual_lookup" ? "DELIVERY_BOY_MANUAL_LOOKUP" : "DELIVERY_BOY_INITIAL_MAPPING";
      const historyRow:any={booking_key:user.role==="delivery"&&captureMode==="delivery_after_mark_delivered"?bookingKey:null,
        consumer_no:consumerNo,raw_lat:rawLat,raw_lng:rawLng,pin_lat:lat,pin_lng:lng,acc,reading_count:cleanReadings.length,readings:cleanReadings,
        pin_offset_m:Number(Math.hypot((lat-rawLat)*111320,(lng-rawLng)*111320*Math.cos(rawLat*Math.PI/180)).toFixed(2)),
        source:captureSource,capture_mode:captureMode,captured_by:user.name,status:"capturing",captured_at:capturedAt};
      let historySaved=false;
      if(historyRow.booking_key){
        const historyWrite=await db.from("lpg_gps_history").upsert(historyRow,{onConflict:"booking_key,consumer_no"});
        if(historyWrite.error) return Response.json({error:"Delivery GPS could not be saved to history: "+historyWrite.error.message},{status:503,headers:cors});
        historySaved=true;
      }
      const row = {
        consumer_no: consumerNo, lat: newLat, lng: newLng, acc: bestAcc,
        raw_lat: rawSavedLat, raw_lng: rawSavedLng, pin_lat: pinSavedLat, pin_lng: pinSavedLng,
        capture_mode: captureMode, count: n, status: "capturing", dm_name: user.name,
        consumer_name: consumer.consumer_name || null, area: consumer.area || null,
        source: captureSource, captured_at: capturedAt,
      };
      const { data, error } = await db.from("lpg_gps").upsert(row, { onConflict: "consumer_no" }).select().single();
      if (error) return Response.json({ error: error.message, history_saved:historySaved }, { status: 503, headers: cors });
      if(!historySaved){
        const historyWrite=await db.from("lpg_gps_history").insert(historyRow);
        if(historyWrite.error) return Response.json({error:"GPS coordinates were stored but capture history needs retry: "+historyWrite.error.message,gps_saved:true},{status:503,headers:cors});
        historySaved=true;
      }
      return Response.json({ data, history_saved:historySaved }, { headers: cors });
    }

    // Office review queue for delivery-location deviations and temporary-pin outliers.
    if (action === "delivery_location_exceptions") {
      if (!["admin","staff"].includes(user.role)) return Response.json({error:"Office permission required"},{status:403,headers:cors});
      const op=String(body.op||"list");
      if(op==="list"){
        const status=String(body.status||"open");
        let query=db.from("lpg_delivery_location_exceptions")
          .select("id,booking_key,consumer_no,delivery_man,observed_lat,observed_lng,reference_lat,reference_lng,distance_m,accuracy_m,severity,reason,status,created_at,reviewed_by,reviewed_at")
          .order("created_at",{ascending:false}).limit(1000);
        if(status!=="all") query=query.eq("status",status);
        const {data,error}=await query;
        if(error)return Response.json({error:"Could not load location exceptions: "+error.message},{status:503,headers:cors});
        return Response.json({data:data||[]},{headers:cors});
      }
      if(["resolve","dismiss"].includes(op)){
        const id=String(body.id||"");
        const reason=String(body.reason||"").trim();
        if(!id||reason.length<3||reason.length>300)return Response.json({error:"Select an exception and enter a review note (3–300 characters)"},{status:400,headers:cors});
        const {data,error}=await db.from("lpg_delivery_location_exceptions")
          .update({status:op==="resolve"?"resolved":"dismissed",reviewed_by:user.name,reviewed_at:new Date().toISOString(),reason})
          .eq("id",id).eq("status","open").select("id,status,reviewed_by,reviewed_at,reason").maybeSingle();
        if(error||!data)return Response.json({error:"Exception was not found or has already been reviewed"},{status:409,headers:cors});
        return Response.json({success:true,exception:data},{headers:cors});
      }
      return Response.json({error:"Unsupported exception operation"},{status:400,headers:cors});
    }

    // Complete GPS management API. All GPS table access is mediated here;
    // delivery users can submit only their own signed identity, never read the GPS registry.
    if (action === "gps_manage") {
      const op = String(body.op || "");
      const isOffice = user.role === "admin" || user.role === "staff";
      const consumerNo = String(body.consumer_no || "").trim();
      const validCoords = (lat: unknown, lng: unknown) =>
        typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
        typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180;
      if (op === "capture") {
        return Response.json({ error:"Use gps_capture for delivery readings" }, { status:400, headers:cors });
      }
      if (op === "create_links") {
        if (!isOffice) return Response.json({error:"Office permission required"},{status:403,headers:cors});
        if (!Array.isArray(body.consumers) || body.consumers.length < 1 || body.consumers.length > 500)
          return Response.json({error:"Select 1–500 consumers per batch"},{status:400,headers:cors});
        const baseUrl=String(body.base_url||"").trim();
        if(!/^https:\/\//i.test(baseUrl)||baseUrl.length>500) return Response.json({error:"A published HTTPS capture page URL is required"},{status:400,headers:cors});
        const requested:string[]=[...new Set<string>(body.consumers.map((item:any)=>String(item?.consumer_no||"").trim()).filter((c:string)=>c&&c.length<=40))];
        if(!requested.length) return Response.json({error:"No valid consumer numbers selected"},{status:400,headers:cors});
        const {data:masterRows,error:masterErr}=await db.from("lpg_masters").select("consumer_no,consumer_name,mobile,area,status").in("consumer_no",requested);
        if(masterErr) return Response.json({error:"Could not verify selected consumers: "+masterErr.message},{status:503,headers:cors});
        const masters=new Map<string,any>((masterRows||[]).map((m:any)=>[String(m.consumer_no),m]));
        const {data:existingGps,error:gpsErr}=await db.from("lpg_gps").select("consumer_no,status").in("consumer_no",requested);
        if(gpsErr) return Response.json({error:"Could not check existing GPS coverage: "+gpsErr.message},{status:503,headers:cors});
        const approved=new Set<string>((existingGps||[]).filter((g:any)=>g.status==="approved").map((g:any)=>String(g.consumer_no)));
        const out:any[]=[]; const expiresAt=new Date(Date.now()+7*24*60*60*1000).toISOString();
        for(const cno of requested){
          const master=masters.get(cno); if(!master||approved.has(cno)||String(master.status||"").toLowerCase()==="inactive") continue;
          const mobile=String(master.mobile||"").replace(/\D/g,"");
          const random=new Uint8Array(32); crypto.getRandomValues(random); const raw=b64(random); const tokenHash=await sha256Hex(raw);
          const {error}=await db.from("lpg_gps_links").insert({consumer_no:cno,token_hash:tokenHash,expires_at:expiresAt,active:true,created_by:user.name});
          if(error) return Response.json({error:"Could not create a location link for consumer "+cno+": "+error.message},{status:400,headers:cors});
          out.push({consumer_no:cno,consumer_name:String(master.consumer_name||"").slice(0,160),mobile,area:master.area||"",token:raw});
        }
        return Response.json({links:out,expires_at:expiresAt},{headers:cors});
      }
      if (!isOffice) return Response.json({ error:"Office permission required for GPS management" }, { status:403, headers:cors });
      if (op === "list") {
        const rows: any[] = [];
        for (let from=0; from<20000; from+=1000) {
          const { data, error } = await db.from("lpg_gps")
            .select("consumer_no,consumer_name,area,lat,lng,acc,count,status,dm_name,source,captured_at,raw_lat,raw_lng,pin_lat,pin_lng,capture_mode")
            .order("captured_at", { ascending:false }).range(from, from+999);
          if (error) return Response.json({ error:error.message }, { status:400, headers:cors });
          rows.push(...(data||[]));
          if (!data || data.length<1000) break;
        }
        const {data:temporaryRows,error:temporaryError}=await db.from("lpg_gps_temporary")
          .select("consumer_no,lat,lng,best_accuracy_m,confirmation_count,status,last_delivery_man,last_confirmed_at")
          .eq("status","temporary_approved");
        if(temporaryError) return Response.json({error:"Could not load temporary verified GPS pins: "+temporaryError.message},{status:503,headers:cors});
        (temporaryRows||[]).forEach((g:any)=>rows.push({
          consumer_no:g.consumer_no,lat:g.lat,lng:g.lng,pin_lat:g.lat,pin_lng:g.lng,
          acc:g.best_accuracy_m,count:g.confirmation_count,status:"temporary_approved",
          dm_name:g.last_delivery_man,source:"temporary_auto_approved",
          captured_at:g.last_confirmed_at,capture_mode:"delivery_repeat_verification"
        }));
        return Response.json({ data:rows }, { headers:cors });
      }
      if (op === "count") {
        const { count, error } = await db.from("lpg_gps").select("consumer_no", { count:"exact", head:true });
        if (error) return Response.json({ error:error.message }, { status:400, headers:cors });
        return Response.json({ count:count||0 }, { headers:cors });
      }
      if (op === "history") {
        if (!consumerNo || consumerNo.length>40) return Response.json({error:"A valid consumer number is required"},{status:400,headers:cors});
        const {data,error}=await db.from("lpg_gps_history").select("raw_lat,raw_lng,pin_lat,pin_lng,acc,reading_count,pin_offset_m,source,capture_mode,captured_by,status,captured_at")
          .eq("consumer_no",consumerNo).order("captured_at",{ascending:false}).limit(100);
        if(error) return Response.json({error:error.message},{status:400,headers:cors});
        return Response.json({data:data||[]},{headers:cors});
      }
      if (["save","approve"].includes(op)) {
        const lat=body.lat, lng=body.lng, acc=Number(body.acc ?? 5);
        if (!consumerNo || consumerNo.length>40 || !validCoords(lat,lng) || !Number.isFinite(acc) || acc<0 || acc>10000)
          return Response.json({ error:"Invalid consumer number or GPS coordinates" }, { status:400, headers:cors });
        const source=op === "approve" ? "approved" : (["staff_pin","manual","approved"].includes(String(body.source)) ? String(body.source) : "staff_pin");
        const now=new Date().toISOString();
        const rawLat=Number(body.raw_lat ?? lat), rawLng=Number(body.raw_lng ?? lng);
        const validRawLat=Number.isFinite(rawLat)&&rawLat>=-90&&rawLat<=90?rawLat:null;
        const validRawLng=Number.isFinite(rawLng)&&rawLng>=-180&&rawLng<=180?rawLng:null;
        const captureMode=String(body.capture_mode || (op === "approve" ? "office_approval" : "office_pin")).slice(0,40);
        const { data, error } = await db.from("lpg_gps").upsert({
          consumer_no:consumerNo, lat, lng, acc, pin_lat:lat, pin_lng:lng,
          raw_lat:validRawLat, raw_lng:validRawLng, capture_mode:captureMode,
          status:"approved", source, captured_at:now, dm_name:user.name, count:Math.max(1,Number(body.count)||1),
        }, { onConflict:"consumer_no" }).select("consumer_no,lat,lng,acc,count,status,source,captured_at,dm_name,raw_lat,raw_lng,pin_lat,pin_lng,capture_mode").single();
        if (error) return Response.json({ error:error.message }, { status:400, headers:cors });
        const {error:historyErr}=await db.from("lpg_gps_history").insert({consumer_no:consumerNo,raw_lat:validRawLat,raw_lng:validRawLng,pin_lat:lat,pin_lng:lng,acc,reading_count:Math.max(1,Number(body.count)||1),readings:[],pin_offset_m:validRawLat!==null&&validRawLng!==null?Number(Math.hypot((lat-validRawLat)*111320,(lng-validRawLng)*111320*Math.cos(validRawLat*Math.PI/180)).toFixed(2)):null,source:"OFFICE_REVIEW",capture_mode:captureMode,captured_by:user.name,status:"approved",captured_at:now});
        return Response.json({ data, history_saved:!historyErr, history_error:historyErr?.message||null }, { headers:cors });
      }
      if (op === "reject") {
        if (!isOffice) return Response.json({ error:"Office permission required to reject GPS records" }, { status:403, headers:cors });
        if (!consumerNo || consumerNo.length>40) return Response.json({ error:"A valid consumer_no is required" }, { status:400, headers:cors });
        const { data: current, error: currentError } = await db.from("lpg_gps")
          .select("consumer_no,lat,lng,pin_lat,pin_lng,raw_lat,raw_lng,acc,count,source,capture_mode,captured_at,status")
          .eq("consumer_no",consumerNo).maybeSingle();
        if (currentError) return Response.json({ error:currentError.message }, { status:503, headers:cors });
        if (!current) return Response.json({ error:"GPS record not found" }, { status:404, headers:cors });
        if (current.status === "approved" && user.role !== "admin")
          return Response.json({ error:"Only an administrator can reject an already approved location" }, { status:403, headers:cors });
        const now = new Date().toISOString();
        const { data, error } = await db.from("lpg_gps").update({status:"rejected"})
          .eq("consumer_no",consumerNo).select("consumer_no,status").maybeSingle();
        if (error) return Response.json({ error:error.message }, { status:400, headers:cors });
        const history = {
          consumer_no:consumerNo, raw_lat:current.raw_lat, raw_lng:current.raw_lng,
          pin_lat:current.pin_lat ?? current.lat, pin_lng:current.pin_lng ?? current.lng,
          acc:Number(current.acc)||0, reading_count:Math.max(1,Number(current.count)||1),
          readings:[], source:"OFFICE_REVIEW", capture_mode:current.capture_mode||"office_reject",
          captured_by:user.name, status:"rejected", captured_at:now
        };
        const {error:historyError}=await db.from("lpg_gps_history").insert(history);
        return Response.json({data,rejected:true,history_saved:!historyError},{headers:cors});
      }
      if (op === "delete") {
        if (user.role !== "admin") return Response.json({ error:"Admin permission required to delete GPS records" }, { status:403, headers:cors });
        if (!consumerNo || consumerNo.length>40) return Response.json({ error:"A valid consumer_no is required" }, { status:400, headers:cors });
        const { data, error } = await db.from("lpg_gps").delete().eq("consumer_no",consumerNo).select("consumer_no").maybeSingle();
        if (error) return Response.json({ error:error.message }, { status:400, headers:cors });
        if (!data) return Response.json({ error:"GPS record not found" }, { status:404, headers:cors });
        return Response.json({ data, deleted:true }, { headers:cors });
      }
      if (op === "import_batch") {
        if (user.role !== "admin") return Response.json({ error:"Admin permission required for file import" }, { status:403, headers:cors });
        if (!Array.isArray(body.records) || body.records.length===0 || body.records.length>2000) return Response.json({ error:"Import must contain 1–2000 GPS records" }, { status:400, headers:cors });
        const saved:any[]=[]; const skipped:any[]=[];
        for (const r of body.records) {
          const cno=String(r?.consumer_no||"").trim(); const lat=r?.lat; const lng=r?.lng; const acc=Number(r?.acc??99);
          if (!cno || cno.length>40 || !validCoords(lat,lng) || !Number.isFinite(acc) || acc<0 || acc>10000) { skipped.push(cno||"(blank)"); continue; }
          const { data:old, error:readErr }=await db.from("lpg_gps").select("status").eq("consumer_no",cno).maybeSingle();
          if (readErr) return Response.json({error:readErr.message},{status:400,headers:cors});
          if (old?.status==="approved") { skipped.push(cno); continue; }
          const { data, error }=await db.from("lpg_gps").upsert({ consumer_no:cno,lat,lng,acc,count:Math.max(1,Number(r.count)||1),status:"capturing",source:"delivery_app",dm_name:String(r.dm_name||"Imported file").slice(0,100),consumer_name:String(r.consumer_name||"").slice(0,160)||null,area:String(r.area||"").slice(0,160)||null,captured_at:typeof r.captured_at==="string"&&!Number.isNaN(Date.parse(r.captured_at))?r.captured_at:new Date().toISOString() },{onConflict:"consumer_no"}).select("consumer_no").single();
          if(error) return Response.json({error:error.message},{status:400,headers:cors});
          saved.push(data.consumer_no);
        }
        return Response.json({ imported:saved.length, skipped, consumer_nos:saved },{headers:cors});
      }
      if (op === "clear_all") {
        if (user.role !== "admin") return Response.json({ error:"Admin permission required" }, { status:403, headers:cors });
        const { data, error } = await db.from("lpg_gps").delete().neq("consumer_no","__never__").select("consumer_no");
        if (error) return Response.json({ error:error.message }, { status:400, headers:cors });
        return Response.json({ deletedCount:data?.length||0 }, { headers:cors });
      }
      return Response.json({ error:"Unsupported GPS operation" }, { status:400, headers:cors });
    }

    // Delivered CSV preview/import. Preview validates all rows but writes nothing.
    if (
      action === "preview_delivered_csv" ||
      action === "import_delivered_csv"
    ) {
      if (user.role !== "admin") {
        return Response.json(
          { error: "Admin permission required" },
          { status: 403, headers: cors },
        );
      }

      if (body.dateFormat !== "DD/MM/YYYY") {
        return Response.json(
          { error: "Date format must be DD/MM/YYYY" },
          { status: 400, headers: cors },
        );
      }

      if (body.dateColumn !== "Actual Delivery Date") {
        return Response.json(
          { error: "Date column must be Actual Delivery Date" },
          { status: 400, headers: cors },
        );
      }

      if (typeof body.csvText !== "string" || !body.csvText.trim()) {
        return Response.json(
          { error: "Provide CSV contents in csvText" },
          { status: 400, headers: cors },
        );
      }

      try {
        const rows = mapDeliveredCsv(
          body.csvText,
          body.dateFormat,
          body.dateColumn,
        );

        if (rows.length > 10000) {
          return Response.json(
            { error: "Import exceeds the 10000-row limit" },
            { status: 400, headers: cors },
          );
        }

        if (action === "preview_delivered_csv") {
          return Response.json({
            preview: true,
            rowsValidated: rows.length,
            dateFormat: body.dateFormat,
            dateColumn: body.dateColumn,
            sample: rows.slice(0, 10).map((r) => ({
              order_no: r.order_no,
              consumer_no: r.consumer_no,
              delivery_date: r.delivery_date,
              qty: r.qty,
            })),
            message: "Preview only. No records have been imported.",
          }, { headers: cors });
        }

        const { data, error } = await db.rpc(
          "import_lpg_delivered",
          { p_rows: rows },
        );

        if (error) {
          return Response.json(
            { error: error.message },
            { status: 400, headers: cors },
          );
        }

        return Response.json(
          { data, dateFormat: body.dateFormat },
          { headers: cors },
        );
      } catch (err) {
        return Response.json(
          {
            error: err instanceof Error
              ? err.message
              : "CSV import failed",
          },
          { status: 400, headers: cors },
        );
      }
    }
        // Admin-only JSON import operations.
    // Rows must already use database column names.
    if (action === "import_pending" || action === "import_delivered") {
      if (user.role !== "admin") {
        return Response.json(
          { error: "Admin permission required" },
          { status: 403, headers: cors },
        );
      }

      if (!Array.isArray(body.rows) || body.rows.length === 0) {
        return Response.json(
          { error: "A non-empty rows array is required" },
          { status: 400, headers: cors },
        );
      }

      if (body.rows.length > 10000) {
        return Response.json(
          { error: "Import exceeds the 10000-row limit" },
          { status: 400, headers: cors },
        );
      }

      if (!body.rows.every((row: unknown) =>
        row !== null && typeof row === "object" && !Array.isArray(row)
      )) {
        return Response.json(
          { error: "Every row must be an object" },
          { status: 400, headers: cors },
        );
      }

      const functionName = action === "import_pending"
        ? "replace_lpg_pending"
        : "import_lpg_delivered";

      const { data, error } = await db.rpc(functionName, {
        p_rows: body.rows,
      });

      if (error) {
        return Response.json(
          { error: error.message },
          { status: 400, headers: cors },
        );
      }

      return Response.json({ data }, { headers: cors });
    }

    // Admin-only delivery archive operation.
    // Preview is the default; archiving requires explicit confirmation.
    if (action === "archive_delivered") {
      if (user.role !== "admin") {
        return Response.json(
          { error: "Admin permission required" },
          { status: 403, headers: cors },
        );
      }

      const previewOnly = body.previewOnly !== false;

      if (typeof body.previewOnly !== "undefined" &&
          typeof body.previewOnly !== "boolean") {
        return Response.json(
          { error: "previewOnly must be true or false" },
          { status: 400, headers: cors },
        );
      }

      const { data, error } = await db.rpc(
        "archive_lpg_delivered",
        { p_preview_only: previewOnly },
      );

      if (error) {
        return Response.json(
          { error: error.message },
          { status: 400, headers: cors },
        );
      }

      return Response.json(
        { action, previewOnly, result: data },
        { headers: cors },
      );
    }




    // Customer complaint and follow-up manager. Admin/staff only.
    // This dedicated action deliberately avoids exposing the table through generic CRUD.
    if (action === "followups") {
      if (!(["admin", "staff"].includes(user.role))) {
        return Response.json({ error: "Admin or staff permission required" }, { status: 403, headers: cors });
      }
      const op = String(body.op || "");
      const categories = ["Delivery issue", "Refill / booking", "Safety", "eKYC", "Payment", "Other"];
      const priorities = ["low", "normal", "high"];
      const statuses = ["open", "in_progress", "resolved"];
      const validDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

      if (op === "list") {
        const consumerNo = String(body.consumer_no || "").trim();
        if (!consumerNo || consumerNo.length > 40) {
          return Response.json({ error: "A valid consumer_no is required" }, { status: 400, headers: cors });
        }
        const { data, error } = await db.from("lpg_followups")
          .select("id,consumer_no,category,priority,title,description,assigned_to,due_date,status,created_by,created_at,updated_at")
          .eq("consumer_no", consumerNo)
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) return Response.json({ error: error.message }, { status: 400, headers: cors });
        return Response.json({ data: data || [] }, { headers: cors });
      }

      if (op === "create") {
        const r = body.record;
        if (!r || typeof r !== "object" || Array.isArray(r)) return Response.json({ error: "A record object is required" }, { status: 400, headers: cors });
        const consumerNo = String(r.consumer_no || "").trim();
        const title = String(r.title || "").trim();
        const description = String(r.description || "").trim();
        const category = String(r.category || "Other");
        const priority = String(r.priority || "normal");
        const assignedTo = String(r.assigned_to || "").trim();
        if (!consumerNo || consumerNo.length > 40 || !title || title.length > 120 || description.length > 2000 || assignedTo.length > 100 || !categories.includes(category) || !priorities.includes(priority) || !validDate(r.due_date)) {
          return Response.json({ error: "Invalid follow-up fields. Check consumer, category, priority, subject, assigned staff and due date." }, { status: 400, headers: cors });
        }
        const { data, error } = await db.from("lpg_followups").insert({
          consumer_no: consumerNo, category, priority, title, description: description || null,
          assigned_to: assignedTo || null, due_date: r.due_date, status: "open",
          created_by: user.name, updated_at: new Date().toISOString(),
        }).select("id,consumer_no,category,priority,title,description,assigned_to,due_date,status,created_by,created_at,updated_at").single();
        if (error) return Response.json({ error: error.message }, { status: 400, headers: cors });
        return Response.json({ data }, { headers: cors });
      }

      if (op === "update") {
        const id = String(body.id || "").trim();
        const status = String(body.status || "");
        if (!/^[0-9a-f-]{36}$/i.test(id) || !statuses.includes(status)) return Response.json({ error: "A valid follow-up id and status are required" }, { status: 400, headers: cors });
        const { data, error } = await db.from("lpg_followups")
          .update({ status, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select("id,consumer_no,status,updated_at")
          .maybeSingle();
        if (error) return Response.json({ error: error.message }, { status: 400, headers: cors });
        if (!data) return Response.json({ error: "Follow-up not found" }, { status: 404, headers: cors });
        return Response.json({ data }, { headers: cors });
      }

      return Response.json({ error: "Unsupported follow-ups operation" }, { status: 400, headers: cors });
    }

    if (action !== "db") {
      return Response.json(
        { error: "Unknown action" },
        { status: 400, headers: cors },
      );
    }

    const table = String(body.table || "");
    const op = String(body.op || "");

    if (!tables.has(table)) {
      return Response.json(
        { error: "Table not allowed" },
        { status: 403, headers: cors },
      );
    }

    // Sensitive identity/security tables are never exposed to staff or delivery users.
    if (table === "lpg_gps") {
      return Response.json({ error:"Use the dedicated authenticated gps_manage or gps_capture action" }, { status:403, headers:cors });
    }

    const adminOnly = ["lpg_users", "lpg_security", "lpg_login_log"].includes(table);
    if (adminOnly && user.role !== "admin") {
      return Response.json({ error: "Admin permission required" }, { status: 403, headers: cors });
    }

    // Delivery accounts can read only their own pending work and can submit GPS
    // updates. The delivery name filter is enforced server-side, not trusted from HTML.
    if (user.role === "delivery" && !(table === "lpg_pending" || table === "lpg_gps")) {
      return Response.json({ error: "Delivery role restricted" }, { status: 403, headers: cors });
    }
    if (user.role === "delivery" && table === "lpg_gps" && op === "select") {
      return Response.json({ error: "Delivery accounts cannot read GPS records" }, { status: 403, headers: cors });
    }
    if (user.role === "staff" && !["lpg_masters", "lpg_delivered", "lpg_pending", "lpg_remarks", "lpg_gps"].includes(table)) {
      return Response.json({ error: "Staff access restricted" }, { status: 403, headers: cors });
    }

    // Admin-only date-wise delivery summary; read-only.
    if (op === "date_wise_delivery_summary") {
      if (user.role !== "admin") {
        return Response.json(
          { error: "Admin permission required" },
          { status: 403, headers: cors },
        );
      }

      if (table !== "lpg_delivered") {
        return Response.json(
          { error: "date_wise_delivery_summary is only available for lpg_delivered" },
          { status: 400, headers: cors },
        );
      }

      const startDate = body.start_date ?? null;
      const endDate = body.end_date ?? null;

      const validDate = (value: unknown) =>
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value;

      if (
        (startDate !== null && !validDate(startDate)) ||
        (endDate !== null && !validDate(endDate))
      ) {
        return Response.json(
          { error: "Dates must use YYYY-MM-DD format" },
          { status: 400, headers: cors },
        );
      }

      if (startDate && endDate && startDate > endDate) {
        return Response.json(
          { error: "start_date must be on or before end_date" },
          { status: 400, headers: cors },
        );
      }

      const { data, error } = await db.rpc(
        "date_wise_delivery_summary",
        {
          p_start_date: startDate,
          p_end_date: endDate,
        },
      );

      if (error) {
        return Response.json(
          { error: error.message },
          { status: 400, headers: cors },
        );
      }

      return Response.json(
        { table, start_date: startDate, end_date: endDate, data },
        { headers: cors },
      );
    }



    // Admin-only delivery-man summary; read-only.
    if (op === "delivery_summary") {
      if (user.role !== "admin") {
        return Response.json(
          { error: "Admin permission required" },
          { status: 403, headers: cors },
        );
      }

      if (table !== "lpg_delivered") {
        return Response.json(
          { error: "delivery_summary is only available for lpg_delivered" },
          { status: 400, headers: cors },
        );
      }

      const { data, error } = await db.rpc("delivery_summary");

      if (error) {
        return Response.json(
          { error: error.message },
          { status: 400, headers: cors },
        );
      }

      return Response.json(
        { table, data },
        { headers: cors },
      );
    }



    // Admin-only exact row count; does not download table records.
    if (op === "count") {
      if (user.role !== "admin") {
        return Response.json(
          { error: "Admin permission required" },
          { status: 403, headers: cors },
        );
      }

      const countFilters = Array.isArray(body.filters)
        ? body.filters
        : [];

      let countQuery:any = db
        .from(table)
        // Tables use different primary-key names (lpg_masters has consumer_no,
        // lpg_remarks has consumer_no); count * avoids assuming an id column.
        .select("*", { count: "exact", head: true });

      for (const f of countFilters) {
        if (!f || typeof f.column !== "string") continue;

        if (f.op === "eq") {
          countQuery = countQuery.eq(f.column, f.value);
        } else if (f.op === "in" && Array.isArray(f.value)) {
          countQuery = countQuery.in(f.column, f.value);
        } else if (f.op === "is") {
          countQuery = countQuery.is(f.column, f.value);
        }
      }

      const { count, error } = await countQuery;

      if (error) {
        return Response.json(
          { error: error.message },
          { status: 400, headers: cors },
        );
      }

      return Response.json(
        { table, count },
        { headers: cors },
      );
    }

    // Admin-only delivery date summary.
    if (op === "date_summary") {
      if (user.role !== "admin") {
        return Response.json(
          { error: "Admin permission required" },
          { status: 403, headers: cors },
        );
      }

      if (table !== "lpg_delivered") {
        return Response.json(
          { error: "date_summary is only available for lpg_delivered" },
          { status: 400, headers: cors },
        );
      }

      const [
        totalResult,
        missingResult,
        earliestResult,
        latestResult,
      ] = await Promise.all([
        db.from(table).select("id", { count: "exact", head: true }),
        db.from(table).select("id", { count: "exact", head: true })
          .is("delivery_date", null),
        db.from(table).select("delivery_date")
          .not("delivery_date", "is", null)
          .order("delivery_date", { ascending: true })
          .limit(1),
        db.from(table).select("delivery_date")
          .not("delivery_date", "is", null)
          .order("delivery_date", { ascending: false })
          .limit(1),
      ]);

      const error =
        totalResult.error ||
        missingResult.error ||
        earliestResult.error ||
        latestResult.error;

      if (error) {
        return Response.json(
          { error: error.message },
          { status: 400, headers: cors },
        );
      }

      return Response.json({
        table,
        total_records: totalResult.count,
        missing_delivery_dates: missingResult.count,
        earliest_delivery_date:
          earliestResult.data?.[0]?.delivery_date ?? null,
        latest_delivery_date:
          latestResult.data?.[0]?.delivery_date ?? null,
      }, { headers: cors });
    }




    const writable = user.role === "admin"
      ? ["lpg_masters", "lpg_delivered", "lpg_pending", "lpg_remarks", "lpg_gps", "lpg_users", "lpg_security"]
      : user.role === "staff" ? ["lpg_remarks", "lpg_gps"]
      : ["lpg_gps"];

    if (["insert", "upsert", "update", "delete"].includes(op)) {
      if (!writable.includes(table)) {
        return Response.json({ error: "Write not allowed for this role/table" }, { status: 403, headers: cors });
      }
      if (op === "delete" && user.role !== "admin") {
        return Response.json({ error: "Admin required for delete" }, { status: 403, headers: cors });
      }
      if (user.role === "delivery" && ["insert", "upsert", "update"].includes(op)) {
        const payloadRows = Array.isArray(body.rows) ? body.rows : (body.rows ? [body.rows] : []);
        if (table !== "lpg_gps" || payloadRows.some((row: any) => row.dm_name && row.dm_name !== user.name)) {
          return Response.json({ error: "Delivery GPS updates must belong to the signed-in delivery user" }, { status: 403, headers: cors });
        }
        for (const row of payloadRows) row.dm_name = user.name;
        if (body.values && typeof body.values === "object") body.values.dm_name = user.name;
      }
    } else if (op !== "select") {
      return Response.json(
        { error: "Operation not allowed" },
        { status: 400, headers: cors },
      );
    }

    let query: any;

    if (op === "select") {
      // Never expose PIN hashes through the generic database API.
      const columns = table === "lpg_users"
        ? "id,role,name,active,created_by,created_at"
        : (body.columns || "*");

      query = db.from(table).select(columns);

      const requestedLimit = body.limit === undefined ? 1000 : Number(body.limit);
      const requestedOffset = body.offset === undefined ? 0 : Number(body.offset);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 ||
          !Number.isInteger(requestedOffset) || requestedOffset < 0) {
        return Response.json({ error: "Invalid pagination values" }, { status: 400, headers: cors });
      }
      const safeLimit = Math.min(requestedLimit, 1000);
      query = query.range(requestedOffset, requestedOffset + safeLimit - 1);

      if (body.orderBy) {
        const orderings = Array.isArray(body.orderBy) ? body.orderBy : [{ column: body.orderBy, ascending: body.ascending !== false }];
        if (orderings.length > 5 || orderings.some((item: any) => !item || typeof item.column !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(item.column))) {
          return Response.json({ error: "Invalid ordering" }, { status: 400, headers: cors });
        }
        for (const item of orderings) query = query.order(item.column, { ascending: item.ascending !== false });
      }
    } else if (op === "insert") {
      query = db.from(table).insert(body.rows).select();
    } else if (op === "upsert") {
      query = db
        .from(table)
        .upsert(body.rows, { onConflict: body.onConflict })
        .select();
    } else if (op === "update") {
      query = db.from(table).update(body.values);
    } else {
      query = db.from(table).delete();
    }

    const filters = Array.isArray(body.filters) ? [...body.filters] : [];
    if (user.role === "delivery" && op === "select" && table === "lpg_pending") {
      filters.push({ column: "delivery_man", op: "eq", value: user.name });
    }

    const allowedFilterOps = new Set(["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "like", "ilike"]);
    for (const f of filters) {
      if (!f || typeof f.column !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.column) || !allowedFilterOps.has(f.op)) {
        return Response.json({ error: "Invalid filter" }, { status: 400, headers: cors });
      }
      if (f.op === "eq") query = query.eq(f.column, f.value);
      else if (f.op === "neq") query = query.neq(f.column, f.value);
      else if (f.op === "in" && Array.isArray(f.value) && f.value.length <= 1000) query = query.in(f.column, f.value);
      else if (f.op === "is") query = query.is(f.column, f.value);
      else if (f.op === "not" && f.value && typeof f.value === "object" && ["is", "eq"].includes(f.operator)) query = query.not(f.column, f.operator, f.value.value);
      else if (["gt", "gte", "lt", "lte", "like", "ilike"].includes(f.op)) query = query[f.op](f.column, f.value);
      else return Response.json({ error: "Invalid filter value" }, { status: 400, headers: cors });
    }

    if (["update", "delete"].includes(op) && filters.length === 0) {
      return Response.json(
        { error: "Update/delete requires filters" },
        { status: 400, headers: cors },
      );
    }

    const { data, error } = await query;

    if (error) {
      return Response.json(
        { error: error.message },
        { status: 400, headers: cors },
      );
    }

    let responseData = data;
    // Return only approved or office-pinned GPS for the delivery boy's own filtered bookings.
    if (user.role === "delivery" && table === "lpg_pending" && op === "select" && Array.isArray(data) && data.length) {
      const consumerNos = [...new Set(data.map((row: any) => String(row.consumer_no || "").trim()).filter(Boolean))];
      if (consumerNos.length) {
        const { data: gpsRows, error: gpsReadError } = await db.from("lpg_gps")
          .select("consumer_no,lat,lng,pin_lat,pin_lng,acc,status,source")
          .in("consumer_no", consumerNos);
        if (!gpsReadError) {
          const gpsByConsumer = new Map((gpsRows || []).map((g: any) => [String(g.consumer_no), g]));
          responseData = data.map((row: any) => {
            const gps = gpsByConsumer.get(String(row.consumer_no || ""));
            const approved = gps?.status === "approved" || gps?.source === "staff_pin";
            return {
              ...row,
              lat: approved ? Number(gps.pin_lat ?? gps.lat) : null,
              lng: approved ? Number(gps.pin_lng ?? gps.lng) : null,
              gps_status: gps?.status || null,
              gps_accuracy: gps?.acc ?? null
            };
          });
        }
      }
    }
    return Response.json({ data: responseData }, { headers: cors });
  } catch {
    return Response.json(
      { error: "Invalid request" },
      { status: 400, headers: cors },
    );
  }
});