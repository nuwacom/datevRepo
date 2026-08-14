export const metadata = {
  title: "DATEV MCP Server",
  description: "MCP server exposing DATEV accounting APIs for nuwacom agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
