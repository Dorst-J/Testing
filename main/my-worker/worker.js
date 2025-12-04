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
  "Status", "Box_Number",
  "Date_Opened", "Date_Closed"
];

// Columns to show in the Main Page pop-up (Ticket_Price added for Sell page logic)
const POPUP_COLUMNS = [
    "Serial_MF_Part", "Game_Name", "Cash_Hand", "Current_Tickets", "Current_Winners", "Ticket_Price", "Box_Number", "Date_Opened"
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
                
                const columns = ALL_COLUMNS.filter(
                    col => !["Box_Number", "Date_Opened", "Date_Closed"].includes(col)
                );
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
                
                // --- 2. Sanitize and Update Row Data ---
                const NUMERICAL_COLUMNS = [
                    "Ticket_Price", "Number_Tickets", "Tickets_Sold", "Current_Tickets", 
                    "Number_Winners", "Winners_Sold", "Current_Winners", "Cash_Hand", 
                    "Ideal_Gross", "Ideal_Prize", "Ideal_Net", "Game_Cost"
                ];

                row.Status = newStatus;

                // Set Box_Number (Required for Open, Null otherwise)
                if (newTable === OPEN_TABLE) {
                    if (
                        !boxNumber ||
                        isNaN(parseInt(boxNumber)) ||
                        parseInt(boxNumber) < 1 ||
                        parseInt(boxNumber) > 7
                    ) {
                        throw new Error("Missing or invalid Box Number for Open status");
                    }
                    row["Box_Number"] = parseInt(boxNumber);
                } else {
                    row["Box_Number"] = null;
                }

                // --- NEW: set Date_Opened / Date_Closed ---
                const nowIso = new Date().toISOString();

                // If moving to Open and there's no Date_Opened yet, set it
                if (newStatus === "Open" && !row.Date_Opened) {
                    row.Date_Opened = nowIso;
                }

                // If moving to Closed, always set Date_Closed (and keep existing Date_Opened)
                if (newStatus === "Closed") {
                    if (!row.Date_Opened) {
                        // Optional: backfill open date here if you want
                        // row.Date_Opened = nowIso;
                    }
                    row.Date_Closed = nowIso;
                }

                NUMERICAL_COLUMNS.forEach(col => {
                    const value = row[col];
                    if (value !== null && value !== undefined) {
                        const parsedValue = parseFloat(value);
                        if (isNaN(parsedValue)) {
                            row[col] = null; 
                        } else {
                            if (
                                [
                                  "Number_Tickets",
                                  "Tickets_Sold",
                                  "Current_Tickets",
                                  "Number_Winners",
                                  "Winners_Sold",
                                  "Current_Winners",
                                ].includes(col)
                            ) {
                                row[col] = parseInt(parsedValue);
                            } else {
                                row[col] = parsedValue;
                            }
                        }
                    }
                });

                const finalValues = [
                  row.Serial_MF_Part, row.Game_Name, row.Ticket_Price, row.Number_Tickets,
                  row.Tickets_Sold, row.Current_Tickets, row.Number_Winners, row.Winners_Sold,
                  row.Current_Winners, row.P_NP, row.Cash_Hand, row.Ideal_Gross,
                  row.Ideal_Prize, row.Ideal_Net, row.Game_Cost,
                  row.Status, row.Box_Number,
                  row.Date_Opened ?? null, row.Date_Closed ?? null
                ];

                await moveRow(serial, oldTable, newTable, finalValues, env.araa_testing);

                return new Response(JSON.stringify({ success: true, newTable }), 
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
            } catch (err) {
                const safeLoggedError = String(err);
                console.error("Status Update Route Error (Safely Logged):", safeLoggedError); 
                
                let errorMessage;
                if (safeLoggedError.includes("D1 Transaction Failed")) {
                    errorMessage = safeLoggedError.replace('Error: D1 Transaction Failed: Error: ', 'Database Transaction Failed: ');
                    errorMessage = errorMessage.replace('D1 Transaction Failed: Error: ', 'Database Transaction Failed: ');
                } else {
                    errorMessage = safeLoggedError;
                }

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

        // --- GET /api/open/games (Return all open games) ---
        if (request.method === "GET" && path === "/api/open/games") {
            try {
                const query = `
                    SELECT ${POPUP_COLUMNS.join(", ")} 
                    FROM ${OPEN_TABLE}
                    ORDER BY Box_Number ASC
                `;
                const { results } = await env.araa_testing.prepare(query).all();

                return new Response(
                    JSON.stringify({ success: true, games: results }),
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
                );
            } catch (err) {
                console.error("Error fetching open games:", err);
                return new Response(
                    JSON.stringify({ success: false, error: err.message }),
                    { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
                );
            }
        }

        // --- POST /api/game/sell (Sell tickets from an open game) ---
        if (request.method === "POST" && path === "/api/game/sell") {
          try {
            const payload = await request.json();
            let { serial, boxNumber, soldTickets, ticketsSold, moneyInserted } = payload;

            // Allow either soldTickets or ticketsSold from the client
            if (soldTickets == null && ticketsSold != null) {
              soldTickets = ticketsSold;
            }

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

            // 💰 IMPORTANT: only credit Cash_Hand with tickets * price (NOT the extra change)
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

        // --- POST /api/game/winner (Record paid winning tickets and subtract payout) ---
        if (request.method === "POST" && path === "/api/game/winner") {
          try {
            const payload = await request.json();
            let { serial, boxNumber, winnersPaid, payoutCash } = payload;

            if (typeof boxNumber === "string") boxNumber = parseInt(boxNumber, 10);
            if (typeof winnersPaid === "string") winnersPaid = parseInt(winnersPaid, 10);
            if (typeof payoutCash === "string") payoutCash = parseFloat(payoutCash);

            let selectQuery, bindVal;
            if (serial) {
              selectQuery = `SELECT * FROM ${OPEN_TABLE} WHERE Serial_MF_Part = ?`;
              bindVal = serial;
            } else if (boxNumber) {
              selectQuery = `SELECT * FROM ${OPEN_TABLE} WHERE Box_Number = ?`;
              bindVal = boxNumber;
            } else {
              return new Response(JSON.stringify({ success: false, error: "Missing serial or boxNumber" }),
                { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 });
            }

            const { results } = await env.araa_testing.prepare(selectQuery).bind(bindVal).all();
            if (results.length === 0) {
              return new Response(JSON.stringify({ success: false, error: "Game not found in Open table" }),
                { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 404 });
            }
            const game = results[0];

            winnersPaid = Number(winnersPaid ?? 0);
            payoutCash  = Number(payoutCash ?? 0);
            if (!Number.isFinite(winnersPaid) || winnersPaid < 0) {
              return new Response(JSON.stringify({ success: false, error: "winnersPaid must be a non-negative integer" }),
                { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 });
            }
            if (!Number.isFinite(payoutCash) || payoutCash < 0) {
              return new Response(JSON.stringify({ success: false, error: "payoutCash must be a non-negative number" }),
                { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 400 });
            }

            const winnersSoldSoFar = Number(game.Winners_Sold || 0);
            const currentWinners   = Number(game.Current_Winners || 0);
            const cashHandSoFar    = Number(game.Cash_Hand || 0);

            const newWinnersSold    = winnersSoldSoFar + winnersPaid;
            const newCurrentWinners = Math.max(0, currentWinners - winnersPaid);
            const newCashHand       = cashHandSoFar - payoutCash;

            await env.araa_testing
              .prepare(`UPDATE ${OPEN_TABLE} SET Winners_Sold = ?, Current_Winners = ?, Cash_Hand = ? WHERE Serial_MF_Part = ?`)
              .bind(newWinnersSold, newCurrentWinners, newCashHand, game.Serial_MF_Part)
              .run();

            return new Response(JSON.stringify({
              success: true,
              message: `Recorded ${winnersPaid} winning ticket(s).`,
              serial: game.Serial_MF_Part,
              boxNumber: game.Box_Number ?? null,
              payoutCash,
              newWinnersSold,
              newCurrentWinners,
              newCashHand
            }), { headers: { ...corsHeaders(), "Content-Type": "application/json" } });

          } catch (err) {
            console.error("Winner route error:", err);
            return new Response(JSON.stringify({ success: false, error: err.message }),
              { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 });
          }
        }

        // --- GET /api/games/inventory (full live inventory table) ---
        if (request.method === "GET" && path === "/api/games/inventory") {
          try {
            const query = `
              SELECT ${ ALL_COLUMNS.join(", ") }
              FROM ${INVENTORY_TABLE}
              ORDER BY Serial_MF_Part ASC
            `;
            const { results } = await env.araa_testing.prepare(query).all();

            return new Response(
              JSON.stringify({ success: true, rows: results }),
              { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
            );
          } catch (err) {
            console.error("Error fetching inventory games:", err);
            return new Response(
              JSON.stringify({ success: false, error: err.message }),
              { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
            );
          }
        }

        // --- GET /api/games/open (full live open table) ---
        if (request.method === "GET" && path === "/api/games/open") {
          try {
            const query = `
              SELECT ${ ALL_COLUMNS.join(", ") }
              FROM ${OPEN_TABLE}
              ORDER BY Box_Number ASC, Serial_MF_Part ASC
            `;
            const { results } = await env.araa_testing.prepare(query).all();

            return new Response(
              JSON.stringify({ success: true, rows: results }),
              { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
            );
          } catch (err) {
            console.error("Error fetching open games (full):", err);
            return new Response(
              JSON.stringify({ success: false, error: err.message }),
              { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
            );
          }
        }

        // --- GET /api/games/closed (full live closed table) ---
        if (request.method === "GET" && path === "/api/games/closed") {
          try {
            const query = `
              SELECT ${ ALL_COLUMNS.join(", ") }
              FROM ${CLOSED_TABLE}
              ORDER BY Serial_MF_Part ASC
            `;
            const { results } = await env.araa_testing.prepare(query).all();

            return new Response(
              JSON.stringify({ success: true, rows: results }),
              { headers: { ...corsHeaders(), "Content-Type": "application/json" } }
            );
          } catch (err) {
            console.error("Error fetching closed games:", err);
            return new Response(
              JSON.stringify({ success: false, error: err.message }),
              { headers: { ...corsHeaders(), "Content-Type": "application/json" }, status: 500 }
            );
          }
        }

        // --- GET /logs (return all sign-in logs from KV) ---
        if (request.method === "GET" && path === "/logs") {
          try {
            // list up to 1000 log entries from KV
            const list = await env.SIGNIN_LOGS.list({ limit: 1000 });

            const logs = [];
            for (const key of list.keys) {
              const value = await env.SIGNIN_LOGS.get(key.name, "json");
              if (value) logs.push(value);
            }

            // newest first, assuming each has a numeric timestamp
            logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            return new Response(JSON.stringify(logs), {
              status: 200,
              headers: {
                ...corsHeaders(),
                "Content-Type": "application/json"
              }
            });
          } catch (err) {
            console.error("Error loading sign-in logs:", err);
            return new Response(
              JSON.stringify({ error: "Failed to load logs" }),
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

        // --- Default 404 ---
        return new Response("Not found", { status: 404, headers: corsHeaders() });
    },
};
