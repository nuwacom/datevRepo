const chip: React.CSSProperties = {
  background: "#f4f6f8",
  padding: "2px 6px",
  borderRadius: 4,
};

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "80px auto",
        padding: "0 24px",
        lineHeight: 1.6,
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        color: "#11151c",
      }}
    >
      <h1>DATEV MCP Server</h1>
      <p style={{ color: "#64748b" }}>
        An MCP server exposing DATEV accounting APIs (clients &amp; document upload) for nuwacom
        agents.
      </p>
      <p>
        MCP endpoint: <code style={chip}>/api/mcp</code>
        <br />
        Health check: <code style={chip}>/healthz</code>
        <br />
        Connect DATEV (one-time browser step): <code style={chip}>/api/datev/connect</code>
      </p>
      <p style={{ color: "#64748b", fontSize: 14 }}>
        This page is intentionally minimal; there is no UI.
      </p>
    </main>
  );
}
