import { useState, useMemo, useCallback, useDeferredValue, useEffect, useRef, memo } from 'react';
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
    content_length?: number;
    body?: string;
    is_binary?: boolean;
    mime_type?: string;
  };
}

type DetailTab = 'Request' | 'Response' | 'Detail';

interface CustomHeaderDef {
  type: 'request' | 'response';
  name: string;
}

interface ColumnDef {
  key: string;
  label: string;
  className: string;
  customHeader?: CustomHeaderDef;
}

/** Default table columns in display order. Any column can be hidden via the Columns menu. */
const DEFAULT_COLUMNS: ColumnDef[] = [
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

/** Oldest flows are dropped beyond this count, bounding memory held by captured bodies. */
const MAX_FLOWS = 5000;

const HIDDEN_COLUMNS_KEY = 'httpceptor.hiddenColumns';
const CUSTOM_HEADER_COLUMNS_KEY = 'httpceptor.customHeaderColumns';

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

function loadHiddenColumns(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_KEY) || '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

function saveHiddenColumns(hidden: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Storage unavailable (private window, blocked site data): columns reset on reload.
  }
}

function loadCustomColumns(): CustomHeaderDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_HEADER_COLUMNS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is CustomHeaderDef =>
      Boolean(
        c &&
        (c.type === 'request' || c.type === 'response') &&
        typeof c.name === 'string' &&
        c.name.trim().length > 0
      )
    );
  } catch {
    return [];
  }
}

function saveCustomColumns(cols: CustomHeaderDef[]): void {
  try {
    localStorage.setItem(CUSTOM_HEADER_COLUMNS_KEY, JSON.stringify(cols));
  } catch {
    // Storage unavailable
  }
}

function getHeaderValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return '';
  if (headers[name] !== undefined) return headers[name];
  const target = name.toLowerCase();
  for (const k in headers) {
    if (k.toLowerCase() === target) {
      return headers[k];
    }
  }
  return '';
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
  onRemoveCustomColumn?: (type: 'request' | 'response', name: string) => void;
}

