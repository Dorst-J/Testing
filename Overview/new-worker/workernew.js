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
   CONFIG
========================= */

const LOCATIONS = ["Chanticlear", "McDuffs", "Willies", "Northwoods"];

// Map SITENO last-3 digits -> Location
// Example you gave: -98049-014 is McDuffs, so "014": "McDuffs"
const SITE_LAST3_TO_LOCATION = {
  "006": "McDuffs",
  "014": "Chanticlear",
  "012": "Willies",
  "009": "Northwoods",
};

// Who is picking up (used when pickup button is pressed)
const JOSH_EMAIL = "sedorst17@gmail.com";     // <-- replace
const STEVE_EMAIL = "jenna.dorst@gmail.com";   // <-- replace

/* =========================
   Helpers
========================= */

function requireLocation(loc) {
  if (!LOCATIONS.includes(loc)) throw new Error("BAD_LOCATION");
  return loc;
}

function tInv(loc) { return `${loc}_Inventory`; }

function mfKey(mfcid, partno, serno) {
  return `${String(mfcid).trim()} ${String(partno).trim()} ${String(serno).trim()}`.trim();
}

function last3FromSiteno(siteno) {
  const s = String(siteno || "").trim();
  const last3 = s.slice(-3);
  return /^\d{3}$/.test(last3) ? last3 : null;
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
  // Same schema expected on both inventory tables
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
   Worker
========================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/api/debug/routes") {
  return json({
    ok: true,
    routes: [
      "/health",
      "/signin",
      "/logs",
      "/api/inventory/live",
      "/api/upload-dbf",
      "/api/emergency/lookup",
      "/api/emergency/move"
    ]
  });
}
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // --- existing endpoints ---
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
       GET /api/inventory/live
       (all inventories across locations)
    ========================= */
    if (request.method === "GET" && path === "/api/inventory/live") {
      try {
        if (!env.DB) return json({ ok:false, error:"Missing D1 binding env.DB" }, 500);

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
       POST /api/upload-dbf
       multipart/form-data field "file"
    ========================= */
    function toSqlValue(v) {
  if (v === undefined || v === null) return null;
  // Convert Date objects to ISO date string
  if (v instanceof Date) return v.toISOString().slice(0, 10); // "YYYY-MM-DD"
  // Some DBF parsers return objects that stringify like Date
  if (typeof v === "object") return String(v);
  return v;
}

    if (request.method === "POST" && path === "/api/upload-dbf") {
      try {
        if (!env.DB) return json({ ok:false, error:"Missing D1 binding env.DB" }, 500);

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

        if (!targetLoc) {
          return json({
            ok: false,
            error: "Could not determine location from SITENO last 3 digits. Check SITE_LAST3_TO_LOCATION mapping and DBF SITENO values."
          }, 400);
        }

        if (converted.length === 0) {
          return json({ ok: false, error: "No usable rows found in DBF (missing required fields or SITENO mapping)." }, 400);
        }

        for (const row of converted) {
          await insertInventory(env, targetLoc, row);
        }

        return json({ ok: true, location: targetLoc, inserted: converted.length });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    /* =========================
       POST /api/emergency/lookup { key }
       Searches ALL inventories
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

    /* =========================
       POST /api/emergency/move { key, toLocation }
       Moves ONLY Inventory -> Inventory (cross-location)
    ========================= */
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
