import * as React from 'react';
import * as ReactDOM from 'react-dom/client';

/* ================================================================
   Types
   ================================================================ */
interface NetworkEvent {
  id: string;
  initiator?: string;
  request: {
    pretty_url: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    timestamp_start: number;
    body?: string;
    is_binary?: boolean;
    mime_type?: string;
  };
  response: {
    status_code: number;
    headers: Record<string, string>;
    timestamp_start: number;
    timestamp_end: number;
    body?: string;
    is_binary?: boolean;
    mime_type?: string;
  };
}

type DetailTab = 'Request' | 'Response' | 'Detail';

type ColumnKey =
  | 'initiator'
  | 'tls'
  | 'method'
  | 'status'
  | 'icon'
  | 'path'
  | 'size'
  | 'time'
  | 'start'
  | 'end';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  className: string;
}

/** Table columns in display order. Any column can be hidden via the Columns menu. */
const COLUMNS: ColumnDef[] = [
  { key: 'initiator', label: 'Initiator', className: 'col-initiator' },
  { key: 'tls', label: 'TLS', className: 'col-tls' },
  { key: 'method', label: 'Method', className: 'col-method' },
  { key: 'status', label: 'Status', className: 'col-status' },
  { key: 'icon', label: '', className: 'col-icon' },
  { key: 'path', label: 'Path', className: 'col-path' },
  { key: 'size', label: 'Size', className: 'col-size' },
  { key: 'time', label: 'Time', className: 'col-time' },
  { key: 'start', label: 'Start', className: 'col-start' },
  { key: 'end', label: 'End', className: 'col-end' },
];

const HIDDEN_COLUMNS_KEY = 'httpceptor.hiddenColumns';

/* ================================================================
   Utility functions
   ================================================================ */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}k`;
  return `${(bytes / 1048576).toFixed(1)}M`;
}

function formatTime(startMs: number, endMs: number): string {
  const ms = (endMs - startMs) * 1000;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wall-clock time of a mitmproxy epoch-seconds timestamp, as HH:MM:SS.mmm (local time). */
function formatClock(epochSeconds: number): string {
  const d = new Date(Math.round(epochSeconds * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3
  )}`;
}

function loadHiddenColumns(): Set<ColumnKey> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_KEY) || '[]');
    const known = new Set<string>(COLUMNS.map((c) => c.key));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is ColumnKey => typeof k === 'string' && known.has(k)));
  } catch {
    return new Set();
  }
}

function saveHiddenColumns(hidden: Set<ColumnKey>): void {
  try {
    localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Storage unavailable (private window, blocked site data): columns reset on reload.
  }
}

function tryFormatJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function statusClass(code: number): string {
  if (code >= 100 && code < 200) return 'status-1xx';
  if (code >= 200 && code < 300) return 'status-2xx';
  if (code >= 300 && code < 400) return 'status-3xx';
  if (code >= 400 && code < 500) return 'status-4xx';
  if (code >= 500) return 'status-5xx';
  return 'status-pending';
}

/**
 * Determine resource icon type — follows mitmproxy's getIcon() mapping.
 * Uses status code first (redirects, not-modified), then content-type.
 */
function getResourceIconType(statusCode: number, mimeType?: string): string {
  // Status-based icons (mitmproxy checks these first)
  if (statusCode === 304) return 'not-modified';
  if (statusCode >= 300 && statusCode < 400) return 'redirect';

  if (!mimeType) return 'plain';
  const ct = mimeType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
  if (ct.includes('css')) return 'css';
  if (ct.includes('html')) return 'document';
  if (ct.includes('image')) return 'image';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('font') || ct.includes('woff') || ct.includes('ttf') || ct.includes('otf'))
    return 'font';
  if (ct.includes('video') || ct.includes('audio')) return 'media';
  return 'plain';
}