const FlowTableHead = ({ columns, onRemoveCustomColumn }: FlowTableHeadProps) => (
  <thead>
    <tr>
      {columns.map((col) => (
        <th key={col.key} className={col.className} title={col.label || undefined}>
          <div className="th-inner">
            <span className="th-text">
              {col.customHeader ? (
                <>
                  <span className={`th-arrow ${col.customHeader.type}`}>
                    {col.customHeader.type === 'request' ? '↑' : '↓'}
                  </span>{' '}
                  {col.customHeader.name}
                </>
              ) : (
                col.label
              )}
            </span>
            {col.customHeader && onRemoveCustomColumn && (
              <button
                type="button"
                className="col-remove-btn"
                title={`Remove column '${col.label}'`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveCustomColumn(col.customHeader!.type, col.customHeader!.name);
                }}
              >
                ✕
              </button>
            )}
          </div>
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
  onSelect: (id: string) => void;
}

const renderCell = (col: ColumnDef, flow: NetworkEvent) => {
  if (col.customHeader) {
    const headers =
      col.customHeader.type === 'request' ? flow.request.headers : flow.response.headers;
    const value = getHeaderValue(headers, col.customHeader.name);
    return (
      <td key={col.key} className={col.className} title={value || undefined}>
        {value}
      </td>
    );
  }

  switch (col.key) {
    case 'initiator': {
      const ua =
        Object.entries(flow.request.headers || {}).find(
          ([k]) => k.toLowerCase() === 'user-agent'
        )?.[1] || '';
      const initiatorDisplay = flow.initiator || (ua ? ua.split('/')[0] : '');
      return (
        <td key={col.key} className={col.className} title={flow.initiator || ua}>
          {initiatorDisplay}
        </td>
      );
    }
    case 'tls':
      return (
        <td key={col.key} className={col.className}>
          <span className={`tls-indicator`}>{isHttps(flow.request.url) ? '🔐' : '🔏'}</span>
        </td>
      );
    case 'method':
      return (
        <td key={col.key} className={col.className}>
          {flow.request.method}
        </td>
      );
    case 'status':
      return (
        <td key={col.key} className={`${col.className} ${statusClass(flow.response.status_code)}`}>
          {flow.response.status_code}
        </td>
      );
    case 'icon':
      return (
        <td key={col.key} className={col.className} title={flow.response.mime_type || ''}>
          <ResourceIcon
            type={getResourceIconType(flow.response.status_code, flow.response.mime_type)}
          />
        </td>
      );
    case 'path':
      return (
        <td key={col.key} className={col.className} title={flow.request.url}>
          {flow.request.url}
        </td>
      );
    case 'size':
      return (
        <td key={col.key} className={col.className}>
          {formatSize(flow.response.content_length ?? 0)}
        </td>
      );
    case 'time':
      return (
        <td key={col.key} className={col.className}>
          {formatTime(flow.request.timestamp_start, flow.response.timestamp_end)}
        </td>
      );
    case 'start':
      return (
        <td key={col.key} className={col.className}>
          {formatClock(flow.request.timestamp_start)}
        </td>
      );
    case 'end':
      return (
        <td key={col.key} className={col.className}>
          {formatClock(flow.response.timestamp_end)}
        </td>
      );
    default:
      return <td key={col.key} className={col.className} />;
  }
};

const FlowRow = memo(({ flow, columns, selected, onSelect }: FlowRowProps) => {
  const className = selected ? 'selected' : '';

  return (
    <tr className={className} onClick={() => onSelect(flow.id)}>
      {columns.map((col) => renderCell(col, flow))}
    </tr>
  );
});

/* ================================================================
   ColumnMenu — toolbar dropdown with a checkbox per column
   ================================================================ */
interface ColumnMenuProps {
  columns: ColumnDef[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onRemoveCustomColumn?: (type: 'request' | 'response', name: string) => void;
}

const ColumnMenu = ({ columns, hidden, onToggle, onRemoveCustomColumn }: ColumnMenuProps) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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
          {columns.map((col) => (
            <div key={col.key} className="column-menu-row">
              <label className="column-menu-item">
                <input
                  type="checkbox"
                  checked={!hidden.has(col.key)}
                  onChange={() => onToggle(col.key)}
                />
                <span className="column-menu-label">
                  {col.customHeader ? (
                    <>
                      <span className={`th-arrow ${col.customHeader.type}`}>
                        {col.customHeader.type === 'request' ? '↑' : '↓'}
                      </span>{' '}
                      {col.customHeader.name}
                    </>
                  ) : (
                    col.label || 'Icon'
                  )}
                </span>
              </label>
              {col.customHeader && onRemoveCustomColumn && (
                <button
                  type="button"
                  className="column-menu-remove-btn"
                  title={`Remove ${col.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveCustomColumn(col.customHeader!.type, col.customHeader!.name);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
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
  isHeaderColumnAdded: (type: 'request' | 'response', name: string) => boolean;
  onToggleHeaderColumn: (type: 'request' | 'response', name: string) => void;
}

const FlowDetail = ({
  flow,
  activeTab,
  onTabChange,
  onClose,
  isHeaderColumnAdded,
  onToggleHeaderColumn,
}: FlowDetailProps) => {
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
        {activeTab === 'Request' && (
          <RequestView
            flow={flow}
            isHeaderColumnAdded={isHeaderColumnAdded}
            onToggleHeaderColumn={onToggleHeaderColumn}
          />
        )}
        {activeTab === 'Response' && (
          <ResponseView
            flow={flow}
            isHeaderColumnAdded={isHeaderColumnAdded}
            onToggleHeaderColumn={onToggleHeaderColumn}
          />
        )}
        {activeTab === 'Detail' && <DetailView flow={flow} />}
      </section>
    </div>
  );
};

/* ================================================================
   HeadersSection & BodySection — reusable detail subcomponents
   ================================================================ */
interface HeadersSectionProps {
  title: string;
  type: 'request' | 'response';
  headers?: Record<string, string>;
  isAdded: (type: 'request' | 'response', name: string) => boolean;
  onToggle: (type: 'request' | 'response', name: string) => void;
}

const HeadersSection = ({ title, type, headers = {}, isAdded, onToggle }: HeadersSectionProps) => {
  const entries = Object.entries(headers);
  const arrow = type === 'request' ? '↑' : '↓';

  return (
    <div className="kv-section">
      <h5>{title}</h5>
      {entries.map(([k, v]) => {
        const added = isAdded(type, k);
        return (
          <div className="kv-row" key={k}>
            <button
              type="button"
              className={`header-col-btn ${added ? 'active' : ''}`}
              title={
                added
                  ? `Remove '${arrow} ${k}' from table columns`
                  : `Add '${arrow} ${k}' to table columns`
              }
              onClick={() => onToggle(type, k)}
            >
              ▦
            </button>
            <span className="kv-key">{k}</span>
            <span className="kv-value">{v}</span>
          </div>
        );
      })}
      {entries.length === 0 && (
        <div style={{ color: 'var(--mitm-text-muted)', fontSize: 12, fontStyle: 'italic' }}>
          No headers captured
        </div>
      )}
    </div>
  );
};

interface BodySectionProps {
  title: string;
  body?: string;
}

const BodySection = ({ title, body }: BodySectionProps) => {
  const formatted = useMemo(() => (body ? tryFormatJson(body) : ''), [body]);

  if (!body) {
    return (
      <div
        style={{
          color: 'var(--mitm-text-muted)',
          fontSize: 12,
          fontStyle: 'italic',
          marginTop: 12,
        }}
      >
        No {title.toLowerCase()}
      </div>
    );
  }

  return (
    <div className="contentview">
      <div className="controls">
        <h5>{title}</h5>
        <button
          type="button"
          className="copy-btn"
          onClick={() => navigator.clipboard.writeText(body)}
        >
          Copy
        </button>
      </div>
      <pre>{formatted}</pre>
    </div>
  );
};

/* ================================================================
   RequestView & ResponseView
   ================================================================ */
interface HeaderViewProps {
  flow: NetworkEvent;
  isHeaderColumnAdded: (type: 'request' | 'response', name: string) => boolean;
  onToggleHeaderColumn: (type: 'request' | 'response', name: string) => void;
}

const RequestView = ({ flow, isHeaderColumnAdded, onToggleHeaderColumn }: HeaderViewProps) => (
  <div>
    <div className="first-line">
      {flow.request.method} {flow.request.url}
    </div>
    <HeadersSection
      title="Request Headers"
      type="request"
      headers={flow.request.headers}
      isAdded={isHeaderColumnAdded}
      onToggle={onToggleHeaderColumn}
    />
    {flow.request.body && <BodySection title="Request Body" body={flow.request.body} />}
  </div>
);

const ResponseView = ({ flow, isHeaderColumnAdded, onToggleHeaderColumn }: HeaderViewProps) => (
  <div>
    <div className="first-line">HTTP {flow.response.status_code}</div>
    <HeadersSection
      title="Response Headers"
      type="response"
      headers={flow.response.headers}
      isAdded={isHeaderColumnAdded}
      onToggle={onToggleHeaderColumn}
    />
    <BodySection title="Response Body" body={flow.response.body} />
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
              <td>{formatSize(flow.response.content_length ?? 0)}</td>
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
  const [events, setEvents] = useState<NetworkEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [proxyRunning, setProxyRunning] = useState(false);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const [activeTab, setActiveTab] = useState<DetailTab>('Request');
  const [customColumns, setCustomColumns] = useState<CustomHeaderDef[]>(loadCustomColumns);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(loadHiddenColumns);

  // Sync state to localStorage reactively
  useEffect(() => {
    saveCustomColumns(customColumns);
  }, [customColumns]);

  useEffect(() => {
    saveHiddenColumns(hiddenColumns);
  }, [hiddenColumns]);

  const allColumns: ColumnDef[] = useMemo(() => {
    const pathIdx = DEFAULT_COLUMNS.findIndex((c) => c.key === 'path');
    const customDefs: ColumnDef[] = customColumns.map((c) => {
      const arrow = c.type === 'request' ? '↑' : '↓';
      return {
        key: `custom:${c.type}:${c.name.toLowerCase()}`,
        label: `${arrow} ${c.name}`,
        className: 'col-custom-header',
        customHeader: c,
      };
    });

    return [
      ...DEFAULT_COLUMNS.slice(0, pathIdx + 1),
      ...customDefs,
      ...DEFAULT_COLUMNS.slice(pathIdx + 1),
    ];
  }, [customColumns]);

  const visibleColumns = useMemo(
    () => allColumns.filter((col) => !hiddenColumns.has(col.key)),
    [allColumns, hiddenColumns]
  );

  // O(1) set lookup for header button active states
  const addedHeaderKeys = useMemo(
    () => new Set(customColumns.map((c) => `${c.type}:${c.name.toLowerCase()}`)),
    [customColumns]
  );

  const isHeaderColumnAdded = useCallback(
    (type: 'request' | 'response', name: string) =>
      addedHeaderKeys.has(`${type}:${name.toLowerCase()}`),
    [addedHeaderKeys]
  );

  const toggleHeaderColumn = useCallback((type: 'request' | 'response', name: string) => {
    const target = name.toLowerCase();
    setCustomColumns((prev) => {
      const exists = prev.some((c) => c.type === type && c.name.toLowerCase() === target);
      if (exists) {
        return prev.filter((c) => !(c.type === type && c.name.toLowerCase() === target));
      }
      return [...prev, { type, name }];
    });
    setHiddenColumns((prev) => {
      const key = `custom:${type}:${target}`;
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const removeCustomColumn = useCallback((type: 'request' | 'response', name: string) => {
    const target = name.toLowerCase();
    setCustomColumns((prev) =>
      prev.filter((c) => !(c.type === type && c.name.toLowerCase() === target))
    );
  }, []);

  const toggleColumn = useCallback((key: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSelectFlow = useCallback((id: string) => {
    setSelectedEventId(id);
    setActiveTab('Request');
  }, []);

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventId),
    [events, selectedEventId]
  );

  const filteredEvents = useMemo(() => {
    if (!deferredFilter) return events;
    const filterLower = deferredFilter.toLowerCase();
    return events.filter((ev) => {
      const searchStr =
        `${ev.request.method} ${ev.request.url} ${ev.response.status_code} ${ev.initiator || ''}`.toLowerCase();
      if (searchStr.includes(filterLower)) return true;
      for (const c of customColumns) {
        const headers = c.type === 'request' ? ev.request.headers : ev.response.headers;
        const val = getHeaderValue(headers, c.name).toLowerCase();
        if (val.includes(filterLower)) return true;
      }
      return false;
    });
  }, [events, deferredFilter, customColumns]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.command === 'network-event') {
        setEvents((prev) =>
          prev.length < MAX_FLOWS
            ? [...prev, message.data]
            : [...prev.slice(prev.length - MAX_FLOWS + 1), message.data]
        );
      } else if (message.command === 'proxy-status') {
        setProxyRunning(message.running);
      }
    };

    window.addEventListener('message', handleMessage);
    const vscode = (window as any).acquireVsCodeApi();
    vscode.postMessage({ command: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const clearFlows = useCallback(() => {
    setEvents([]);
    setSelectedEventId(null);
  }, []);

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
        <ColumnMenu
          columns={allColumns}
          hidden={hiddenColumns}
          onToggle={toggleColumn}
          onRemoveCustomColumn={removeCustomColumn}
        />

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
            <FlowTableHead columns={visibleColumns} onRemoveCustomColumn={removeCustomColumn} />
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
                    onSelect={handleSelectFlow}
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
              isHeaderColumnAdded={isHeaderColumnAdded}
              onToggleHeaderColumn={toggleHeaderColumn}
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
