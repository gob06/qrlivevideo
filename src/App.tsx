export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 px-6 py-12 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="space-y-3 border-b border-slate-800 pb-6">
          <p className="text-sm font-semibold text-blue-400">PHP 8.1+ · PDO (SQLite / MariaDB) · WebRTC P2P · OBS 1920x1080</p>
          <h1 className="text-3xl font-bold tracking-tight">QR Live Wall</h1>
          <p className="text-slate-300">
            Complete production-ready PHP + Vanilla ES Module codebase generated in this workspace. Run locally with{' '}
            <code className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-blue-300">
              php install.php &amp;&amp; php -S localhost:8000 -t public router.php
            </code>{' '}
            or deploy to z.com shared hosting via README.md.
          </p>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <h2 className="font-semibold text-white">Audience Mobile</h2>
            <p className="text-sm text-slate-400">
              <code>/join/&#123;event-slug&#125;</code> — portrait camera preview, 3s thumbnails, wake lock, in-app WebView hint, mic/flip, auto-reconnect.
            </p>
          </div>
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <h2 className="font-semibold text-white">OBS Wall Output</h2>
            <p className="text-sm text-slate-400">
              <code>/wall/&#123;event-slug&#125;?key=WALLKEY</code> — 1920x1080 transparent source, branded QR, single/split2/grid4/pip layouts, corner QR, blackout.
            </p>
          </div>
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <h2 className="font-semibold text-white">Admin &amp; Monitor</h2>
            <p className="text-sm text-slate-400">
              <code>/admin</code> — RBAC accounts, shared Image Bank, QR scan-safety Test Scan, live Monitor with Private Preview &amp; Audio Listen.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