/** Inline SVG resource icons — Chrome DevTools style, matching mitmproxy */
const ResourceIcon = ({ type }: { type: string }) => {
  const s = 14; // icon size
  const props = { width: s, height: s, viewBox: '0 0 16 16', fill: 'none' };

  switch (type) {
    case 'json':
      return (
        <svg {...props}>
          <path
            d="M4 3C4 2.4 4.5 2 5 2h1.5c.6 0 1 .3 1.2.7L8 4l.3-1.3c.2-.4.6-.7 1.2-.7H11c.5 0 1 .4 1 1v2.5c0 .5-.2 1-.6 1.3L10 8l1.4 1.2c.4.3.6.8.6 1.3V13c0 .6-.5 1-1 1H9.5c-.6 0-1-.3-1.2-.7L8 12l-.3 1.3c-.2.4-.6.7-1.2.7H5c-.5 0-1-.4-1-1v-2.5c0-.5.2-1 .6-1.3L6 8 4.6 6.8C4.2 6.5 4 6 4 5.5V3z"
            stroke="#e8ab53"
            strokeWidth="1"
            fill="none"
          />
        </svg>
      );
    case 'js':
      return (
        <svg {...props}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#e8ab53" strokeWidth="1" />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fontSize="7"
            fontWeight="bold"
            fontFamily="monospace"
            fill="#e8ab53"
          >
            JS
          </text>
        </svg>
      );
    case 'css':
      return (
        <svg {...props}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#6a9fd6" strokeWidth="1" />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fontSize="6"
            fontWeight="bold"
            fontFamily="monospace"
            fill="#6a9fd6"
          >
            CSS
          </text>
        </svg>
      );
    case 'document':
      return (
        <svg {...props}>
          <path
            d="M4 2.5A.5.5 0 014.5 2h5l3 3v8.5a.5.5 0 01-.5.5H4.5a.5.5 0 01-.5-.5v-11z"
            stroke="#6a9fd6"
            strokeWidth="1"
          />
          <path d="M9 2v3.5h3.5" stroke="#6a9fd6" strokeWidth="1" />
          <path d="M6 8h4M6 10h4" stroke="#6a9fd6" strokeWidth="0.8" strokeLinecap="round" />
        </svg>
      );
    case 'image':
      return (
        <svg {...props}>
          <rect x="2" y="3" width="12" height="10" rx="1" stroke="#4caf50" strokeWidth="1" />
          <circle cx="5.5" cy="6.5" r="1.5" fill="#4caf50" fillOpacity="0.6" />
          <path d="M2 11l3-3 2 2 3-4 4 5" stroke="#4caf50" strokeWidth="0.8" fill="none" />
        </svg>
      );
    case 'redirect':
      return (
        <svg {...props}>
          <path
            d="M4 8h8M9 5l3 3-3 3"
            stroke="#ff9800"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'not-modified':
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="5.5" stroke="#999" strokeWidth="1" />
          <path d="M8 5v3h3" stroke="#999" strokeWidth="1" strokeLinecap="round" />
        </svg>
      );
    case 'xml':
      return (
        <svg {...props}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#9c7cba" strokeWidth="1" />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fontSize="5.5"
            fontWeight="bold"
            fontFamily="monospace"
            fill="#9c7cba"
          >
            {'</>'}
          </text>
        </svg>
      );
    case 'pdf':
      return (
        <svg {...props}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#e44" strokeWidth="1" />
          <text
            x="8"
            y="11"
            textAnchor="middle"
            fontSize="5.5"
            fontWeight="bold"
            fontFamily="monospace"
            fill="#e44"
          >
            PDF
          </text>
        </svg>
      );
    case 'font':
      return (
        <svg {...props}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#78909c" strokeWidth="1" />
          <text
            x="8"
            y="11.5"
            textAnchor="middle"
            fontSize="9"
            fontWeight="bold"
            fontFamily="serif"
            fill="#78909c"
          >
            A
          </text>
        </svg>
      );
    case 'media':
      return (
        <svg {...props}>
          <polygon points="5,3 13,8 5,13" fill="none" stroke="#4caf50" strokeWidth="1.2" />
        </svg>
      );
    default: // 'plain'
      return (
        <svg {...props}>
          <path
            d="M4 2.5A.5.5 0 014.5 2h5l3 3v8.5a.5.5 0 01-.5.5H4.5a.5.5 0 01-.5-.5v-11z"
            stroke="#999"
            strokeWidth="1"
          />
          <path d="M9 2v3.5h3.5" stroke="#999" strokeWidth="1" />
        </svg>
      );
  }
};

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function isHttps(url: string): boolean {
  return url.startsWith('https');
}

/* ================================================================
   FlowTableHead — mitmproxy <thead>
   ================================================================ */
interface FlowTableHeadProps {
  columns: ColumnDef[];
}

const FlowTableHead = ({ columns }: FlowTableHeadProps) => (
  <thead>
    <tr>
      {columns.map((col) => (
        <th key={col.key} className={col.className}>
          {col.label}
        </th>
      ))}
    </tr>
  </thead>
);

