// --- Worker Utility Functions ---
function corsHeaders() {
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

// CRITICAL: Standardized Column Names (Number_Tickets, Game_Cost)
const ALL_COLUMNS = [
    "Serial_MF_Part", "Game_Name", "Ticket_Price", "Number_Tickets",
    "Tickets_Sold", "Current_Tickets", "Number_Winners", "Winners_Sold",
    "Current_Winners", "P_NP", "Cash_Hand", "Ideal_Gross",
    "Ideal_Prize", "Ideal_Net", "Game_Cost", 
    "Status", "Box_Number"
];

// Columns to show in the Main Page pop-up (Ticket_Price added for Sell page logic)
const POPUP_COLUMNS = [
    "Serial_MF_Part", "Game_Name", "Cash_Hand", "Current_Tickets", "Current_Winners", "Ticket_Price" 
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
        let row = data; // Assumes 'data' is the clean, final object

        const cols = ALL_COLUMNS.join(", "); 
        const placeholders = ALL_COLUMNS.map(() => '?').join(", ");
        
        // CRITICAL: We rely entirely on the row properties being correctly set by the route handler.
        const values = ALL_COLUMNS.map(col => {
            return (row.hasOwnProperty(col) && row[col] !== null && row[col] !== undefined) ? row[col] : null;
        });

        const insertQuery = `INSERT INTO ${newTable} (${cols}) VALUES (${placeholders})`;
        console.log("Attempting INSERT:", insertQuery, "with values:", values);
        await db.prepare(insertQuery).bind(...values).run();
        
        const deleteQuery = `DELETE FROM ${currentTable} WHERE Serial_MF_Part = ?`;
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
        
        // ** CRITICAL FIX: Ensure Serial_MF_Part is present **
        if (!newGame.Serial_MF_Part) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: "D1_TYPE_ERROR: Missing Serial_MF_Part in submission data." 
            }), { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 });
        }
        
        const columns = ALL_COLUMNS.filter(col => col !== 'Box_Number');
        const placeholders = columns.map(() => '?').join(", ");
        
        const values = columns.map(col => newGame[col]); 

        const insertQuery = `INSERT INTO ${INVENTORY_TABLE} (${columns.join(", ")}, Box_Number) VALUES (${placeholders}, NULL)`;
        await env.araa_testing.prepare(insertQuery).bind(...values).run();

        // Ensure SUCCESS RESPONSE has the Content-Type header
        return new Response(JSON.stringify({ success: true, message: "Game added to Inventory" }), 
            { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
            
    } catch (err) { // <--- The error is being caught here
        console.error("Inventory Create Error:", err);
        // ** CRITICAL FIX: Ensure this path correctly sets the Content-Type header on failure **
        return new Response(
            JSON.stringify({ success: false, error: err.message || "Unknown error during inventory creation." }),
            { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
        );
    }
}
        
        // Worker code starting at // --- POST /api/game/status/update (Status Change/Move) ---

if (request.method === "POST" && path === "/api/game/status/update") {
    try {
        const { serial, oldTable, newStatus, boxNumber } = await request.json();
        if (!serial || !oldTable || !newStatus) {
            return new Response(JSON.stringify({ success: false, error: "Missing required fields" }), 
                { headers: corsHeaders(), status: 400 });
        }

        let newTable; 
        if (newStatus === "Inventory") newTable = INVENTORY_TABLE;
        else if (newStatus === "Open") newTable = OPEN_TABLE;
        else if (newStatus === "Closed") newTable = CLOSED_TABLE;
        else {
            return new Response(JSON.stringify({ success: false, error: "Invalid status: " + newStatus }), 
                { headers: corsHeaders(), status: 400 });
        }
        
        // 1. Get current row data from the source table
        const selectQuery = `SELECT * FROM ${oldTable} WHERE Serial_MF_Part = ?`;
        const { results } = await env.araa_testing.prepare(selectQuery).bind(serial).all();

        if (results.length === 0) {
            return new Response(JSON.stringify({ success: false, error: `Game ${serial} not found in ${oldTable}` }), 
                { headers: corsHeaders(), status: 404 });
        }
        let row = results[0];
        
        // --- 2. Sanitize and Update Row Data (Final Attempt) ---
        row.Status = newStatus;

        // Set Box_Number
        if (newTable === OPEN_TABLE) {
            if (!boxNumber || isNaN(parseInt(boxNumber)) || parseInt(boxNumber) < 1 || parseInt(boxNumber) > 7) {
                throw new Error("Missing or invalid Box Number for Open status");
            }
            row.Box_Number = parseInt(boxNumber);
        } else {
            row['Box_Number'] = null;
        }
        
        // Explicitly cast ALL numerical values in the row object to their best types
        const NUMERICAL_COLUMNS = [
            "Ticket_Price", "Number_Tickets", "Tickets_Sold", "Current_Tickets", 
            "Number_Winners", "Winners_Sold", "Current_Winners", "Cash_Hand", 
            "Ideal_Gross", "Ideal_Prize", "Ideal_Net", "Game_Cost"
        ];

        NUMERICAL_COLUMNS.forEach(col => {
            const value = row[col];
            // Only try to parse if there's a value. NULL remains NULL.
            if (value !== null && value !== undefined) {
                const parsedValue = parseFloat(value);
                
                if (isNaN(parsedValue)) {
                    // This is the safety net: if it's junk data, setting it to NULL
                    // should trigger a clean D1 NOT NULL error, not the 'duration' crash.
                    row[col] = null; 
                } else {
                    // Cast to Integer if required, otherwise keep the float
                    if (["Number_Tickets", "Tickets_Sold", "Current_Tickets", "Number_Winners", "Winners_Sold", "Current_Winners"].includes(col)) {
                        row[col] = parseInt(parsedValue);
                    } else {
                        row[col] = parsedValue;
                    }
                }
            }
        });
        // --- END Sanitize and Update Row Data ---

        // 3. Move the row using the clean, updated 'row' object as the data source
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

                const selectQuery = `SELECT Cash_Hand, Tickets_Sold, Number_Tickets FROM ${OPEN_TABLE} WHERE Box_Number = ?`;
                const { results } = await env.araa_testing.prepare(selectQuery).bind(boxNumber).all();

                if (results.length === 0) {
                    return new Response(JSON.stringify({ success: false, error: `Game not found in box ${boxNumber}` }), 
                        { headers: corsHeaders(), status: 404 });
                }
                const game = results[0];
                
                // Ensure all math uses numbers, not strings from the DB
                const newTicketsSold = parseInt(game.Tickets_Sold) + parseInt(ticketsSold);
                const newCurrentTickets = parseInt(game.Number_Tickets) - newTicketsSold;
                const newCashHand = parseFloat(game.Cash_Hand) + parseFloat(moneyInserted);

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

                const selectQuery = `SELECT Winners_Sold, Number_Winners FROM ${OPEN_TABLE} WHERE Box_Number = ?`;
                const { results } = await env.araa_testing.prepare(selectQuery).bind(boxNumber).all();

                if (results.length === 0) {
                    return new Response(JSON.stringify({ success: false, error: `Game not found in box ${boxNumber}` }), 
                        { headers: corsHeaders(), status: 404 });
                }
                const game = results[0];

                const newWinnersSold = parseInt(game.Winners_Sold) + parseInt(winnersPaid);
                const newCurrentWinners = parseInt(game.Number_Winners) - newWinnersSold;

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
        
        // --- Default Fallback (Placeholder for signin/logout/etc.) ---
        return new Response("Not found", { status: 404, headers: corsHeaders() });
    },
};