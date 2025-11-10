// --- Worker Utility Functions ---
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://thedatatab.com", // Ensure this is correct
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

const INVENTORY_TABLE = "Chanticlear_Inventory";
const OPEN_TABLE = "Chanticlear_Open";
const CLOSED_TABLE = "Chanticlear_Closed";
const DB_NAME = "araa_testing";

// Column names must be in the exact order for INSERT
const ALL_COLUMNS = [
  "Serial_MF_Part", "Game_Name", "Ticket_Price", "Numer_Tickets",
  "Tickets_Sold", "Current_Tickets", "Number_Winners", "Winners_Sold",
  "Current_Winners", "P_NP", "Cash_Hand", "Ideal_Gross",
  "Ideal_Prize", "Ideal_Net", "Game_cost", "Status", "Box_Number"
];

// Columns to show in the Main Page pop-up
const POPUP_COLUMNS = [
    "Serial_MF_Part", "Game_Name", "Cash_Hand", "Current_Tickets", "Current_Winners"
];

/**
 * Searches all tables for a Serial_MF_Part.
 * @param {string} serial The serial number to search for.
 * @param {D1Database} db The D1 database instance (env.araa_testing).
 * @returns {Promise<{table: string|null, row: object|null}>}
 */
async function findGameBySerial(serial, db) {
    // List tables in the order we want to check (Inventory is often first or Open)
    for (const tableName of [OPEN_TABLE, INVENTORY_TABLE, CLOSED_TABLE]) {
        // Use a standard SQL SELECT *
        const query = `SELECT * FROM ${tableName} WHERE Serial_MF_Part = ?`;
        
        // D1 execution pattern: prepare -> bind -> all
        const { results } = await db.prepare(query).bind(serial).all();
        
        // D1 returns an object with a results array. Check if the array has entries.
        if (results.length > 0) {
            return { table: tableName, row: results[0] };
        }
    }
    return { table: null, row: null };
}

/**
 * Moves a row from its current table to a new table.
 */
async function moveRow(serial, currentTable, newTable, data, db) {
    // We must ensure ALL_COLUMNS is defined at the top of worker.js
    // const ALL_COLUMNS = [ "Serial_MF_Part", "Game_Name", "Ticket_Price", "Numer_Tickets", ... ];
    
    await db.exec("BEGIN");
    try {
        let row = data; // Use the provided data (which includes new Box_Number/Status)

        // 1. Construct INSERT query for the new table
        const cols = ALL_COLUMNS.join(", "); // e.g., "Serial_MF_Part, Game_Name, ..."
        const placeholders = ALL_COLUMNS.map(() => '?').join(", "); // e.g., "?, ?, ?"
        
        // 2. Map row data to the exact order of ALL_COLUMNS
        const values = ALL_COLUMNS.map(col => {
            // D1 requires explicit nulls for columns that should be null
            return (row[col] === undefined || row[col] === null) ? null : row[col];
        });

        const insertQuery = `INSERT INTO ${newTable} (${cols}) VALUES (${placeholders})`;
        
        // Use .run() for INSERT, not .all()
        const insertResult = await db.prepare(insertQuery).bind(...values).run();
        
        // Check if the INSERT was successful (optional but helpful)
        if (insertResult.success === false && insertResult.error) {
            throw new Error(`Insert failed: ${insertResult.error}`);
        }

        // 3. Delete from the old table
        const deleteQuery = `DELETE FROM ${currentTable} WHERE Serial_MF_Part = ?`;
        
        // Use .run() for DELETE
        await db.prepare(deleteQuery).bind(serial).run();

        await db.exec("COMMIT");
        return { success: true };
    } catch (error) {
        await db.exec("ROLLBACK");
        console.error("Error moving row:", error);
        throw error;
    }
}


