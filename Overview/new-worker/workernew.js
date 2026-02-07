import * as shapefile from "shapefile";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://thedatatab.com",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

async function writeSignInLog(env, { name, email }) {
  if (!env.SIGNIN_LOGS) return;
  const timestamp = Date.now();
  const key = `signin:${timestamp}:${email}`;
  const entry = { name, email, timestamp };
  await env.SIGNIN_LOGS.put(key, JSON.stringify(entry));
}

/* =========================
   NEW: constants + helpers
========================= */

const LOCATIONS = ["Chanticlear", "McDuffs", "Willies", "Northwoods"];

// Fill these in (LAST 3 digits of SITENO)
const SITE_LAST3_TO_LOCATION = {
  "006": "McDuffs",
  "014": "Chanticlear",
  "012": "Willies",
  "009": "Northwoods",
};

function requireLocation(loc) {
  if (!LOCATIONS.includes(loc)) throw new Error("BAD_LOCATION");
  return loc;
}
function tInv(loc) { return `${loc}_Inventory`; }
function tOpen(loc) { return `${loc}_Open`; }
function tClosed(loc) { return `${loc}_Closed`; }

function mfKey(mfcid, partno, serno) {
  return `${String(mfcid).trim()} ${String(partno).trim()} ${String(serno).trim()}`.trim();
}
function last3FromSiteno(siteno) {
  const s = String(siteno || "").trim();
  const last3 = s.slice(-3);
  return /^\d{3}$/.test(last3) ? last3 : null;
}

async function requireUser(request) {
  // Your pages should pass email/name in body OR you can later read from session cookie.
  // For now: if body has email/name, great. Otherwise reject.
  // NOTE: for GET endpoints, pass ?email=... or move to cookie auth later.
  return { email: null, name: null };
}

async function parseDbfRows(arrayBuffer) {
  const source = await shapefile.openDbf(arrayBuffer);
  const rows = [];
  while (true) {
    const next = await source.read();
    if (next.done) break;
    rows.push(next.value);
  }
  return rows;
}

async function findRow(env, table, key) {
  const res = await env.DB.prepare(`SELECT * FROM ${table} WHERE MFCID_PARTNO_SERNO = ?`)
    .bind(key)
    .all();
  return res.results?.[0] || null;
}

async function moveRow(env, fromTable, toTable, row) {
  const cols = [
    "MFCID_PARTNO_SERNO","GNAME","DIST_ID","GTYPE","GCOST","SITENO","INV_NUM",
    "PLCOST","PLNOS","IDLGRS","IDLPRZ","DPURCH",
    "CASH_HAND","DATE_OPEN","DATE_CLOSED"
  ];
  const values = cols.map(c => row[c] ?? null);

  const insert = env.DB.prepare(`
    INSERT OR REPLACE INTO ${toTable} (${cols.join(",")})
    VALUES (${cols.map(()=>"?").join(",")})
  `).bind(...values);

  const del = env.DB.prepare(`DELETE FROM ${fromTable} WHERE MFCID_PARTNO_SERNO = ?`)
    .bind(row.MFCID_PARTNO_SERNO);

  // transactional batch
  await env.DB.batch([insert, del]);
}

async function insertInventory(env, loc, row) {
  const table = tInv(loc);
  await env.DB.prepare(`
    INSERT OR REPLACE INTO ${table} (
      MFCID_PARTNO_SERNO, GNAME, DIST_ID, GTYPE, GCOST, SITENO, INV_NUM,
      PLCOST, PLNOS, IDLGRS, IDLPRZ, DPURCH,
      CASH_HAND, DATE_OPEN, DATE_CLOSED
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `).bind(
    row.MFCID_PARTNO_SERNO,
    row.GNAME ?? null,
    row.DIST_ID ?? null,
    row.GTYPE ?? null,
    row.GCOST ?? null,
    row.SITENO ?? null,
    row.INV_NUM ?? null,
    row.PLCOST ?? null,
    row.PLNOS ?? null,
    row.IDLGRS ?? null,
    row.IDLPRZ ?? null,
    row.DPURCH ?? null
  ).run();
}