/* ================================================================
   FlowRow — mitmproxy <tr>
   ================================================================ */
interface FlowRowProps {
  flow: NetworkEvent;
  columns: ColumnDef[];
  selected: boolean;
  onClick: () => void;
}

const renderCell = (key: ColumnKey, flow: NetworkEvent, className: string) => {
  switch (key) {
    case 'initiator': {
      const ua =
        Object.entries(flow.request.headers || {}).find(
          ([k]) => k.toLowerCase() === 'user-agent'
        )?.[1] || '';
      const initiatorDisplay = flow.initiator || (ua ? ua.split('/')[0] : '');
      return (
        <td key={key} className={className} title={flow.initiator || ua}>
          {initiatorDisplay}
        </td>
      );
    }
    case 'tls':
      return (
        <td key={key} className={className}>
          <span className={`tls-indicator`}>{isHttps(flow.request.url) ? '🔐' : '🔏'}</span>
        </td>
      );
    case 'method':
      return (
        <td key={key} className={className}>
          {flow.request.method}
        </td>
      );
    case 'status':
      return (
        <td key={key} className={`${className} ${statusClass(flow.response.status_code)}`}>
          {flow.response.status_code}
        </td>
      );
    case 'icon':
      return (
        <td key={key} className={className} title={flow.response.mime_type || ''}>
          <ResourceIcon
            type={getResourceIconType(flow.response.status_code, flow.response.mime_type)}
          />
        </td>
      );
    case 'path':
      return (
        <td key={key} className={className} title={flow.request.url}>
          {flow.request.url}
        </td>
      );
    case 'size':
      return (
        <td key={key} className={className}>
          {formatSize(flow.response.body?.length || (flow.response as any).content_length || 0)}
        </td>
      );
    case 'time':
      return (
        <td key={key} className={className}>
          {formatTime(flow.request.timestamp_start, flow.response.timestamp_end)}
        </td>
      );
    case 'start':
      return (
        <td key={key} className={className}>
          {formatClock(flow.request.timestamp_start)}
        </td>
      );
    case 'end':
      return (
        <td key={key} className={className}>
          {formatClock(flow.response.timestamp_end)}
        </td>
      );
  }
};

const FlowRow = React.memo(({ flow, columns, selected, onClick }: FlowRowProps) => {
  const className = selected ? 'selected' : '';

  return (
    <tr className={className} onClick={onClick}>
      {columns.map((col) => renderCell(col.key, flow, col.className))}
    </tr>
  );
});

/* ================================================================
   ColumnMenu — toolbar dropdown with a checkbox per column
   ================================================================ */
interface ColumnMenuProps {
  hidden: Set<ColumnKey>;
  onToggle: (key: ColumnKey) => void;
}

