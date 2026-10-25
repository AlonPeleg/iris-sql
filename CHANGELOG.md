# Change Log

## [0.3.0]

- New: **Filter** in the sidebar's title bar: only the tables, views and procedures whose name, schema or class matches what you type (live, `*` / `?` wildcards), with their groups opened and the match highlighted. Counts show next to the groups while filtering. The filled funnel clears it.
- New: sidebar icon in the same style as the other InterSystems tools (the IRIS logo with a database).

## [0.2.0]

- New: **Sign in as Another User...** (right-click a namespace): browse and query that namespace with another user, for example one that sees every table. The row shows `as <user>`; **Use Default Login** goes back.
- New: when the server rejects a password (it changed), you are asked for the current one and the tables / query run again with it, instead of an error.
- New icon: "SQL" in the box instead of the terminal prompt.

## [0.1.0]

- First test build: namespace tree (tables, views, procedures), queries with Ctrl+Enter, results grid with sort / filter / copy / CSV.