/* =========================
   Worker routes
========================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // keep your existing endpoints
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, worker: "overview", time: new Date().toISOString() });
    }

    if (request.method === "POST" && path === "/signin") {
      try {
        const body = await request.json();
        const email = (body.email || "").toLowerCase();
        const name = body.name || email;
        if (!email) return json({ success: false, error: "Missing email" }, 400);

        await writeSignInLog(env, { name, email });
        return json({ success: true });
      } catch (e) {
        return json({ success: false, error: String(e) }, 500);
      }
    }

    if (request.method === "GET" && path === "/logs") {
      try {
        if (!env.SIGNIN_LOGS) return json([]);
        const list = await env.SIGNIN_LOGS.list({ limit: 1000 });
        const logs = [];

        for (const k of list.keys) {
          const v = await env.SIGNIN_LOGS.get(k.name, "json");
          if (v) logs.push(v);
        }

        logs.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        return json(logs);
      } catch {
        return json({ success: false, error: "Failed to load logs" }, 500);
      }
    }

    /* =========================
       NEW API: live inventory list
    ========================= */
    if (request.method === "GET" && path === "/api/inventory/live") {
      try {
        const results = [];
        for (const loc of LOCATIONS) {
          const res = await env.DB.prepare(`
            SELECT MFCID_PARTNO_SERNO AS key, GNAME AS gname
            FROM ${tInv(loc)}
            ORDER BY rowid DESC
            LIMIT 1000
          `).all();
          for (const r of (res.results || [])) {
            results.push({ location: loc, key: r.key, gname: r.gname ?? null });
          }
        }
        return json({ ok: true, results });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    /* =========================
       NEW API: Upload DBF (multipart)
       POST /api/upload-dbf
    ========================= */
    if (request.method === "POST" && path === "/api/upload-dbf") {
      try {
        const ct = request.headers.get("content-type") || "";
        if (!ct.includes("multipart/form-data")) {
          return json({ ok: false, error: "Expected multipart/form-data" }, 400);
        }

        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return json({ ok: false, error: "Missing file" }, 400);
        }

        const buf = await file.arrayBuffer();
        const rawRows = await parseDbfRows(buf);

        let targetLoc = null;
        const converted = [];

        for (const r of rawRows) {
          const key = mfKey(r.MFCID, r.PARTNO, r.SERNO);
          const last3 = last3FromSiteno(r.SITENO);
          if (!last3) continue;

          const loc = SITE_LAST3_TO_LOCATION[last3];
          if (!loc) continue;
          

          if (!targetLoc) targetLoc = loc;
          if (targetLoc !== loc) {
            return json({ ok: false, error: "Each DBF must be for exactly one location (mixed SITENO codes found)." }, 400);
          }

          converted.push({
            MFCID_PARTNO_SERNO: key,
            GNAME: r.GNAME ?? null,
            DIST_ID: r.DIST_ID ?? null,
            GTYPE: r.GTYPE ?? null,
            GCOST: r.GCOST ?? null,
            SITENO: r.SITENO ?? null,
            INV_NUM: r.INV_NUM ?? null,
            PLCOST: r.PLCOST ?? null,
            PLNOS: r.PLNOS ?? null,
            IDLGRS: r.IDLGRS ?? null,
            IDLPRZ: r.IDLPRZ ?? null,
            DPURCH: r.DPURCH ?? null,
          });
        }

        if (!targetLoc) return json({ ok: false, error: "Could not determine location from SITENO last 3 digits." }, 400);
        if (converted.length === 0) return json({ ok: false, error: "No usable rows found in DBF." }, 400);

        for (const row of converted) {
          await insertInventory(env, targetLoc, row);
        }

        return json({ ok: true, location: targetLoc, inserted: converted.length });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    /* =========================
       NEW API: Location Open
       - only moves Inventory -> Open for that location
    ========================= */
    if (request.method === "POST" && /^\/api\/location\/[^/]+\/open\/check$/.test(path)) {
      try {
        const loc = requireLocation(path.split("/")[3]);
        const body = await request.json();
        const key = String(body.key || "").trim();
        if (!key) return json({ ok:false, error:"Missing key" }, 400);

        const row = await findRow(env, tInv(loc), key);
        return json({ ok: true, found: !!row, row: row || null });
      } catch (e) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && /^\/api\/location\/[^/]+\/open\/confirm$/.test(path)) {
      try {
        const loc = requireLocation(path.split("/")[3]);
        const body = await request.json();
        const key = String(body.key || "").trim();
        if (!key) return json({ ok:false, error:"Missing key" }, 400);

        const row = await findRow(env, tInv(loc), key);
        if (!row) return json({ ok:false, error:"Not found in inventory" }, 404);

        row.DATE_OPEN = new Date().toISOString();
        await moveRow(env, tInv(loc), tOpen(loc), row);

        return json({ ok:true });
      } catch (e) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       NEW API: Location Close
       - only moves Open -> Closed for that location
    ========================= */
    if (request.method === "POST" && /^\/api\/location\/[^/]+\/close\/check$/.test(path)) {
      try {
        const loc = requireLocation(path.split("/")[3]);
        const body = await request.json();
        const key = String(body.key || "").trim();
        if (!key) return json({ ok:false, error:"Missing key" }, 400);

        const row = await findRow(env, tOpen(loc), key);
        return json({ ok: true, found: !!row, row: row || null });
      } catch (e) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && /^\/api\/location\/[^/]+\/close\/confirm$/.test(path)) {
      try {
        const loc = requireLocation(path.split("/")[3]);
        const body = await request.json();
        const key = String(body.key || "").trim();
        const cashHand = Number(body.cashHand);
        if (!key) return json({ ok:false, error:"Missing key" }, 400);
        if (!Number.isFinite(cashHand)) return json({ ok:false, error:"cashHand must be a number" }, 400);

        const row = await findRow(env, tOpen(loc), key);
        if (!row) return json({ ok:false, error:"Not found in open" }, 404);

        row.CASH_HAND = cashHand;
        row.DATE_CLOSED = new Date().toISOString();
        await moveRow(env, tOpen(loc), tClosed(loc), row);

        return json({ ok:true });
      } catch (e) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       NEW API: Emergency inventory move
    ========================= */
    if (request.method === "POST" && path === "/api/emergency/lookup") {
      try {
        const body = await request.json();
        const key = String(body.key || "").trim();
        if (!key) return json({ ok:false, error:"Missing key" }, 400);

        for (const loc of LOCATIONS) {
          const row = await findRow(env, tInv(loc), key);
          if (row) return json({ ok:true, found:true, fromLocation: loc });
        }
        return json({ ok:true, found:false });
      } catch (e) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/emergency/move") {
      try {
        const body = await request.json();
        const key = String(body.key || "").trim();
        const toLocation = requireLocation(String(body.toLocation || ""));
        if (!key) return json({ ok:false, error:"Missing key" }, 400);

        let fromLoc = null;
        let row = null;

        for (const loc of LOCATIONS) {
          const r = await findRow(env, tInv(loc), key);
          if (r) { fromLoc = loc; row = r; break; }
        }
        if (!fromLoc) return json({ ok:false, error:"Not found in any inventory" }, 404);
        if (fromLoc === toLocation) return json({ ok:true, moved:false, reason:"same_location" });

        await moveRow(env, tInv(fromLoc), tInv(toLocation), row);
        return json({ ok:true, moved:true, fromLocation: fromLoc, toLocation });
      } catch (e) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
/* =========================
   NEW API: Transportation live
   GET /api/transportation/live
========================= */
if (request.method === "GET" && path === "/api/transportation/live") {
  try {
    const res = await env.DB.prepare(`SELECT * FROM Transportation ORDER BY rowid DESC`).all();
    return json({ ok: true, results: res.results || [] });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

/* =========================
   NEW API: Pickup page - closed lists by location
   GET /api/pickup/closed
========================= */
if (request.method === "GET" && path === "/api/pickup/closed") {
  try {
    const out = {};
    for (const loc of LOCATIONS) {
      const res = await env.DB.prepare(`
        SELECT MFCID_PARTNO_SERNO, GNAME, CASH_HAND
        FROM ${tClosed(loc)}
        ORDER BY rowid DESC
      `).all();
      out[loc] = res.results || [];
    }
    return json({ ok: true, results: out });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

/* =========================
   NEW API: Pickup confirm
   POST /api/pickup/confirm
   body: { email, employeeName, items:[{location,key}] }
   - inserts into Transportation (key,gname,cash_hand,pick_up)
   - inserts full row into Final_Closed
   - deletes from Location_Closed
========================= */
if (request.method === "POST" && path === "/api/pickup/confirm") {
  try {
    const body = await request.json();
    const email = String(body.email || "").toLowerCase();
    const employeeName = String(body.employeeName || "").trim();
    const items = Array.isArray(body.items) ? body.items : [];

    if (!email) return json({ ok:false, error:"Missing email" }, 400);
    if (items.length === 0) return json({ ok:false, error:"No items selected" }, 400);

    const pickupName =
      email === JOSH_EMAIL.toLowerCase() ? "Josh" :
      email === STEVE_EMAIL.toLowerCase() ? "Steve" :
      (employeeName || "Unknown");

    for (const it of items) {
      const loc = String(it.location || "");
      const key = String(it.key || "").trim();
      if (!LOCATIONS.includes(loc) || !key) continue;

      const row = await findRow(env, tClosed(loc), key);
      if (!row) continue;

      // 1) Transportation
      await env.DB.prepare(`
        INSERT OR REPLACE INTO Transportation (MFCID_PARTNO_SERNO, GNAME, CASH_HAND, PICK_UP)
        VALUES (?, ?, ?, ?)
      `).bind(row.MFCID_PARTNO_SERNO, row.GNAME ?? null, row.CASH_HAND ?? null, pickupName).run();

      // 2) Final_Closed (full row)
      await env.DB.prepare(`
        INSERT OR REPLACE INTO Final_Closed (
          MFCID_PARTNO_SERNO,GNAME,DIST_ID,GTYPE,GCOST,SITENO,INV_NUM,PLCOST,PLNOS,IDLGRS,IDLPRZ,DPURCH,
          CASH_HAND,DATE_OPEN,DATE_CLOSED
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        row.MFCID_PARTNO_SERNO,row.GNAME,row.DIST_ID,row.GTYPE,row.GCOST,row.SITENO,row.INV_NUM,row.PLCOST,row.PLNOS,row.IDLGRS,row.IDLPRZ,row.DPURCH,
        row.CASH_HAND,row.DATE_OPEN,row.DATE_CLOSED
      ).run();

      // 3) Remove from location closed
      await env.DB.prepare(`DELETE FROM ${tClosed(loc)} WHERE MFCID_PARTNO_SERNO = ?`)
        .bind(key).run();
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

/* =========================
   NEW API: Dropped off confirm
   POST /api/transportation/droppedoff
   body: { keys:[...], email }
   - moves each from Transportation to Office + Deposit
   - deletes from Transportation
========================= */
if (request.method === "POST" && path === "/api/transportation/droppedoff") {
  try {
    const body = await request.json();
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) return json({ ok:false, error:"No keys" }, 400);

    const now = new Date().toISOString();

    for (const k of keys) {
      const key = String(k || "").trim();
      if (!key) continue;

      const row = await findRow(env, "Transportation", key);
      if (!row) continue;

      // Office
      await env.DB.prepare(`
        INSERT OR REPLACE INTO Office (
          MFCID_PARTNO_SERNO, GNAME, CASH_HAND, PICK_UP, OFFICE,
          AUDIT_OFFICE_TS, RIVER_ROOM, RIVER_ROOM_TS, BIN_NUMBER, BIN_NUMBER_TS, STORAGE, STORAGE_TS
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `).bind(row.MFCID_PARTNO_SERNO, row.GNAME ?? null, row.CASH_HAND ?? null, row.PICK_UP ?? null, now).run();

      // Deposit
      await env.DB.prepare(`
        INSERT OR REPLACE INTO Deposit (MFCID_PARTNO_SERNO, CASH_HAND, PICK_UP, GOING_TO_BANK, DROPED_AT_BANK)
        VALUES (?, ?, ?, NULL, NULL)
      `).bind(row.MFCID_PARTNO_SERNO, row.CASH_HAND ?? null, row.PICK_UP ?? null).run();

      // remove from Transportation
      await env.DB.prepare(`DELETE FROM Transportation WHERE MFCID_PARTNO_SERNO = ?`)
        .bind(key).run();
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

/* =========================
   NEW API: Deposit lists + actions
========================= */

// GET /api/deposit/pending  (no going_to_bank and no droped_at_bank)
if (request.method === "GET" && path === "/api/deposit/pending") {
  try {
    const res = await env.DB.prepare(`
      SELECT * FROM Deposit
      WHERE GOING_TO_BANK IS NULL AND DROPED_AT_BANK IS NULL
      ORDER BY rowid DESC
    `).all();
    return json({ ok:true, results: res.results || [] });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

// GET /api/deposit/atbank-list (going_to_bank set, droped_at_bank null)
if (request.method === "GET" && path === "/api/deposit/atbank-list") {
  try {
    const res = await env.DB.prepare(`
      SELECT * FROM Deposit
      WHERE GOING_TO_BANK IS NOT NULL AND DROPED_AT_BANK IS NULL
      ORDER BY rowid DESC
    `).all();
    return json({ ok:true, results: res.results || [] });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

// POST /api/deposit/tobank { keys:[...] }
if (request.method === "POST" && path === "/api/deposit/tobank") {
  try {
    const body = await request.json();
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) return json({ ok:false, error:"No keys" }, 400);

    const now = new Date().toISOString();

    for (const k of keys) {
      const key = String(k || "").trim();
      if (!key) continue;
      await env.DB.prepare(`
        UPDATE Deposit
        SET GOING_TO_BANK = ?
        WHERE MFCID_PARTNO_SERNO = ?
          AND GOING_TO_BANK IS NULL
          AND DROPED_AT_BANK IS NULL
      `).bind(now, key).run();
    }
    return json({ ok:true });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

// POST /api/deposit/atbank { keys:[...] }
if (request.method === "POST" && path === "/api/deposit/atbank") {
  try {
    const body = await request.json();
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) return json({ ok:false, error:"No keys" }, 400);

    const now = new Date().toISOString();

    for (const k of keys) {
      const key = String(k || "").trim();
      if (!key) continue;
      await env.DB.prepare(`
        UPDATE Deposit
        SET DROPED_AT_BANK = ?
        WHERE MFCID_PARTNO_SERNO = ?
          AND GOING_TO_BANK IS NOT NULL
          AND DROPED_AT_BANK IS NULL
      `).bind(now, key).run();
    }
    return json({ ok:true });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

/* =========================
   NEW API: OfficeLocation
   - find
   - scan step updates
========================= */

// POST /api/office/find { key }
if (request.method === "POST" && path === "/api/office/find") {
  try {
    const body = await request.json();
    const key = String(body.key || "").trim();
    if (!key) return json({ ok:false, error:"Missing key" }, 400);

    const row = await findRow(env, "Office", key);
    return json({ ok:true, found: !!row, row: row || null });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

// POST /api/office/scan { key, scannedValue }
if (request.method === "POST" && path === "/api/office/scan") {
  try {
    const body = await request.json();
    const key = String(body.key || "").trim();
    const scannedValue = String(body.scannedValue || "").trim();
    if (!key) return json({ ok:false, error:"Missing key" }, 400);
    if (!scannedValue) return json({ ok:false, error:"Missing scannedValue" }, 400);

    const row = await findRow(env, "Office", key);
    if (!row) return json({ ok:false, error:"Not found in Office" }, 404);

    const now = new Date().toISOString();
    const hasAudit = !!row.AUDIT_OFFICE_TS;
    const hasRiver = !!row.RIVER_ROOM_TS;
    const hasBin = !!row.BIN_NUMBER_TS;
    const hasStorage = !!row.STORAGE_TS;

    // All filled
    if (hasAudit && hasRiver && hasBin && hasStorage) {
      return json({ ok:true, done:true, message:"all_columns_filled" });
    }

    // Step 1: audit office barcode
    if (!hasAudit) {
      if (scannedValue.toLowerCase() !== "auditors office") {
        return json({ ok:false, error:'Expected "auditors office"' }, 400);
      }
      await env.DB.prepare(`
        UPDATE Office SET AUDIT_OFFICE_TS = ?
        WHERE MFCID_PARTNO_SERNO = ? AND AUDIT_OFFICE_TS IS NULL
      `).bind(now, key).run();
      return json({ ok:true, step:"AUDIT_OFFICE" });
    }

    // Step 2: river room
    if (!hasRiver) {
      const allowed = ["silver","sockeye","king","pink","chumb"];
      if (!allowed.includes(scannedValue.toLowerCase())) {
        return json({ ok:false, error:"Expected Silver/Sockeye/King/Pink/Chumb" }, 400);
      }
      await env.DB.prepare(`
        UPDATE Office SET RIVER_ROOM = ?, RIVER_ROOM_TS = ?
        WHERE MFCID_PARTNO_SERNO = ? AND RIVER_ROOM_TS IS NULL
      `).bind(scannedValue, now, key).run();
      return json({ ok:true, step:"RIVER_ROOM" });
    }

    // Step 3: bin number 0-900
    if (!hasBin) {
      const n = Number(scannedValue);
      if (!Number.isInteger(n) || n < 0 || n > 900) {
        return json({ ok:false, error:"Expected bin number 0-900" }, 400);
      }
      await env.DB.prepare(`
        UPDATE Office SET BIN_NUMBER = ?, BIN_NUMBER_TS = ?
        WHERE MFCID_PARTNO_SERNO = ? AND BIN_NUMBER_TS IS NULL
      `).bind(String(n), now, key).run();
      return json({ ok:true, step:"BIN_NUMBER" });
    }

    // Step 4: storage "word number" num 0-100
    if (!hasStorage) {
      const m = scannedValue.match(/^([A-Za-z]+)\s+(\d{1,3})$/);
      if (!m) return json({ ok:false, error:'Expected "Word Number" (ex: Rack 12)' }, 400);
      const num = Number(m[2]);
      if (!Number.isInteger(num) || num < 0 || num > 100) {
        return json({ ok:false, error:"Storage number must be 0-100" }, 400);
      }
      await env.DB.prepare(`
        UPDATE Office SET STORAGE = ?, STORAGE_TS = ?
        WHERE MFCID_PARTNO_SERNO = ? AND STORAGE_TS IS NULL
      `).bind(scannedValue, now, key).run();
      return json({ ok:true, step:"STORAGE" });
    }

    return json({ ok:false, error:"Unexpected state" }, 400);
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

/* =========================
   NEW API: Issues for Dashboard
========================= */

// POST /api/issues/add { key, text }
if (request.method === "POST" && path === "/api/issues/add") {
  try {
    const body = await request.json();
    const key = String(body.key || "").trim();
    const text = String(body.text || "").trim();
    if (!key) return json({ ok:false, error:"Missing key" }, 400);
    if (!text || text.length > 500) return json({ ok:false, error:"Issue text required (<=500)" }, 400);

    await env.DB.prepare(`
      INSERT INTO Game_Issues (MFCID_PARTNO_SERNO, ISSUE_TEXT, CREATED_AT)
      VALUES (?, ?, ?)
    `).bind(key, text, new Date().toISOString()).run();

    return json({ ok:true });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

// GET /api/issues/live
if (request.method === "GET" && path === "/api/issues/live") {
  try {
    const res = await env.DB.prepare(`SELECT * FROM Game_Issues ORDER BY ID DESC LIMIT 500`).all();
    return json({ ok:true, results: res.results || [] });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

// POST /api/issues/fix { id }
if (request.method === "POST" && path === "/api/issues/fix") {
  try {
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ ok:false, error:"Invalid id" }, 400);

    await env.DB.prepare(`DELETE FROM Game_Issues WHERE ID = ?`).bind(id).run();
    return json({ ok:true });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}

/* =========================
   NEW API: Dashboard counts
   GET /api/dashboard/counts
   - per location: closed count
   - deposits pending count
========================= */
if (request.method === "GET" && path === "/api/dashboard/counts") {
  try {
    const perLoc = {};
    for (const loc of LOCATIONS) {
      const r = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${tClosed(loc)}`).all();
      perLoc[loc] = Number(r.results?.[0]?.c || 0);
    }
    const dep = await env.DB.prepare(`
      SELECT COUNT(*) as c FROM Deposit
      WHERE GOING_TO_BANK IS NULL AND DROPED_AT_BANK IS NULL
    `).all();
    const depositsPending = Number(dep.results?.[0]?.c || 0);

    return json({ ok:true, perLoc, depositsPending });
  } catch (e) {
    return json({ ok:false, error:String(e) }, 500);
  }
}