// --- Main Worker Export ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Handle preflight ---
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    // --- NEW: POST /api/game/find ---
    if (request.method === "POST" && path === "/api/game/find") {
        try {
            const { serial } = await request.json();
            if (!serial) {
                return new Response(JSON.stringify({ success: false, error: "Missing serial number" }), 
                    { headers: corsHeaders(), status: 400 });
            }

            const { table, row } = await findGameBySerial(serial, env.araa_testing);
            
            return new Response(JSON.stringify({ success: true, table, row }), 
                { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        } catch (err) {
            console.error(err);
            return new Response(JSON.stringify({ success: false, error: err.message }), 
                { headers: corsHeaders(), status: 500 });
        }
    }

    // --- NEW: POST /api/game/inventory/create ---
    if (request.method === "POST" && path === "/api/game/inventory/create") {
        try {
            const newGame = await request.json();
            const columns = ALL_COLUMNS.filter(col => col !== 'Box_Number');
            const placeholders = columns.map(() => '?').join(", ");

            const values = columns.map(col => newGame[col]);

            // Serial_MF_Part (1st column) to Status (16th column)
            const insertQuery = `INSERT INTO ${INVENTORY_TABLE} (${columns.join(", ")}, Box_Number) VALUES (${placeholders}, NULL)`;
            await env.araa_testing.prepare(insertQuery).bind(...values).run();

            return new Response(JSON.stringify({ success: true, message: "Game added to Inventory" }), 
                { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        } catch (err) {
            console.error(err);
            return new Response(JSON.stringify({ success: false, error: err.message }), 
                { headers: corsHeaders(), status: 500 });
        }
    }
    
    // --- NEW: POST /api/game/status/update ---
    if (request.method === "POST" && path === "/api/game/status/update") {
        try {
            const { serial, oldTable, newStatus, boxNumber } = await request.json();
            // ... validation checks ...

            // ... newTable assignment ...

            // 1. Get current row data (SELECT *)
            const selectQuery = `SELECT * FROM ${oldTable} WHERE Serial_MF_Part = ?`;
            const { results } = await env.araa_testing.prepare(selectQuery).bind(serial).all();
            
            // ... check for results.length ...
            const row = results[0]; // This is the full, old row data

            // 2. UPDATE Status and Box_Number on the row object
            row.Status = newStatus; // Crucial: Update the Status column
            
            if (newTable === OPEN_TABLE) {
                // boxNumber is passed from the front-end input
                row.Box_Number = parseInt(boxNumber); 
            } else {
                row.Box_Number = null;
            }

            // 3. Move the row (pass the now updated 'row' object)
            await moveRow(serial, oldTable, newTable, row, env.araa_testing);

            return new Response(JSON.stringify({ success: true, newTable }), 
                { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        } catch (err) {
            // ... error handling ...
        }
    }

    // --- NEW: GET /api/open/games ---
    if (request.method === "GET" && path === "/api/open/games") {
        try {
            const cols = POPUP_COLUMNS.join(", ");
            const query = `SELECT ${cols}, Box_Number FROM ${OPEN_TABLE} WHERE Box_Number IS NOT NULL AND Box_Number >= 1 AND Box_Number <= 7`;
            const { results } = await env.araa_testing.prepare(query).all();

            return new Response(JSON.stringify({ success: true, games: results }), 
                { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        } catch (err) {
            console.error(err);
            return new Response(JSON.stringify({ success: false, error: err.message }), 
                { headers: corsHeaders(), status: 500 });
        }
    }

    // --- NEW: POST /api/game/sell ---
    if (request.method === "POST" && path === "/api/game/sell") {
        try {
            const { boxNumber, moneyInserted, ticketsSold } = await request.json();
            if (!boxNumber || isNaN(moneyInserted) || isNaN(ticketsSold)) {
                return new Response(JSON.stringify({ success: false, error: "Missing or invalid selling data" }), 
                    { headers: corsHeaders(), status: 400 });
            }

            // 1. Get current game data and Ticket_Price
            const selectQuery = `SELECT Cash_Hand, Tickets_Sold, Numer_Tickets FROM ${OPEN_TABLE} WHERE Box_Number = ?`;
            const { results } = await env.araa_testing.prepare(selectQuery).bind(boxNumber).all();

            if (results.length === 0) {
                return new Response(JSON.stringify({ success: false, error: `Game not found in box ${boxNumber}` }), 
                    { headers: corsHeaders(), status: 404 });
            }
            const game = results[0];

            // 2. Calculate new values
            const newTicketsSold = game.Tickets_Sold + ticketsSold;
            const newCurrentTickets = game.Numer_Tickets - newTicketsSold;
            const newCashHand = game.Cash_Hand + moneyInserted;

            // 3. Update the database
            const updateQuery = `
                UPDATE ${OPEN_TABLE} SET 
                Tickets_Sold = ?, 
                Current_Tickets = ?, 
                Cash_Hand = ? 
                WHERE Box_Number = ?`;
            await env.araa_testing.prepare(updateQuery)
                .bind(newTicketsSold, newCurrentTickets, newCashHand, boxNumber)
                .run();

            return new Response(JSON.stringify({ success: true, newTicketsSold, newCurrentTickets, newCashHand }), 
                { headers: { ...corsHeaders(), "Content-Type": "application/json" } });

        } catch (err) {
            console.error(err);
            return new Response(JSON.stringify({ success: false, error: err.message }), 
                { headers: corsHeaders(), status: 500 });
        }
    }
    
    // --- NEW: POST /api/game/winner ---
    if (request.method === "POST" && path === "/api/game/winner") {
        try {
            const { boxNumber, winnersPaid } = await request.json();
            if (!boxNumber || isNaN(winnersPaid)) {
                return new Response(JSON.stringify({ success: false, error: "Missing or invalid winner data" }), 
                    { headers: corsHeaders(), status: 400 });
            }

            // 1. Get current game data
            const selectQuery = `SELECT Winners_Sold, Number_Winners FROM ${OPEN_TABLE} WHERE Box_Number = ?`;
            const { results } = await env.araa_testing.prepare(selectQuery).bind(boxNumber).all();

            if (results.length === 0) {
                return new Response(JSON.stringify({ success: false, error: `Game not found in box ${boxNumber}` }), 
                    { headers: corsHeaders(), status: 404 });
            }
            const game = results[0];

            // 2. Calculate new values
            const newWinnersSold = game.Winners_Sold + winnersPaid;
            const newCurrentWinners = game.Number_Winners - newWinnersSold;

            // 3. Update the database
            const updateQuery = `
                UPDATE ${OPEN_TABLE} SET 
                Winners_Sold = ?, 
                Current_Winners = ? 
                WHERE Box_Number = ?`;
            await env.araa_testing.prepare(updateQuery)
                .bind(newWinnersSold, newCurrentWinners, boxNumber)
                .run();

            return new Response(JSON.stringify({ success: true, newWinnersSold, newCurrentWinners }), 
                { headers: { ...corsHeaders(), "Content-Type": "application/json" } });

        } catch (err) {
            console.error(err);
            return new Response(JSON.stringify({ success: false, error: err.message }), 
                { headers: corsHeaders(), status: 500 });
        }
    }


    // --- Existing signin, logs, heartbeat, logout routes (keep them as they are) ---
    if (request.method === "POST" && path === "/signin") { /* ... existing code ... */ }
    if (request.method === "GET" && path === "/logs") { /* ... existing code ... */ }
    if (request.method === "POST" && path === "/api/heartbeat") { /* ... existing code ... */ }
    if (request.method === "POST" && path === "/auth/logout") { /* ... existing code ... */ }

    // --- Existing routes that you need to keep based on your original worker ---

    // Note: The existing signin, logs, heartbeat, and logout logic remains, 
    // but I did not paste it here for brevity. Ensure you keep those parts 
    // in your final worker.js file.

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};