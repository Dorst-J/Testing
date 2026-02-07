import * as shapefile from "shapefile";

/* =========================
   CORS + Response helpers
========================= */

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowed = ["https://thedatatab.com"];
  const o = allowed.includes(origin) ? origin : "https://thedatatab.com";

  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

function text(request, msg, status = 200) {
  return new Response(msg, { status, headers: corsHeaders(request) });
}


/* =========================
   CONFIG
========================= */

const LOCATIONS = ["Chanticlear", "McDuffs", "Willies", "Northwoods"];

// Update to match YOUR SITENO mapping
const SITE_LAST3_TO_LOCATION = {
  "014": "McDuffs",
  "006": "Chanticlear",
  "012": "Willies",
  "009": "Northwoods",
};

const PICKERS = ["Josh", "Steve"]; // only these two allowed

/* =========================
   Helpers
========================= */

function requireLocation(loc) {
  if (!LOCATIONS.includes(loc)) throw new Error("BAD_LOCATION");
  return loc;
}

function requirePicker(picker) {
  const p = String(picker || "").trim();
  if (!PICKERS.includes(p)) throw new Error("BAD_PICKER");
  return p;
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

function nowIso() {
  return new Date().toISOString();
}

function toSqlValue(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10); // YYYY-MM-DD
  if (typeof v === "object") return String(v);               // safety
  return v;
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
  const values = cols.map(c => toSqlValue(row[c]));

  const insert = env.DB.prepare(`
    INSERT OR REPLACE INTO ${toTable} (${cols.join(",")})
    VALUES (${cols.map(()=>"?").join(",")})
  `).bind(...values);

  const del = env.DB.prepare(`DELETE FROM ${fromTable} WHERE MFCID_PARTNO_SERNO = ?`)
    .bind(toSqlValue(row.MFCID_PARTNO_SERNO));

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
    toSqlValue(row.MFCID_PARTNO_SERNO),
    toSqlValue(row.GNAME),
    toSqlValue(row.DIST_ID),
    toSqlValue(row.GTYPE),
    toSqlValue(row.GCOST),
    toSqlValue(row.SITENO),
    toSqlValue(row.INV_NUM),
    toSqlValue(row.PLCOST),
    toSqlValue(row.PLNOS),
    toSqlValue(row.IDLGRS),
    toSqlValue(row.IDLPRZ),
    toSqlValue(row.DPURCH)
  ).run();
}

