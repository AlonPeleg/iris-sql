# IRIS SQL Workbench

Browse the SQL side of an InterSystems IRIS / Caché namespace and run queries, using the connection your
InterSystems namespace folders already have. Nothing extra to configure.

## The sidebar

The **IRIS SQL** icon in the Activity Bar shows one namespace at a time. **Choose Namespace...** (the first button in
its title bar) asks:

1. **which namespace** - every namespace open in your workspace (isfs server folders, or local folders with
   `objectscript.conn`), read again each time, so a folder you just added is listed;
2. **which user** - the namespace's assigned user (from your InterSystems connection), a user you signed in with there
   before, or **Sign in as another user...** (username and password).

The tree then shows that namespace's tables, and the title says which one and as whom (`USER as sqladmin`). Choosing
another namespace or user replaces it, and ends the previous login's session on the server (which would otherwise
hold a license until the server's timeout). The choice is remembered for the workspace.

- **Tables**, **Views** and **Procedures**, grouped by SQL schema. System schemas (`%...`, `INFORMATION_SCHEMA`,
  `Ens...`, `HS_...`) are hidden; setting `irisSql.showSystemSchemas` shows them.
- **Filter** (the funnel in the title bar): type part of a table, schema or class name - the tree narrows as you
  type, opens the groups with matches and highlights the match. `*` and `?` work as wildcards (`pledge*agree`).
  It filters the namespace shown (no other namespace is read). The filter shows in the title; the filled funnel
  clears it.
- Click a table to read its rows (`SELECT *`; set `irisSql.topRows` to a number to read only that many).
- Right-click a table:
  - **Select Rows** - every row, as a click does.
  - **Select Last 100 Rows** - the newest 100 (`SELECT TOP 100 * ... ORDER BY %ID DESC`, newest first).
  - **Select Top / Bottom...** - choose Top (first rows) or Bottom (last rows), then how many.
  - **Count Rows**, **Show Columns**, **New Query on This Table**, **Open Class**, **Copy SQL Name**.

  "Last" and "first" go by row id (`%ID`), the order rows were added in. Views have no row id, so they only offer
  Select Rows.
- Click a procedure to open a `CALL` with its parameters ready to fill in.

## Queries

- **New Query** (the sidebar's title bar, or a namespace row) opens a `.sql` editor whose first line,
  `-- iris: server : NS`, says where it runs. Saved `.sql` files keep that line, so they open on the same namespace.
- **Ctrl+Enter** runs the selection, or the statement under the cursor (statements are separated by a blank line
  or a `;` at the end of a line).
- The status bar shows the namespace of the current `.sql` editor; click it to change.
- Statements other than SELECT / WITH / CALL ask before running (`irisSql.confirmWrites`).

## Results

One results tab next to the editor. **The query at its top can be edited**: add a `WHERE`, change the columns, anything, then **Run** or **Ctrl+Enter** runs it on the same namespace and user (**Open in Editor** continues it in a `.sql` editor). The grid scrolls in its own box: the column titles stay at the top, the # column on the left, and the horizontal scrollbar is always at the bottom.

**Right-click a cell** to filter by its value, without writing SQL:

- `=` / `≠` the value, `>` / `<` for numbers, *on that day* / *after* / *before* for dates, *contains...* for text,
  *is empty* / *is not empty* for NULLs;
- **Filter column...** - any operator, including *between*, *starts with*, *does not contain*;
- **Sort ↑ / ↓** (runs on the server: all rows) and **Count by** the column (right-click a value in the counts >
  *Show these rows*);
- **Keep only / Hide rows like this (here only)** - narrows the rows already loaded, nothing runs;
- **Hide column**, **Copy value**, **Copy condition** (as SQL), **Copy column name**.

Right-click a **column title** for the same column actions.

Each condition, the sort and the count show as **chips** under the query: click a chip to edit it, its dot to turn
it off (and on again) without losing it, ✕ to remove it. Conditions are joined with AND. If the query already has a
`WHERE`, it stays (in parentheses) and the conditions are added after it; removing the last chip takes away only what
the chips added. A query that starts with `WITH` cannot take chips - edit the SQL instead. When you edit the SQL text
yourself and run it, that text becomes the new starting point (the chips fold into it).

**← →** (Alt+Left / Alt+Right) go back and forward through the queries of the tab (the last 50).

**Columns** shows / hides columns; drag a column title to move it. Clicking a column title sorts the loaded rows
(no query); the filter box searches the loaded rows. Double-click a cell (or select it and press Ctrl+C) to copy its
value. **Copy for Excel**, **Copy CSV**, **Save CSV...** (UTF-8 with BOM, so Excel shows Hebrew correctly) and
**Open as JSON** take every loaded row, in the current sort and filter, with the columns shown. At most 2,000 rows
are drawn (`irisSql.maxRowsShown`).

## Login

By default a namespace uses the user of your InterSystems connection. Its password comes from the InterSystems
ObjectScript extension (settings.json), else Server Manager's saved login (if this extension is allowed to use it),
else it is asked once and kept in memory until VS Code closes.

**Another user.** The tables you see are the ones the logged-in user may see. To browse and query with a user that
sees more, choose it in **Choose Namespace...** (step 2), or right-click the namespace > **Sign in as Another User...**. The row
then shows `as <user>`, and the tables, queries and results of that namespace use it (the status bar and the results
say so too). The username is remembered; the password is only kept in memory until VS Code closes.
**Use Default Login** (same menu) goes back to the connection's own user.

**Passwords that change.** When the server rejects a password (for example one that changes every few hours), you
are asked for the current one right away, and what you were doing (reading the tables, running the query) runs again
with it. Cancel, and the next query asks again.

## Notes for this test build

- The whole result comes back from the server at once: on very large tables use `TOP` (or set `irisSql.topRows`).
- Catalog queries try `INFORMATION_SCHEMA` first and fall back to `%Dictionary` for older Caché.
- See **View > Output > IRIS SQL** for what ran and why something failed.
