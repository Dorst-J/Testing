// --- Worker Utility Functions ---
function corsHeaders() {
    // CRITICAL: Ensure this Origin matches your website's domain
    return {
        "Access-Control-Allow-Origin": "https://thedatatab.com", 
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
    "Serial_MF_Part", "Game_Name", "Cash_Hand", "Current_Tickets", "Current_Winners", "Ticket_Price" // Added Ticket_Price for Selling Page
];

/**
 * Searches all tables for a Serial_MF_Part.
 */
async function findGameBySerial(serial, db) {
    for (const tableName of [OPEN_TABLE, INVENTORY_TABLE, CLOSED_TABLE]) {
        const query = `SELECT * FROM ${tableName} WHERE Serial_MF_Part = ?`;
        const { results } = await db.prepare(query).bind(serial).all();
        if (results.length > 0) {
            return { table: tableName, row: results[0] };
        }
    }
    return { table: null, row: null };
}

/**
 * Moves a row from its current table to a new table using a D1 transaction.
 */
async function moveRow(serial, currentTable, newTable, data, db) {
    await db.exec("BEGIN");
    try {
        let row = data; 
        
        // 1. Construct INSERT query
        const cols = ALL_COLUMNS.join(", "); 
        const placeholders = ALL_COLUMNS.map(() => '?').join(", ");
        
        // 2. Map row data to the exact order of ALL_COLUMNS
        const values = ALL_COLUMNS.map(col => {
            // Check for property existence and correctly map undefined/null to SQL NULL
            return (row.hasOwnProperty(col) && row[col] !== null && row[col] !== undefined) ? row[col] : null;
        });

        const insertQuery = `INSERT INTO ${newTable} (${cols}) VALUES (${placeholders})`;
        await db.prepare(insertQuery).bind(...values).run();
        
        // 3. Delete from the old table
        const deleteQuery = `DELETE FROM ${currentTable} WHERE Serial_MF_Part = ?`;
        await db.prepare(deleteQuery).bind(serial).run();

        await db.exec("COMMIT");
        return { success: true };
    } catch (error) {
        await db.exec("ROLLBACK");
        console.error("Error moving row:", error);
        throw error; // Rethrow to be caught by the route handler
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

        // --- POST /api/game/find (Lookup) ---
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

        // --- POST /api/game/inventory/create (New Game) ---
        if (request.method === "POST" && path === "/api/game/inventory/create") {
            try {
                const newGame = await request.json();
                const columns = ALL_COLUMNS.filter(col => col !== 'Box_Number');
                const placeholders = columns.map(() => '?').join(", ");

                const values = columns.map(col => newGame[col]);

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
        
        // --- POST /api/game/status/update (Status Change/Move) ---
        if (request.method === "POST" && path === "/api/game/status/update") {
            try {
                const { serial, oldTable, newStatus, boxNumber } = await request.json();
                if (!serial || !oldTable || !newStatus) {
                    return new Response(JSON.stringify({ success: false, error: "Missing required fields" }), 
                        { headers: corsHeaders(), status: 400 });
                }

                // ** THIS BLOCK DEFINES newTable AND WAS CAUSING THE ERROR **
                let newTable; 

                if (newStatus === "Inventory") newTable = INVENTORY_TABLE;
                else if (newStatus === "Open") newTable = OPEN_TABLE;
                else if (newStatus === "Closed") newTable = CLOSED_TABLE;
                else {
                    return new Response(JSON.stringify({ success: false, error: "Invalid status: " + newStatus }), 
                        { headers: corsHeaders(), status: 400 });
                }
                // *********************************************************
                
                // 1. Get current row data (SELECT *)
                const selectQuery = `SELECT * FROM ${oldTable} WHERE Serial_MF_Part = ?`;
                const { results } = await env.araa_testing.prepare(selectQuery).bind(serial).all();

                if (results.length === 0) {
                    return new Response(JSON.stringify({ success: false, error: `Game ${serial} not found in ${oldTable}` }), 
                        { headers: corsHeaders(), status: 404 });
                }
                const row = results[0];
                
                // 2. Update Status and Box_Number for the row object to be moved
                row.Status = newStatus;

                if (newTable === OPEN_TABLE) {
                    if (!boxNumber || isNaN(parseInt(boxNumber)) || parseInt(boxNumber) < 1 || parseInt(boxNumber) > 7) {
                        throw new Error("Missing or invalid Box Number for Open status");
                    }
                    row.Box_Number = parseInt(boxNumber);
                } else {
                    row.Box_Number = null;
                }

                // 3. Move the row
                await moveRow(serial, oldTable, newTable, row, env.araa_testing);

                return new Response(JSON.stringify({ success: true, newTable }), 
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
            } catch (err) {
                console.error("Status Update Route Error:", err);
                return new Response(
                    JSON.stringify({ success: false, error: err.message || "Unknown database error during status update" }),
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
                );
            }
        }

        // --- GET /api/open/games (Main Page Data) ---
        if (request.method === "GET" && path === "/api/open/games") {
            try {
                // Now includes Ticket_Price for the Selling page
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

        // --- POST /api/game/sell (Sales Update) ---
        if (request.method === "POST" && path === "/api/game/sell") {
            try {
                const { boxNumber, moneyInserted, ticketsSold } = await request.json();
                if (!boxNumber || isNaN(moneyInserted) || isNaN(ticketsSold)) {
                    return new Response(JSON.stringify({ success: false, error: "Missing or invalid selling data" }), 
                        { headers: corsHeaders(), status: 400 });
                }

                // 1. Get current game data
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
        
        // --- POST /api/game/winner (Winner Update) ---
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

        // --- Existing routes (assuming your original signin, logs, heartbeat, logout logic remains) ---
        // Note: Place your existing signin, logs, heartbeat, and logout routes here
        
        // --- Default Fallback ---
        return new Response("Not found", { status: 404, headers: corsHeaders() });
    },
};