/* =========================
   Worker
========================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Debug routes
    if (request.method === "GET" && path === "/api/debug/routes") {
      return json(request, {
        ok: true,
        hasDb: !!env.DB,
        routes: [
          "/health",
          "/api/inventory/live",
          "/api/upload-dbf",
          "/api/emergency/lookup",
          "/api/emergency/move",
          "/api/location/{loc}/open/check",
          "/api/location/{loc}/open/confirm",
          "/api/location/{loc}/close/check",
          "/api/location/{loc}/close/confirm",
          "/api/pickup/list",
          "/api/pickup/confirm",
          "/api/transportation/live",
          "/api/transportation/dropoff",
          "/api/deposit/list",
          "/api/deposit/toBank",
          "/api/deposit/atBank",
          "/api/office/find",
          "/api/office/scan",
          "/api/issues/add",
          "/api/issues/list",
          "/api/issues/fix",
          "/api/dashboard/summary"
        ]
      });
    }

    // Health
    if (request.method === "GET" && path === "/health") {
      return json(request, { ok: true, worker: "overview", time: new Date().toISOString() });
    }

    /* =========================
       Live inventory list (all)
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
        return json(request, { ok: true, results });
      } catch (e) {
        return json(request, { ok: false, error: String(e) }, 500);
      }
    }

    /* =========================
       Upload DBF
       multipart field: "file"
    ========================= */
    if (request.method === "POST" && path === "/api/upload-dbf") {
      try {
        const ct = request.headers.get("content-type") || "";
        if (!ct.includes("multipart/form-data")) {
          return json(request, { ok: false, error: "Expected multipart/form-data" }, 400);
        }

        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json(request, { ok:false, error:"Missing file" }, 400);

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
            return json(request, { ok:false, error:"Each DBF must be for exactly one location (mixed SITENO codes found)." }, 400);
          }

          converted.push({
            MFCID_PARTNO_SERNO: key,
            GNAME: toSqlValue(r.GNAME),
            DIST_ID: toSqlValue(r.DIST_ID),
            GTYPE: toSqlValue(r.GTYPE),
            GCOST: toSqlValue(r.GCOST),
            SITENO: toSqlValue(r.SITENO),
            INV_NUM: toSqlValue(r.INV_NUM),
            PLCOST: toSqlValue(r.PLCOST),
            PLNOS: toSqlValue(r.PLNOS),
            IDLGRS: toSqlValue(r.IDLGRS),
            IDLPRZ: toSqlValue(r.IDLPRZ),
            DPURCH: toSqlValue(r.DPURCH),
          });
        }

        if (!targetLoc) return json(request, { ok:false, error:"Could not determine location from SITENO mapping." }, 400);
        if (converted.length === 0) return json(request, { ok:false, error:"No usable rows found in DBF." }, 400);

        for (const row of converted) {
          await insertInventory(env, targetLoc, row);
        }

        return json(request, { ok:true, location: targetLoc, inserted: converted.length });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       Emergency lookup / move
    ========================= */
    if (request.method === "POST" && path === "/api/emergency/lookup") {
      try {
        const body = await request.json();
        const key = String(body.key || "").trim();
        if (!key) return json(request, { ok:false, error:"Missing key" }, 400);

        for (const loc of LOCATIONS) {
          const row = await findRow(env, tInv(loc), key);
          if (row) return json(request, { ok:true, found:true, fromLocation: loc });
        }
        return json(request, { ok:true, found:false });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/emergency/move") {
      try {
        const body = await request.json();
        const key = String(body.key || "").trim();
        const toLocation = requireLocation(String(body.toLocation || ""));
        if (!key) return json(request, { ok:false, error:"Missing key" }, 400);

        let fromLoc = null;
        let row = null;

        for (const loc of LOCATIONS) {
          const r = await findRow(env, tInv(loc), key);
          if (r) { fromLoc = loc; row = r; break; }
        }
        if (!fromLoc) return json(request, { ok:false, error:"Not found in any inventory" }, 404);
        if (fromLoc === toLocation) return json(request, { ok:true, moved:false, reason:"same_location" });

        await moveRow(env, tInv(fromLoc), tInv(toLocation), row);
        return json(request, { ok:true, moved:true, fromLocation: fromLoc, toLocation });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       SELLER: Inventory -> Open
    ========================= */
    {
      const m = path.match(/^\/api\/location\/([^/]+)\/open\/check$/);
      if (request.method === "POST" && m) {
        try {
          const loc = requireLocation(decodeURIComponent(m[1]));
          const body = await request.json();
          const key = String(body.key || "").trim();
          if (!key) return json(request, { ok:false, error:"Missing key" }, 400);

          const row = await findRow(env, tInv(loc), key);
          return json(request, { ok:true, found: !!row, row });
        } catch (e) {
          return json(request, { ok:false, error:String(e) }, 500);
        }
      }
    }

    {
      const m = path.match(/^\/api\/location\/([^/]+)\/open\/confirm$/);
      if (request.method === "POST" && m) {
        try {
          const loc = requireLocation(decodeURIComponent(m[1]));
          const body = await request.json();
          const key = String(body.key || "").trim();
          if (!key) return json(request, { ok:false, error:"Missing key" }, 400);

          const row = await findRow(env, tInv(loc), key);
          if (!row) return json(request, { ok:true, found:false });

          row.DATE_OPEN = nowIso();
          await moveRow(env, tInv(loc), tOpen(loc), row);

          return json(request, { ok:true, moved:true });
        } catch (e) {
          return json(request, { ok:false, error:String(e) }, 500);
        }
      }
    }

    /* =========================
       SELLER: Open -> Closed
    ========================= */
    {
      const m = path.match(/^\/api\/location\/([^/]+)\/close\/check$/);
      if (request.method === "POST" && m) {
        try {
          const loc = requireLocation(decodeURIComponent(m[1]));
          const body = await request.json();
          const key = String(body.key || "").trim();
          if (!key) return json(request, { ok:false, error:"Missing key" }, 400);

          const row = await findRow(env, tOpen(loc), key);
          return json(request, { ok:true, found: !!row, row });
        } catch (e) {
          return json(request, { ok:false, error:String(e) }, 500);
        }
      }
    }

    {
      const m = path.match(/^\/api\/location\/([^/]+)\/close\/confirm$/);
      if (request.method === "POST" && m) {
        try {
          const loc = requireLocation(decodeURIComponent(m[1]));
          const body = await request.json();
          const key = String(body.key || "").trim();
          const cashHand = Number(body.cashHand);

          if (!key) return json(request, { ok:false, error:"Missing key" }, 400);
          if (!Number.isFinite(cashHand)) return json(request, { ok:false, error:"Missing/invalid cashHand" }, 400);

          const row = await findRow(env, tOpen(loc), key);
          if (!row) return json(request, { ok:true, found:false });

          row.CASH_HAND = cashHand;
          row.DATE_CLOSED = nowIso();

          await moveRow(env, tOpen(loc), tClosed(loc), row);
          return json(request, { ok:true, moved:true });
        } catch (e) {
          return json(request, { ok:false, error:String(e) }, 500);
        }
      }
    }

    /* =========================
       PICKUP: list closed games
       (no auth)
    ========================= */
    if (request.method === "GET" && path === "/api/pickup/list") {
      try {
        const byLocation = {};
        for (const loc of LOCATIONS) {
          const res = await env.DB.prepare(`
            SELECT MFCID_PARTNO_SERNO, GNAME, CASH_HAND
            FROM ${tClosed(loc)}
            ORDER BY rowid DESC
            LIMIT 2000
          `).all();
          byLocation[loc] = res.results || [];
        }
        return json(request, { ok:true, byLocation });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       PICKUP: confirm selection
       body: { picker: "Josh"|"Steve", keys: [{location, key}, ...] }
       - Insert into Transportation
       - Move row into Final_Closed
       - Delete from {loc}_Closed
    ========================= */
    if (request.method === "POST" && path === "/api/pickup/confirm") {
      try {
        const body = await request.json();
        const picker = requirePicker(body.picker);

        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (keys.length === 0) return json(request, { ok:false, error:"No games selected" }, 400);

        const batch = [];
        let moved = 0;
        const errors = [];

        for (const item of keys) {
          try {
            const loc = requireLocation(String(item.location || ""));
            const key = String(item.key || "").trim();
            if (!key) continue;

            const row = await findRow(env, tClosed(loc), key);
            if (!row) continue;

            // Transportation insert
            batch.push(env.DB.prepare(`
              INSERT OR REPLACE INTO Transportation (MFCID_PARTNO_SERNO, GNAME, CASH_HAND, PICK_UP)
              VALUES (?, ?, ?, ?)
            `).bind(
              toSqlValue(row.MFCID_PARTNO_SERNO),
              toSqlValue(row.GNAME),
              toSqlValue(row.CASH_HAND),
              picker
            ));

            // Archive into Final_Closed
            batch.push(env.DB.prepare(`
              INSERT OR REPLACE INTO Final_Closed (
                MFCID_PARTNO_SERNO, GNAME, DIST_ID, GTYPE, GCOST, SITENO, INV_NUM,
                PLCOST, PLNOS, IDLGRS, IDLPRZ, DPURCH, CASH_HAND, DATE_OPEN, DATE_CLOSED
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              toSqlValue(row.MFCID_PARTNO_SERNO),
              toSqlValue(row.GNAME),
              toSqlValue(row.DIST_ID),
              toSqlValue(row.GTYPE),
              toSqlValue(row.GCOST),
              toSqlValue(row.SITENO),
              toSqlValue(row.INV_NUM),
              toSqlValue(row.PLCOST),
              toSqlValue(row.PLNOS),
              toSqlValue(row.IDLGRS),
              toSqlValue(row.IDLPRZ),
              toSqlValue(row.DPURCH),
              toSqlValue(row.CASH_HAND),
              toSqlValue(row.DATE_OPEN),
              toSqlValue(row.DATE_CLOSED)
            ));

            // Delete from loc closed
            batch.push(env.DB.prepare(`DELETE FROM ${tClosed(loc)} WHERE MFCID_PARTNO_SERNO = ?`).bind(key));

            moved++;
          } catch (err) {
            errors.push(String(err));
          }
        }

        if (batch.length === 0) return json(request, { ok:false, error:"Nothing moved" }, 400);

        await env.DB.batch(batch);
        return json(request, { ok:true, picker, moved, errors });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       TRANSPORTATION: live list
    ========================= */
    if (request.method === "GET" && path === "/api/transportation/live") {
      try {
        const res = await env.DB.prepare(`
          SELECT * FROM Transportation
          ORDER BY rowid DESC
          LIMIT 5000
        `).all();
        return json(request, { ok:true, results: res.results || [] });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       TRANSPORTATION: drop off confirm
       body: { keys: [MFCID_PARTNO_SERNO...] }
       - move from Transportation -> Office and Deposit
       - delete from Transportation
    ========================= */
    if (request.method === "POST" && path === "/api/transportation/dropoff") {
      try {
        const body = await request.json();
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (keys.length === 0) return json(request, { ok:false, error:"No keys selected" }, 400);

        const officeDate = nowIso();
        const batch = [];

        for (const key of keys) {
          const res = await env.DB.prepare(`SELECT * FROM Transportation WHERE MFCID_PARTNO_SERNO = ?`)
            .bind(String(key).trim())
            .all();
          const row = res.results?.[0];
          if (!row) continue;

          batch.push(env.DB.prepare(`
            INSERT OR REPLACE INTO Office
            (MFCID_PARTNO_SERNO, GNAME, CASH_HAND, PICK_UP, OFFICE, AUDIT_OFFICE, RIVER_ROOM, BIN_NUMBER, STORAGE)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
          `).bind(
            toSqlValue(row.MFCID_PARTNO_SERNO),
            toSqlValue(row.GNAME),
            toSqlValue(row.CASH_HAND),
            toSqlValue(row.PICK_UP),
            officeDate
          ));

          batch.push(env.DB.prepare(`
            INSERT OR REPLACE INTO Deposit
            (MFCID_PARTNO_SERNO, CASH_HAND, PICK_UP, GOING_TO_BANK, DROPED_AT_BANK)
            VALUES (?, ?, ?, NULL, NULL)
          `).bind(
            toSqlValue(row.MFCID_PARTNO_SERNO),
            toSqlValue(row.CASH_HAND),
            toSqlValue(row.PICK_UP)
          ));

          batch.push(env.DB.prepare(`DELETE FROM Transportation WHERE MFCID_PARTNO_SERNO = ?`).bind(row.MFCID_PARTNO_SERNO));
        }

        await env.DB.batch(batch);
        return json(request, { ok:true });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       DEPOSIT list / toBank / atBank
    ========================= */
    if (request.method === "GET" && path === "/api/deposit/list") {
      try {
        const res = await env.DB.prepare(`SELECT * FROM Deposit ORDER BY rowid DESC LIMIT 5000`).all();
        return json(request, { ok:true, results: res.results || [] });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/deposit/toBank") {
      try {
        const body = await request.json();
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (keys.length === 0) return json(request, { ok:false, error:"No keys selected" }, 400);

        const dt = nowIso();
        const batch = keys.map(k => env.DB.prepare(`
          UPDATE Deposit
          SET GOING_TO_BANK = ?
          WHERE MFCID_PARTNO_SERNO = ?
            AND GOING_TO_BANK IS NULL
            AND DROPED_AT_BANK IS NULL
        `).bind(dt, String(k).trim()));

        await env.DB.batch(batch);
        return json(request, { ok:true });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/deposit/atBank") {
      try {
        const body = await request.json();
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (keys.length === 0) return json(request, { ok:false, error:"No keys selected" }, 400);

        const dt = nowIso();
        const batch = keys.map(k => env.DB.prepare(`
          UPDATE Deposit
          SET DROPED_AT_BANK = ?
          WHERE MFCID_PARTNO_SERNO = ?
            AND GOING_TO_BANK IS NOT NULL
            AND DROPED_AT_BANK IS NULL
        `).bind(dt, String(k).trim()));

        await env.DB.batch(batch);
        return json(request, { ok:true });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       OFFICE find / scan
    ========================= */
    if (request.method === "POST" && path === "/api/office/find") {
      try {
        const body = await request.json();
        const key = String(body.key || "").trim();
        if (!key) return json(request, { ok:false, error:"Missing key" }, 400);

        const res = await env.DB.prepare(`SELECT * FROM Office WHERE MFCID_PARTNO_SERNO = ?`).bind(key).all();
        const row = res.results?.[0] || null;
        return json(request, { ok:true, found: !!row, row });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/office/scan") {
      try {
        const body = await request.json();
        const key = String(body.key || "").trim();
        const scannedValue = String(body.scannedValue || "").trim();

        if (!key || !scannedValue) return json(request, { ok:false, error:"Missing key/scannedValue" }, 400);

        const res = await env.DB.prepare(`SELECT * FROM Office WHERE MFCID_PARTNO_SERNO = ?`).bind(key).all();
        const row = res.results?.[0];
        if (!row) return json(request, { ok:false, error:"Not found" }, 404);

        const dt = nowIso();

        if (!row.AUDIT_OFFICE) {
          if (scannedValue.toLowerCase() !== "auditors office") {
            return json(request, { ok:false, error:"Expected scan: auditors office" }, 400);
          }
          await env.DB.prepare(`UPDATE Office SET AUDIT_OFFICE = ? WHERE MFCID_PARTNO_SERNO = ?`).bind(dt, key).run();
          return json(request, { ok:true, updated:"AUDIT_OFFICE", dt });
        }

        if (!row.RIVER_ROOM) {
          const ok = ["silver","sockeye","king","pink","chumb"].includes(scannedValue.toLowerCase());
          if (!ok) return json(request, { ok:false, error:"Expected Silver/Sockeye/King/Pink/Chumb" }, 400);
          await env.DB.prepare(`UPDATE Office SET RIVER_ROOM = ? WHERE MFCID_PARTNO_SERNO = ?`).bind(`${scannedValue} @ ${dt}`, key).run();
          return json(request, { ok:true, updated:"RIVER_ROOM", dt });
        }

        if (!row.BIN_NUMBER) {
          const n = Number(scannedValue);
          if (!Number.isInteger(n) || n < 0 || n > 900) return json(request, { ok:false, error:"Expected bin number 0-900" }, 400);
          await env.DB.prepare(`UPDATE Office SET BIN_NUMBER = ? WHERE MFCID_PARTNO_SERNO = ?`).bind(`${n} @ ${dt}`, key).run();
          return json(request, { ok:true, updated:"BIN_NUMBER", dt });
        }

        if (!row.STORAGE) {
          if (!/^[A-Za-z]+\s+\d{1,3}$/.test(scannedValue)) {
            return json(request, { ok:false, error:"Expected: Word + number (0-100)" }, 400);
          }
          await env.DB.prepare(`UPDATE Office SET STORAGE = ? WHERE MFCID_PARTNO_SERNO = ?`).bind(`${scannedValue} @ ${dt}`, key).run();
          return json(request, { ok:true, updated:"STORAGE", dt });
        }

        return json(request, { ok:false, error:"All columns are filled" }, 409);
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       Issues add/list/fix
    ========================= */
    if (request.method === "POST" && path === "/api/issues/add") {
      try {
        const body = await request.json();
        const key = String(body.key || "").trim();
        const issue = String(body.issue || "").trim();
        if (!key || !issue) return json(request, { ok:false, error:"Missing key/issue" }, 400);
        if (issue.length > 500) return json(request, { ok:false, error:"Issue too long (max 500)" }, 400);

        await env.DB.prepare(`
          INSERT INTO GameIssues (MFCID_PARTNO_SERNO, issue, created_at)
          VALUES (?, ?, ?)
        `).bind(key, issue, nowIso()).run();

        return json(request, { ok:true });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "GET" && path === "/api/issues/list") {
      try {
        const res = await env.DB.prepare(`
          SELECT id, MFCID_PARTNO_SERNO, issue, created_at
          FROM GameIssues
          ORDER BY id DESC
          LIMIT 5000
        `).all();
        return json(request, { ok:true, results: res.results || [] });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    if (request.method === "POST" && path === "/api/issues/fix") {
      try {
        const body = await request.json();
        const id = Number(body.id);
        if (!Number.isInteger(id)) return json(request, { ok:false, error:"Missing id" }, 400);
        await env.DB.prepare(`DELETE FROM GameIssues WHERE id = ?`).bind(id).run();
        return json(request, { ok:true });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    /* =========================
       Dashboard summary (counts)
    ========================= */
    if (request.method === "GET" && path === "/api/dashboard/summary") {
      try {
        const counts = {};
        for (const loc of LOCATIONS) {
          const res = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${tClosed(loc)}`).all();
          counts[loc] = Number(res.results?.[0]?.c || 0);
        }

        const dep = await env.DB.prepare(`
          SELECT COUNT(*) AS c
          FROM Deposit
          WHERE GOING_TO_BANK IS NULL AND DROPED_AT_BANK IS NULL
        `).all();

        return json(request, {
          ok:true,
          closedCounts: counts,
          depositPending: Number(dep.results?.[0]?.c || 0),
        });
      } catch (e) {
        return json(request, { ok:false, error:String(e) }, 500);
      }
    }

    return text(request, "Not found", 404);
  }
};