const ColumnMenu = ({ hidden, onToggle }: ColumnMenuProps) => {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="column-menu-wrap" ref={wrapRef}>
      <button
        className="toolbar-btn"
        onClick={() => setOpen((o) => !o)}
        title="Show / hide columns"
      >
        ▦
      </button>
      {open && (
        <div className="column-menu">
          {COLUMNS.map((col) => (
            <label key={col.key} className="column-menu-item">
              <input
                type="checkbox"
                checked={!hidden.has(col.key)}
                onChange={() => onToggle(col.key)}
              />
              <span>{col.label || 'Icon'}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

/* ================================================================
   FlowDetail — mitmproxy detail panel (Request / Response / Detail)
   ================================================================ */
interface FlowDetailProps {
  flow: NetworkEvent;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onClose: () => void;
}

const FlowDetail = ({ flow, activeTab, onTabChange, onClose }: FlowDetailProps) => {
  const tabs: DetailTab[] = ['Request', 'Response', 'Detail'];

  return (
    <div className="flow-detail">
      {/* Nav Tabs — mitmproxy Bootstrap-style */}
      <nav className="nav-tabs nav-tabs-lg">
        {tabs.map((tab) => (
          <a
            key={tab}
            className={`tab-item ${activeTab === tab ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              onTabChange(tab);
            }}
          >
            {tab}
          </a>
        ))}
        <div className="tab-spacer" />
        <button className="close-button" onClick={onClose} title="Close">
          ✕
        </button>
      </nav>

      {/* Section content */}
      <section>
        {activeTab === 'Request' && <RequestView flow={flow} />}
        {activeTab === 'Response' && <ResponseView flow={flow} />}
        {activeTab === 'Detail' && <DetailView flow={flow} />}
      </section>
    </div>
  );
};

/* ================================================================
   RequestView — mitmproxy Request tab
   ================================================================ */
const RequestView = ({ flow }: { flow: NetworkEvent }) => (
  <div>
    {/* First line — blue banner like mitmproxy */}
    <div className="first-line">
      {flow.request.method} {flow.request.url}
    </div>

    {/* Request Headers */}
    <div className="kv-section">
      <h5>Request Headers</h5>
      {Object.entries(flow.request.headers).map(([k, v]) => (
        <div className="kv-row" key={k}>
          <span className="kv-key">{k}</span>
          <span className="kv-value">{v}</span>
        </div>
      ))}
      {Object.keys(flow.request.headers).length === 0 && (
        <div style={{ color: 'var(--mitm-text-muted)', fontSize: 12, fontStyle: 'italic' }}>
          No headers captured
        </div>
      )}
    </div>

    {/* Request Body */}
    {flow.request.body && (
      <div className="contentview">
        <div className="controls">
          <h5>Request Body</h5>
          <button
            className="copy-btn"
            onClick={() => navigator.clipboard.writeText(flow.request.body!)}
          >
            Copy
          </button>
        </div>
        <pre>{tryFormatJson(flow.request.body)}</pre>
      </div>
    )}
  </div>
);

/* ================================================================
   ResponseView — mitmproxy Response tab
   ================================================================ */
const ResponseView = ({ flow }: { flow: NetworkEvent }) => (
  <div>
    {/* First line — status */}
    <div className="first-line">HTTP {flow.response.status_code}</div>

    {/* Response Headers */}
    <div className="kv-section">
      <h5>Response Headers</h5>
      {Object.entries(flow.response.headers).map(([k, v]) => (
        <div className="kv-row" key={k}>
          <span className="kv-key">{k}</span>
          <span className="kv-value">{v}</span>
        </div>
      ))}
      {Object.keys(flow.response.headers).length === 0 && (
        <div style={{ color: 'var(--mitm-text-muted)', fontSize: 12, fontStyle: 'italic' }}>
          No headers captured
        </div>
      )}
    </div>

    {/* Response Body */}
    {flow.response.body ? (
      <div className="contentview">
        <div className="controls">
          <h5>Response Body</h5>
          <button
            className="copy-btn"
            onClick={() => navigator.clipboard.writeText(flow.response.body!)}
          >
            Copy
          </button>
        </div>
        <pre>{tryFormatJson(flow.response.body)}</pre>
      </div>
    ) : (
      <div
        style={{
          color: 'var(--mitm-text-muted)',
          fontSize: 12,
          fontStyle: 'italic',
          marginTop: 12,
        }}
      >
        No response body
      </div>
    )}
  </div>
);

/* ================================================================
   DetailView — mitmproxy Detail tab (timing, connection info)
   ================================================================ */
const DetailView = ({ flow }: { flow: NetworkEvent }) => {
  const host = urlHost(flow.request.url);
  const isSecure = isHttps(flow.request.url);
  const latencyMs = (flow.response.timestamp_end - flow.request.timestamp_start) * 1000;

  return (
    <div>
      {flow.initiator && (
        <div className="kv-section">
          <h5>Initiator</h5>
          <table className="detail-table">
            <tbody>
              <tr>
                <td>Extension</td>
                <td>{flow.initiator}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="kv-section">
        <h5>Server Connection</h5>
        <table className="detail-table">
          <tbody>
            <tr>
              <td>Address</td>
              <td>{host}</td>
            </tr>
            <tr>
              <td>Port</td>
              <td>
                {(() => {
                  try {
                    return new URL(flow.request.url).port || (isSecure ? '443' : '80');
                  } catch {
                    return isSecure ? '443' : '80';
                  }
                })()}
              </td>
            </tr>
            <tr>
              <td>TLS</td>
              <td>{isSecure ? 'Yes' : 'No'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="kv-section">
        <h5>Timing</h5>
        <table className="detail-table">
          <tbody>
            <tr>
              <td>Started</td>
              <td>{new Date(flow.request.timestamp_start * 1000).toLocaleString()}</td>
            </tr>
            <tr>
              <td>Completed</td>
              <td>{new Date(flow.response.timestamp_end * 1000).toLocaleString()}</td>
            </tr>
            <tr>
              <td>Duration</td>
              <td>{latencyMs.toFixed(2)} ms</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="kv-section">
        <h5>Content</h5>
        <table className="detail-table">
          <tbody>
            <tr>
              <td>Request Content-Type</td>
              <td>{flow.request.mime_type || '—'}</td>
            </tr>
            <tr>
              <td>Response Content-Type</td>
              <td>{flow.response.mime_type || '—'}</td>
            </tr>
            <tr>
              <td>Response Size</td>
              <td>
                {formatSize(
                  flow.response.body?.length || (flow.response as any).content_length || 0
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ================================================================
   App — main container
   ================================================================ */
const App = () => {
  const [events, setEvents] = React.useState<NetworkEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(null);
  const [proxyRunning, setProxyRunning] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  const [activeTab, setActiveTab] = React.useState<DetailTab>('Request');
  const [hiddenColumns, setHiddenColumns] = React.useState<Set<ColumnKey>>(loadHiddenColumns);

  const visibleColumns = React.useMemo(
    () => COLUMNS.filter((col) => !hiddenColumns.has(col.key)),
    [hiddenColumns]
  );

  const toggleColumn = (key: ColumnKey) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveHiddenColumns(next);
      return next;
    });
  };

  const selectedEvent = events.find((e) => e.id === selectedEventId);

  const filteredEvents = events.filter((ev) => {
    if (!filter) return true;
    const searchStr =
      `${ev.request.method} ${ev.request.url} ${ev.response.status_code} ${ev.initiator || ''}`.toLowerCase();
    return searchStr.includes(filter.toLowerCase());
  });

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.command === 'network-event') {
        setEvents((prev) => [...prev, message.data]);
      } else if (message.command === 'proxy-status') {
        setProxyRunning(message.running);
      }
    };

    window.addEventListener('message', handleMessage);
    const vscode = (window as any).acquireVsCodeApi();
    vscode.postMessage({ command: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const clearFlows = () => {
    setEvents([]);
    setSelectedEventId(null);
  };

  return (
    <div className="mitm-container">
      {/* ——— Header / Toolbar ——— */}
      <header className="mitm-header">
        {/* Brand */}
        <div className="brand">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 4 A8 8 0 1 0 12 20"
              stroke="#00d4ff"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M12 20 A8 8 0 0 0 16 18"
              stroke="#00d4ff"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <circle cx="12" cy="12" r="4" fill="none" stroke="#f5a623" strokeWidth="1" />
            <circle cx="12" cy="12" r="2" fill="#ff4d00" />
          </svg>
          <span>HTTP-ceptor</span>
          <span className={`status-dot ${proxyRunning ? 'running' : 'idle'}`} />
        </div>

        <div className="separator" />

        {/* Clear button */}
        <button className="toolbar-btn" onClick={clearFlows} title="Clear flows">
          🗑
        </button>

        <div className="separator" />

        {/* Column visibility */}
        <ColumnMenu hidden={hiddenColumns} onToggle={toggleColumn} />

        <div className="separator" />

        {/* Filter */}
        <div className="filter-wrap">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="filter-input"
            placeholder="type to filter flows (e.g., ~m post)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {/* Flow count */}
        <span className="flow-count">
          {filteredEvents.length}/{events.length} flows
        </span>
      </header>

      {/* ——— Main View ——— */}
      <div className="mitm-main-view">
        {/* Flow Table */}
        <div className="flow-table">
          <table>
            <FlowTableHead columns={visibleColumns} />
            <tbody>
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length}>
                    <div className="flow-table-empty">
                      <div className="empty-icon">⇅</div>
                      <div>
                        {events.length === 0
                          ? proxyRunning
                            ? 'Waiting for flows…'
                            : 'Proxy is not running.'
                          : 'No matching flows.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredEvents.map((ev) => (
                  <FlowRow
                    key={ev.id}
                    flow={ev}
                    columns={visibleColumns}
                    selected={selectedEventId === ev.id}
                    onClick={() => {
                      setSelectedEventId(ev.id);
                      setActiveTab('Request');
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Splitter + Detail Panel */}
        {selectedEvent && (
          <>
            <div className="mitm-splitter" />
            <FlowDetail
              flow={selectedEvent}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onClose={() => setSelectedEventId(null)}
            />
          </>
        )}
      </div>
    </div>
  );
};

/* ================================================================
   Mount
   ================================================================ */
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<App />);
