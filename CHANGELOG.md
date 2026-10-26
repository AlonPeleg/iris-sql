# Change Log

## [0.4.0]

- New: **right-click a cell** in the results: filter by its value (`=`, `≠`, `>` / `<`, for dates *on that day* / *after* / *before*, *contains...*, *is empty* / *is not empty*), or **Filter column...** for any operator (also *between*, *starts with*, *does not contain*). The query runs again with the condition added.
- New: **conditions show as chips** under the query. Click a chip to edit it, its dot to turn it off without deleting it, ✕ to remove it. Conditions are joined with AND; a query that already has a `WHERE` keeps it (in parentheses) and the chips are added after it; removing the last chip removes the `WHERE` they added. Editing the SQL text yourself and running it makes it the new starting point (the chips fold into it).
- New: **Sort by column ↑ / ↓** (on the server, so on all rows, not only the loaded ones) and **Count by column** (how many rows have each value; right-click a value > *Show these rows*). Both show as chips too.
- New: **Back / Forward** (← → or Alt+Left / Alt+Right) through the queries of the results tab (last 50).
- New: **Columns**: show / hide columns, drag a column title to move it. Copy / Save CSV / Open as JSON take the columns shown, in that order.
- New: **here only** filters (*Keep only rows like this*, *Hide rows like this*): narrow the rows already loaded without running anything (dashed chips).
- New: **Copy value**, **Copy condition** (as SQL, e.g. `"Created" = {d '2026-05-31'}`), **Copy column name**.
- Change: the results page script and styles moved to `media/results.js` and `media/results.css`.

## [0.3.3]

- New: **the query in the results tab is editable.** Change it (add a `WHERE`, an `ORDER BY`...) and press **Run** or **Ctrl+Enter**: it runs on the same namespace and user. **Open in Editor** continues it in a `.sql` editor.
- New: right-click a table > **Select Last 100 Rows** (`TOP 100 ... ORDER BY %ID DESC`, newest first) and **Select Top / Bottom...** (first or last rows, as many as you type). Views, which have no row id, offer only Select Rows.

## [0.3.2]

- Change: clicking a table now reads every row (`SELECT *`) instead of the first 100. Setting `irisSql.topRows` (now 0 = all) still limits it when set to a number. New Query templates start with `SELECT *` too.
- Change: the results grid is a box that fills the tab and scrolls on its own: the column titles stay at the top, the # column stays on the left, and the horizontal scrollbar is always at the bottom of the window (no need to scroll down to reach it).

## [0.3.1]

- New: **Choose Namespace...** (first button in the title bar): pick the namespace, then the user - its assigned user, one you signed in with there before, or another one. The tree shows only that namespace; nothing else is read or logged in to.
- New: switching namespace or user ends the previous login's session on the server, instead of leaving it to time out (it could hold a license until then).
- Change: the filter applies to the namespace shown; the title shows the namespace, the user and the filter.

## [0.3.0]

- New: **Filter** in the sidebar's title bar: only the tables, views and procedures whose name, schema or class matches what you type (live, `*` / `?` wildcards), with their groups opened and the match highlighted. Counts show next to the groups while filtering. The filled funnel clears it.
- New: sidebar icon in the same style as the other InterSystems tools (the IRIS logo with a database).

## [0.2.0]

- New: **Sign in as Another User...** (right-click a namespace): browse and query that namespace with another user, for example one that sees every table. The row shows `as <user>`; **Use Default Login** goes back.
- New: when the server rejects a password (it changed), you are asked for the current one and the tables / query run again with it, instead of an error.
- New icon: "SQL" in the box instead of the terminal prompt.

## [0.1.0]

- First test build: namespace tree (tables, views, procedures), queries with Ctrl+Enter, results grid with sort / filter / copy / CSV.
