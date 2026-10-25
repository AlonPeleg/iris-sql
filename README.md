# IRIS SQL Workbench

Browse the SQL side of an InterSystems IRIS / Caché namespace and run queries, using the connection your
InterSystems namespace folders already have. Nothing extra to configure.

## The sidebar

The **IRIS SQL** icon in the Activity Bar lists every namespace open in your workspace (isfs server folders,
or local folders with `objectscript.conn`):

- **Tables**, **Views** and **Procedures**, grouped by SQL schema. System schemas (`%...`, `INFORMATION_SCHEMA`,
  `Ens...`, `HS_...`) are hidden; setting `irisSql.showSystemSchemas` shows them.
- **Filter** (the funnel in the title bar): type part of a table, schema or class name - the tree narrows as you
  type, opens the groups with matches and highlights the match. `*` and `?` work as wildcards (`pledge*agree`).
  The filter shows next to the title; the filled funnel clears it.
- Click a table to read its first 100 rows (`irisSql.topRows`). Right-click a table for **Count Rows**,
  **Show Columns**, **New Query on This Table**, **Open Class** and **Copy SQL Name**.
- Click a procedure to open a `CALL` with its parameters ready to fill in.

## Queries

- **New Query** (the sidebar's title bar, or a namespace row) opens a `.sql` editor whose first line,
  `-- iris: server : NS`, says where it runs. Saved `.sql` files keep that line, so they open on the same namespace.
- **Ctrl+Enter** runs the selection, or the statement under the cursor (statements are separated by a blank line
  or a `;` at the end of a line).
- The status bar shows the namespace of the current `.sql` editor; click it to change.
- Statements other than SELECT / WITH / CALL ask before running (`irisSql.confirmWrites`).

## Results

One results tab next to the editor: click a column header to sort, type to filter, double-click a cell (or select
it and press Ctrl+C) to copy its value. **Copy for Excel**, **Copy CSV**, **Save CSV...** (UTF-8 with BOM, so
Excel shows Hebrew correctly) and **Open as JSON** take every row, in the current sort and filter. At most 2,000
rows are drawn (`irisSql.maxRowsShown`).

## Login

By default a namespace uses the user of your InterSystems connection. Its password comes from the InterSystems
ObjectScript extension (settings.json), else Server Manager's saved login (if this extension is allowed to use it),
else it is asked once and kept in memory until VS Code closes.

**Another user.** The tables you see are the ones the logged-in user may see. To browse and query with a user that
sees more, right-click the namespace > **Sign in as Another User...** and type its username and password. The row
then shows `as <user>`, and the tables, queries and results of that namespace use it (the status bar and the results
say so too). The username is remembered; the password is only kept in memory until VS Code closes.
**Use Default Login** (same menu) goes back to the connection's own user.

**Passwords that change.** When the server rejects a password (for example one that changes every few hours), you
are asked for the current one right away, and what you were doing (reading the tables, running the query) runs again
with it. Cancel, and the next query asks again.

## Notes for this test build

- The whole result comes back from the server at once: use `TOP` on large tables.
- Catalog queries try `INFORMATION_SCHEMA` first and fall back to `%Dictionary` for older Caché.
- See **View > Output > IRIS SQL** for what ran and why something failed.
