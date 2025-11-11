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
    "Serial_MF_Part", "Game_Name", "Cash_Hand", "Current_Tickets", "Current_Winners", "Ticket_Price", "Box_Number"
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
    // Correct return for "not found"
    return { table: null, row: null };
}

/**
 * Moves a row from its current table to a new table using a D1 transaction.
 * Expects the 'values' array to be pre-built and perfectly ordered.
 */
async function moveRow(serial, currentTable, newTable, values, db) {
    const cols = ALL_COLUMNS.join(", "); 
    const placeholders = ALL_COLUMNS.map(() => '?').join(", ");
    
    try {
        const insertQuery = `INSERT INTO ${newTable} (${cols}) VALUES (${placeholders})`;
        await db.prepare(insertQuery).bind(...values).run();

        const deleteQuery = `DELETE FROM ${currentTable} WHERE Serial_MF_Part = ?`;
        await db.prepare(deleteQuery).bind(serial).run();

        return { success: true };
    } catch (error) {
        console.error("D1 MoveRow Error:", error);
        throw new Error(`MoveRow failed: ${String(error)}`);
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

                return new Response(JSON.stringify({ success: true, message: "Game added to Inventory" }), 
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
                    
            } catch (err) { 
                console.error("Inventory Create Error:", err);
                return new Response(
                    JSON.stringify({ success: false, error: err.message || "Unknown error during inventory creation." }),
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
                );
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
                const NUMERICAL_COLUMNS = [
                    "Ticket_Price", "Number_Tickets", "Tickets_Sold", "Current_Tickets", 
                    "Number_Winners", "Winners_Sold", "Current_Winners", "Cash_Hand", 
                    "Ideal_Gross", "Ideal_Prize", "Ideal_Net", "Game_Cost"
                ];

                row.Status = newStatus;

                // Set Box_Number (Required for Open, Null otherwise)
                if (newTable === OPEN_TABLE) {
                    if (!boxNumber || isNaN(parseInt(boxNumber)) || parseInt(boxNumber) < 1 || parseInt(boxNumber) > 7) {
                        throw new Error("Missing or invalid Box Number for Open status");
                    }
                    row['Box_Number'] = parseInt(boxNumber);
                } else {
                    row['Box_Number'] = null;
                }
                
                // Apply sanitation to the row object
                NUMERICAL_COLUMNS.forEach(col => {
                    const value = row[col];
                    if (value !== null && value !== undefined) {
                        const parsedValue = parseFloat(value);
                        
                        if (isNaN(parsedValue)) {
                            row[col] = null; 
                        } else {
                            if (["Number_Tickets", "Tickets_Sold", "Current_Tickets", "Number_Winners", "Winners_Sold", "Current_Winners"].includes(col)) {
                                row[col] = parseInt(parsedValue);
                            } else {
                                row[col] = parsedValue;
                            }
                        }
                    }
                });
                // --- END Sanitize and Update Row Data ---

                // CRITICAL FIX: Construct final array explicitly
                const finalValues = [
                    row.Serial_MF_Part, row.Game_Name, row.Ticket_Price, row.Number_Tickets,
                    row.Tickets_Sold, row.Current_Tickets, row.Number_Winners, row.Winners_Sold,
                    row.Current_Winners, row.P_NP, row.Cash_Hand, row.Ideal_Gross,
                    row.Ideal_Prize, row.Ideal_Net, row.Game_Cost,
                    row.Status, row.Box_Number 
                ];

                // 3. Move the row using the clean, updated 'finalValues' array
                await moveRow(serial, oldTable, newTable, finalValues, env.araa_testing);

                return new Response(JSON.stringify({ success: true, newTable }), 
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
            } catch (err) {
                // **FIXED (The Ultimate Hardening of the main catch block):**
                // Safely log and extract the message thrown by moveRow.
                const safeLoggedError = String(err);
                
                // 2. Log the safe error
                console.error("Status Update Route Error (Safely Logged):", safeLoggedError); 
                
                // 3. Prepare the message for the client
                let errorMessage;
                
                // Clean up the error message for client readability
                if (safeLoggedError.includes("D1 Transaction Failed")) {
                    // Message from moveRow: "Error: D1 Transaction Failed: Error: SQLITE_CONSTRAINT_..."
                    errorMessage = safeLoggedError.replace('Error: D1 Transaction Failed: Error: ', 'Database Transaction Failed: ');
                    // Clean up generic D1 message structure if still present
                    errorMessage = errorMessage.replace('D1 Transaction Failed: Error: ', 'Database Transaction Failed: ');
                } else {
                    // Fallback for other errors (e.g., missing box number)
                    errorMessage = safeLoggedError;
                }

                // 4. Return the Response with the safe message and correct structure
                return new Response(
                    JSON.stringify({ 
                        success: false, 
                        error: errorMessage
                    }),
                    { 
                        status: 500, 
                        headers: { 
                            ...corsHeaders(), 
                            "Content-Type": "application/json" 
                        } 
                    }
                );
            }
        }
        // ... rest of the worker code (sell, winner, default fallback)
       // --- POST /api/game/sell (Sell tickets from an open game) ---
if (request.method === "POST" && path === "/api/game/sell") {
  try {
    const payload = await request.json();
    let { serial, boxNumber, soldTickets, moneyInserted } = payload;

    // Normalize numbers from strings
    if (typeof boxNumber === "string") boxNumber = parseInt(boxNumber, 10);
    if (typeof soldTickets === "string") soldTickets = parseInt(soldTickets, 10);
    if (typeof moneyInserted === "string") moneyInserted = parseFloat(moneyInserted);

    // Identify the game by serial OR by boxNumber
    let selectQuery, bindVal;
    if (serial) {
      selectQuery = `SELECT * FROM ${OPEN_TABLE} WHERE Serial_MF_Part = ?`;
      bindVal = serial;
    } else if (boxNumber) {
      selectQuery = `SELECT * FROM ${OPEN_TABLE} WHERE Box_Number = ?`;
      bindVal = boxNumber;
    } else {
      return new Response(
        JSON.stringify({ success: false, error: "Missing serial or boxNumber" }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 }
      );
    }

    const { results } = await env.araa_testing.prepare(selectQuery).bind(bindVal).all();
    if (results.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Game not found in Open table" }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 404 }
      );
    }
    const game = results[0];

    // Coerce numeric columns we need
    const ticketPrice = Number(game.Ticket_Price || 0);
    const currentTickets = Number(game.Current_Tickets || 0);
    const ticketsSoldSoFar = Number(game.Tickets_Sold || 0);
    const cashHandSoFar = Number(game.Cash_Hand || 0);

    // Determine soldTickets: prefer explicit, else derive from moneyInserted
    if (soldTickets == null) {
      if (moneyInserted == null || !isFinite(ticketPrice) || ticketPrice <= 0) {
        return new Response(
          JSON.stringify({ success: false, error: "Missing soldTickets and unable to derive from moneyInserted/Ticket_Price" }),
          { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 }
        );
      }
      soldTickets = Math.floor(Number(moneyInserted) / ticketPrice);
    }

    // Guard rails
    soldTickets = Number(soldTickets);
    if (!Number.isFinite(soldTickets) || soldTickets <= 0) {
      return new Response(
        JSON.stringify({ success: false, error: "soldTickets must be a positive integer" }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 }
      );
    }
    if (soldTickets > currentTickets) {
      return new Response(
        JSON.stringify({ success: false, error: `Not enough tickets left. Requested ${soldTickets}, only ${currentTickets} remaining.` }),
        { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 }
      );
    }

    // Compute new values
    const newTicketsSold = ticketsSoldSoFar + soldTickets;
    const newCurrentTickets = currentTickets - soldTickets;
    const saleCash = soldTickets * ticketPrice;
    const newCashHand = cashHandSoFar + saleCash;

    // Update row
    const updateQuery = `
      UPDATE ${OPEN_TABLE}
      SET Tickets_Sold = ?, Current_Tickets = ?, Cash_Hand = ?
      WHERE Serial_MF_Part = ?
    `;
    await env.araa_testing
      .prepare(updateQuery)
      .bind(newTicketsSold, newCurrentTickets, newCashHand, game.Serial_MF_Part)
      .run();

    return new Response(
      JSON.stringify({
        success: true,
        message: `Sold ${soldTickets} tickets.`,
        serial: game.Serial_MF_Part,
        boxNumber: game.Box_Number ?? null,
        ticketPrice,
        saleCash,
        newTicketsSold,
        newCurrentTickets,
        newCashHand
      }),
      { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Sell route error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
    );
  }
}


        return new Response("Not found", { status: 404, headers: corsHeaders() });
    },
};
