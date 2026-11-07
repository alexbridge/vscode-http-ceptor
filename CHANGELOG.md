# Changelog

## [1.2.0]

### Added

- Dynamic header columns: click `▦` next to any request or response header in the detail view to add it as a table column labeled `↑ <header>` or `↓ <header>`; remove via `✕` in the table header or Columns menu (`▦`); choice persists in `localStorage`; values match in the flow filter.
- Readme: update install instructions and root-ca installation

## [1.1.0]

### Added

- Table: `Start` and `End` columns show request start and response end as `HH:MM:SS.mmm`.
- Columns menu (`▦` toolbar button): show or hide any table column; choice persists across reloads.

### Changed

- Proxy listens on `127.0.0.1` only, not all interfaces.
