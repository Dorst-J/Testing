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
  "014": "McDuffs",
  // "???": "Chanticlear",
  // "???": "Willies",
  // "???": "Northwoods",
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
